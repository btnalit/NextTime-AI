import { createHash } from 'node:crypto';
import type { CapabilityScope } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withWorkspace } from '../../adapters/db/pool.js';
import {
  readAgentProfile,
  readEffectiveAgentProfile,
} from '../../governance/agent-profile/index.js';
import { WORKER_CEILING_CAPABILITIES, entryScope } from '../../governance/capability/index.js';
import { entryGatekeeperIds, readExecuteAccess } from '../gates/execute-access.js';
import {
  composeSystemPrompt,
  readInstanceInstructions,
} from '../platform/instance-instructions.js';
import { resolveActiveRuntimeImage } from '../platform/runtime.js';
import { getWorkerDefinition } from '../worker/index.js';
import {
  type ResolvedRunSkills,
  readDefinitionContent,
  resolvePinnedSkillsInline,
  resolveSkillsInline,
} from './definition-content.js';
import type { RunConfigSnapshot } from './goal-step.js';
import { computeChildHandleScope, defaultWorkerCapabilities } from './handle-mint.js';
import { failTaskAndReapWorkerRuns } from './lifecycle.js';
import { assertTaskQuotas, lockTaskQuotas } from './quota-check.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { type SpawnWorkerRunInput, spawnWorkerRun } from './spawn.js';
import { recordTaskTransition } from './transition-log.js';
import {
  InvokeWorkerAttenuationError,
  InvokeWorkerValidationError,
  QuotaExceededError,
  type QuotaViolationCode,
  TASK_ROW_COLUMNS,
  type TaskRow,
  mapTaskRow,
} from './types.js';

/**
 * application/task/step-attempt (S11 GO2; plan §4.4, I-G1, I-G7): the goal advancer's way to start
 * one attempt of a step — the same Task the `invoke_worker` path creates (`invoke.ts`), created in
 * two halves around the advancer's transaction:
 *
 *   1. {@link createStepAttemptTask} runs inside the transaction that moves the StepRun
 *      `ready → running` (I-G1: the attempt's Task and its StepRun transition commit together, or
 *      neither does). It resolves what the attempt runs with, checks the requester's authority and
 *      I18 quotas under the same per-principal lock as `invoke_worker`, and inserts the Task
 *      `queued` with its goal step, attempt number and configuration snapshot. It writes nothing
 *      when it refuses.
 *   2. {@link startStepAttemptTask} runs after that commit: it spawns the WorkerRun and moves the
 *      Task to `running`, exactly as `invokeWorkerCreate`'s tail does (the Worker's Handle must be
 *      committed before the container uses it — see `invoke.ts`'s module doc comment). A kernel
 *      that dies between the two leaves a `queued` Task, which the reaper fails `spawn_lost`; the
 *      advancer then sees a transient failure and starts the next attempt.
 *
 * Authority (I-G7): the parent of the attempt's Handle is the requester's entry scope **now** —
 * `entryScope` over `entryGatekeeperIds(readExecuteAccess(...))`, what their entry agent would be
 * minted with this minute — never a scope captured at confirmation. A step's Handle carries no
 * `invoke_worker` / `find_workers` unless its plan entry says `nested` (§4.4: teams are the
 * advancer's). Unlike `invoke_worker`, which leaves out an observe-only gate the caller does not
 * hold, an attempt whose WorkerDefinition declares a gate the requester can no longer act on does
 * not start: the plan the requester confirmed needs it, so the goal pauses `authority_lost` for a
 * person (scenario S9) instead of running a narrower Worker than the one planned.
 *
 * Pinned configuration (§4.4 "新尝试读快照"): the first attempt resolves the WorkerDefinition version
 * the plan names, the Skills it uses (latest published, as `invoke_worker` does), the model (the
 * definition's, else the requester's effective one) and the platform runtime image; a later attempt
 * reuses those from the previous attempt's snapshot. A version that is no longer published — the
 * definition or any Skill — refuses the attempt (`unavailable`). The platform's instance
 * instructions are read fresh for every attempt (platform policy, not the step's configuration);
 * the snapshot keeps the composed prompt's digest so a reviewer can tell attempts apart.
 *
 * The attempt's Task budget is the workspace default capped by what is left of the goal's
 * (`tokenCap`, `durationCapSec`), so one attempt cannot spend far past the GoalRun's I-G6 budget.
 */

export type StepAttemptRefusal =
  /** The requester cannot start this step now: disabled, no longer allowed to start Workers, or
   *  missing a gate or an execute-class capability the step's WorkerDefinition declares (I-G7). */
  | { readonly kind: 'authority_lost'; readonly detail: string }
  /** What the step is pinned to cannot run: the WorkerDefinition or a Skill version is no longer
   *  published, or the requester's own AgentProfile excludes the definition. A person decides. */
  | { readonly kind: 'unavailable'; readonly detail: string }
  /** An I18 quota: `concurrency_exceeded` clears by itself, `daily_cost_exceeded` with the day. */
  | { readonly kind: 'quota'; readonly code: QuotaViolationCode; readonly detail: string };

export interface CreateStepAttemptInput {
  readonly goalRunId: string;
  readonly stepRunId: string;
  readonly planRevision: number;
  /** The attempt number this Task carries — the StepRun's `attempt_count` after this start. */
  readonly stepAttempt: number;
  readonly worker: { readonly definitionId: string; readonly version: number };
  readonly input: unknown;
  readonly nested: boolean;
  /** The previous attempt's snapshot; `null` for the first attempt. */
  readonly previous: RunConfigSnapshot | null;
  /** What is left of the goal's token budget — `null` when nothing caps it. */
  readonly tokenCap: number | null;
  /** What is left of the goal's wall-clock budget, in seconds. */
  readonly durationCapSec: number;
}

/** Everything {@link startStepAttemptTask} needs after the creating transaction commits. */
export interface PreparedStepAttempt {
  readonly task: TaskRow;
  readonly spawn: Omit<SpawnWorkerRunInput, 'task'>;
}

export type CreateStepAttemptResult =
  | { readonly kind: 'created'; readonly attempt: PreparedStepAttempt }
  | { readonly kind: 'refused'; readonly refusal: StepAttemptRefusal };

/** Capabilities a step's Handle carries only when its plan entry declares `nested`. */
const DERIVATION_CAPABILITIES: ReadonlySet<string> = new Set(['invoke_worker', 'find_workers']);

/** Whether the requester, their platform user or their workspace is disabled — the predicate
 *  `application/gateway/handle-auth.ts` applies to every Handle acting for them (a missing row is
 *  disabled). A Worker minted for a disabled requester could not authenticate anyway. */
async function requesterDisabled(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const result = await client.query<{ disabled: boolean }>(
    `select (p.disabled_at is not null
             or coalesce(u.status = 'disabled', false)
             or w.status = 'disabled') as disabled
       from principals p
       join workspaces w on w.id = p.workspace_id
       left join users u on u.id = p.user_id
      where p.workspace_id = $1 and p.id = $2`,
    [workspaceId, principalId],
  );
  return result.rows[0]?.disabled ?? true;
}

/** The parent scope of a step's Handle — see the module doc comment (I-G7). */
async function stepParentScope(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  nested: boolean,
): Promise<{ readonly scope: CapabilityScope } | { readonly refusal: StepAttemptRefusal }> {
  if (await requesterDisabled(client, workspaceId, requesterId)) {
    return { refusal: { kind: 'authority_lost', detail: 'the requester is disabled' } };
  }
  const access = await readExecuteAccess(client, workspaceId, requesterId);
  if (access.role === undefined) {
    return { refusal: { kind: 'authority_lost', detail: 'the requester no longer exists' } };
  }
  const gatekeeperIds = entryGatekeeperIds(access);
  const entry = entryScope(
    gatekeeperIds.length > 0 ? { resources: { gatekeeper: [...gatekeeperIds] } } : {},
    { role: access.role },
  );
  if (!entry.capabilities.includes('invoke_worker')) {
    return {
      refusal: {
        kind: 'authority_lost',
        detail: `the requester's role (${access.role}) no longer starts Workers`,
      },
    };
  }
  return {
    scope: {
      capabilities: nested
        ? entry.capabilities
        : entry.capabilities.filter((name) => !DERIVATION_CAPABILITIES.has(name)),
      resources: entry.resources,
    },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Half 1 — see the module doc comment. Runs in the caller's transaction (`client`, bound to the
 * requester's workspace). Returns `refused` without writing anything; throws only on a database
 * error (the caller's transaction then rolls back whole).
 */
export async function createStepAttemptTask(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  input: CreateStepAttemptInput,
): Promise<CreateStepAttemptResult> {
  const refused = (refusal: StepAttemptRefusal): CreateStepAttemptResult => ({
    kind: 'refused',
    refusal,
  });

  const ref = input.previous
    ? { definitionId: input.previous.definition.id, version: input.previous.definition.version }
    : input.worker;
  const definition = await getWorkerDefinition(client, workspaceId, ref);
  const refText = `${ref.definitionId}@${ref.version}`;
  if (!definition || definition.kind !== 'worker' || definition.status !== 'published') {
    return refused({
      kind: 'unavailable',
      detail: definition
        ? `WorkerDefinition ${refText} is ${definition.status === 'published' ? `${definition.kind}-kind` : definition.status}`
        : `WorkerDefinition ${refText} does not exist`,
    });
  }

  const agentProfile = await readAgentProfile(client, workspaceId, requesterId);
  if (agentProfile?.excludedWorkerDefinitions.includes(ref.definitionId)) {
    return refused({
      kind: 'unavailable',
      detail: `the requester's AgentProfile excludes WorkerDefinition ${ref.definitionId}`,
    });
  }

  const content = readDefinitionContent(definition.definition);
  const declaredCapabilities =
    content.capabilities ?? defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES);
  const declaredGates = content.gates ?? [];

  const parent = await stepParentScope(client, workspaceId, requesterId, input.nested);
  if ('refusal' in parent) return refused(parent.refusal);
  const heldGates = new Set(parent.scope.resources.gatekeeper ?? []);
  const missingGates = declaredGates.filter((gate) => !heldGates.has(gate));
  if (missingGates.length > 0) {
    return refused({
      kind: 'authority_lost',
      detail: `the requester can no longer act on gatekeeper(s) ${missingGates.join(', ')}`,
    });
  }
  let childScope: CapabilityScope;
  try {
    childScope = computeChildHandleScope({
      parentAuthority: parent.scope,
      declaredCapabilities,
      declaredGates,
    });
  } catch (err) {
    if (err instanceof InvokeWorkerAttenuationError || err instanceof InvokeWorkerValidationError) {
      return refused({ kind: 'authority_lost', detail: err.message });
    }
    throw err;
  }

  let skills: ResolvedRunSkills;
  if (input.previous) {
    const pinned = await resolvePinnedSkillsInline(client, workspaceId, input.previous.skills);
    if (pinned.kind === 'unavailable') {
      return refused({
        kind: 'unavailable',
        detail: `Skill version(s) no longer published: ${pinned.refs
          .map((skill) => `${skill.skillId}@${skill.version}`)
          .join(', ')}`,
      });
    }
    skills = pinned.skills;
  } else {
    skills = await resolveSkillsInline(client, workspaceId, content.skills ?? []);
  }

  const model = input.previous
    ? (input.previous.model ?? undefined)
    : (content.model ??
      ((await readEffectiveAgentProfile(client, workspaceId, requesterId)).model || undefined));
  const image = input.previous
    ? (input.previous.image ?? undefined)
    : await resolveActiveRuntimeImage(client);
  const systemPrompt = composeSystemPrompt({
    base: content.systemPrompt,
    instanceInstructions: await readInstanceInstructions(client),
  });

  await lockTaskQuotas(client, workspaceId, requesterId);
  let quotas: Awaited<ReturnType<typeof assertTaskQuotas>>;
  try {
    quotas = await assertTaskQuotas(client, workspaceId, requesterId, ref.definitionId, 1);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return refused({ kind: 'quota', code: err.code, detail: err.message });
    }
    throw err;
  }

  const tokenBudget =
    quotas.defaultTokenBudget === null
      ? input.tokenCap
      : input.tokenCap === null
        ? quotas.defaultTokenBudget
        : Math.min(quotas.defaultTokenBudget, input.tokenCap);
  const durationLimitSec = Math.max(
    1,
    Math.min(quotas.defaultDurationLimitSec, Math.floor(input.durationCapSec)),
  );

  const snapshot: RunConfigSnapshot = {
    v: 1,
    definition: { id: definition.id, version: definition.version },
    skills: skills.loadedSkills.map((skill) => ({
      skillId: skill.skillId,
      version: skill.version,
    })),
    model: model ?? null,
    image: image ?? null,
    systemPromptDigest: systemPrompt === undefined ? null : sha256(systemPrompt),
    handle: {
      capabilities: [...childScope.capabilities],
      gatekeepers: [...(childScope.resources.gatekeeper ?? [])],
    },
    budget: { tokenBudget, durationLimitSec },
  };

  const inserted = await client.query(
    `insert into tasks (
       workspace_id, status, on_behalf_of, created_by_activity_id, worker_definition_id,
       worker_definition_version, input, token_budget, duration_limit_sec,
       goal_run_id, step_run_id, plan_revision, step_attempt, run_config_snapshot
     ) values ($1, 'queued', $2, null, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb)
     returning ${TASK_ROW_COLUMNS}`,
    [
      workspaceId,
      requesterId,
      definition.id,
      definition.version,
      JSON.stringify(input.input ?? null),
      tokenBudget,
      durationLimitSec,
      input.goalRunId,
      input.stepRunId,
      input.planRevision,
      input.stepAttempt,
      JSON.stringify(snapshot),
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('createStepAttemptTask: tasks INSERT ... RETURNING produced no row');
  const task = mapTaskRow(row);
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId: requesterId,
    action: 'task.queue',
    taskId: task.id,
    resultingStatus: 'queued',
    extraAuditPayload: {
      goalRunId: input.goalRunId,
      stepRunId: input.stepRunId,
      stepAttempt: input.stepAttempt,
    },
  });

  const definitionName =
    typeof definition.definition.name === 'string' ? definition.definition.name : definition.id;
  return {
    kind: 'created',
    attempt: {
      task,
      spawn: {
        parentWorkerRunId: null,
        depth: 1,
        attempt: 1,
        onBehalfOf: requesterId,
        parentAuthority: parent.scope,
        parentClaimsForLineage: undefined,
        declaredCapabilities,
        declaredGates,
        model,
        systemPrompt,
        definitionName,
        skillsInline: skills.skillsInline,
        loadedSkills: skills.loadedSkills,
        egressDeny: content.egressDeny,
        image,
      },
    },
  };
}

/**
 * Half 2 — after the creating transaction committed. Spawns the WorkerRun and moves the Task
 * `queued → running`; a spawn failure fails the Task `spawn_failed` and reaps what the spawn left
 * (the same path as `invokeWorkerCreate`). Never throws for a spawn failure: the Task's
 * `TaskUpdated` wakes the advancer, which treats it as a transient failure of the attempt. Returns
 * whether the Task is now running.
 */
export async function startStepAttemptTask(
  deps: TaskRuntimeDeps,
  workspaceId: string,
  attempt: PreparedStepAttempt,
): Promise<boolean> {
  const { task, spawn } = attempt;
  try {
    await spawnWorkerRun(deps, workspaceId, { ...spawn, task });
  } catch {
    await failTaskAndReapWorkerRuns(deps, workspaceId, spawn.onBehalfOf, task.id, 'spawn_failed');
    return false;
  }
  return withWorkspace(
    deps.pool,
    { workspaceId, principalId: spawn.onBehalfOf },
    async (client) => {
      // Status-guarded, as in `invokeWorkerCreate`: a cancel that landed meanwhile keeps its status,
      // and the reaper's duration scan ends the orphaned run.
      const updated = await client.query(
        "update tasks set status = 'running' where workspace_id = $1 and id = $2 and status = 'queued'",
        [workspaceId, task.id],
      );
      if ((updated.rowCount ?? 0) === 0) return false;
      await recordTaskTransition(client, workspaceId, {
        actorPrincipalId: spawn.onBehalfOf,
        action: 'task.start',
        taskId: task.id,
        resultingStatus: 'running',
      });
      return true;
    },
  );
}
