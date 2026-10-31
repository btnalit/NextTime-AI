import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '@nexttime/gatekeeper-base';
import { type CapabilityScope, PLANNER_OUTPUT_SCHEMA } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { readEffectiveAgentProfile } from '../../governance/agent-profile/index.js';
import { resolveOntologyDir } from '../../substrate/ontology/index.js';
import { hasActiveSealHold } from '../eval-seal/index.js';
import {
  composeSystemPrompt,
  readInstanceInstructions,
} from '../platform/instance-instructions.js';
import { resolveActiveRuntimeImage } from '../platform/runtime.js';
import {
  type WorkerDefinitionRow,
  getWorkerDefinition,
  loadWorkerDefinitionTemplate,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from '../worker/index.js';
import { readDefinitionContent } from './definition-content.js';
import { assertTaskQuotas, lockTaskQuotas } from './quota-check.js';
import {
  type PreparedStepAttempt,
  STEP_ATTEMPT_PAUSED_DETAIL,
  type StepAttemptRefusal,
  requesterStartRefusal,
} from './step-attempt.js';
import { recordTaskTransition } from './transition-log.js';
import { QuotaExceededError, TASK_ROW_COLUMNS, mapTaskRow } from './types.js';

/**
 * application/task/planning-task (S11 GO9a; plan §4.1, §4.3, I-P1; migrations/task/0012,
 * goal/0014): the goal planner's Task — what a planning round of a GoalRun runs
 * (`application/goal/planner.ts`). Created like a step's attempt, in two halves: {@link
 * createPlanningTask} inside the advance that opens the round (the Task and its round commit
 * together), then `startStepAttemptTask` after that commit (spawn, `running`; a failed start fails
 * the Task `spawn_failed`, which settles the round `failed`).
 *
 * What it runs with:
 *   - the workspace's planner WorkerDefinition ({@link ensurePlannerDefinition}): the kernel's
 *     template (`ontology/goal-planner.yaml`), proposed and published for the workspace's goal
 *     planner Principal — never a person's draft, and never offered to `find_workers`;
 *   - for the goal's requester (`on_behalf_of`): it proposes in their name, and their I18 quotas
 *     (concurrency, daily cost) and their effective model apply as to their own Workers; the
 *     goal's token budget caps its own (`tokenCap`), so its tokens count against the goal (I-G6);
 *   - a closed Handle: exactly {@link PLANNER_HANDLE_CAPABILITIES}, no gate resource, whatever the
 *     definition declares — it cannot observe, request an action or start a Worker (I-P1); its
 *     observation scope is empty and its container has no egress (`spawn.ts`);
 *   - its output contract, `PLANNER_OUTPUT_SCHEMA`, which `report_task_result` holds it to, then to
 *     the plan checks (`application/goal/planner.ts` `plannerReportProblems`);
 *   - one try: a crashed run is not retried (`lifecycle.ts`: a Task with a purpose never is).
 */

/** A planner Worker's Handle — its own Task, its (empty) tool list, its report. */
export const PLANNER_HANDLE_CAPABILITIES: readonly string[] = [
  'get_task',
  'list_allowed_operations',
  'report_task_result',
];

/** The workspace's goal planner Principal — what proposes and publishes the planner definition and
 *  proposes the planner's revisions (goal/0014 `goal_planner_principal`). Internal (`__…__`): off
 *  the Members page, and no service Handle is issued for it. */
export const GOAL_PLANNER_PRINCIPAL_DISPLAY_NAME = '__goal_planner__';

/** The planner Task's token budget at most — less when the workspace default or what is left of
 *  the goal's is less. */
export const PLANNER_MAX_TOKEN_BUDGET = 200_000;
/** Below this many tokens a planner is not started: too little to read a plan and write one. */
export const PLANNER_MIN_TOKEN_BUDGET = 20_000;
/** How long a planner Task may run, at most. */
export const PLANNER_MAX_DURATION_SEC = 600;

/** The planner Principal's id, or `null` when the workspace never needed one. */
export async function findGoalPlannerPrincipal(
  client: PoolClient,
  workspaceId: string,
): Promise<string | null> {
  const found = await client.query<{ id: string }>(
    "select id from principals where workspace_id = $1 and kind = 'service' and display_name = $2 order by created_at limit 1",
    [workspaceId, GOAL_PLANNER_PRINCIPAL_DISPLAY_NAME],
  );
  return found.rows[0]?.id ?? null;
}

/** The planner Principal's id, created the first time a workspace's goal needs a planner; two
 *  first rounds at once create one (serialized per workspace). */
export async function getOrCreateGoalPlannerPrincipal(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const existing = await findGoalPlannerPrincipal(client, workspaceId);
  if (existing) return existing;
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `goal-planner-principal:${workspaceId}`,
  ]);
  const raced = await findGoalPlannerPrincipal(client, workspaceId);
  if (raced) return raced;
  const inserted = await client.query<{ id: string }>(
    `insert into principals (workspace_id, kind, role, display_name)
     values ($1, 'service', 'member', $2)
     returning id`,
    [workspaceId, GOAL_PLANNER_PRINCIPAL_DISPLAY_NAME],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('getOrCreateGoalPlannerPrincipal: INSERT ... RETURNING produced no row');
  return id;
}

/** The planner template as this kernel ships it, with the digest a published version is compared
 *  by (the whole content's canonical JSON). */
export interface PlannerTemplate {
  readonly definition: Record<string, unknown>;
  readonly digest: string;
}

export function plannerContentDigest(definition: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(definition), 'utf8').digest('hex')}`;
}

const templates = new Map<string, Promise<PlannerTemplate>>();

/** `ontology/goal-planner.yaml` under `ontologyDir` (default `resolveOntologyDir()`), read once per
 *  directory. A template that is not a `worker` one is a deployment problem and throws. */
export function loadPlannerTemplate(
  ontologyDir: string = resolveOntologyDir(),
): Promise<PlannerTemplate> {
  let loaded = templates.get(ontologyDir);
  if (!loaded) {
    loaded = loadWorkerDefinitionTemplate(path.join(ontologyDir, 'goal-planner.yaml')).then(
      (template) => {
        if (template.kind !== 'worker') {
          throw new Error(
            `goal-planner.yaml: a planner is a worker definition, not ${template.kind}`,
          );
        }
        return {
          definition: template.definition,
          digest: plannerContentDigest(template.definition),
        };
      },
    );
    loaded.catch(() => templates.delete(ontologyDir));
    templates.set(ontologyDir, loaded);
  }
  return loaded;
}

/**
 * The planner WorkerDefinition a round runs: the latest published version of the family the
 * planner Principal first proposed. The first time, the kernel proposes and publishes the template
 * for it; when the latest published version is the planner's own and differs from the template, the
 * next version (this kernel's template) is proposed and published. A version a workspace owner
 * published in the family is run as it is. `null` when the family has no published version — an
 * owner deprecated it: no planner runs until one is published again.
 */
export async function ensurePlannerDefinition(
  client: PoolClient,
  workspaceId: string,
  template: PlannerTemplate,
): Promise<WorkerDefinitionRow | null> {
  const plannerId = await getOrCreateGoalPlannerPrincipal(client, workspaceId);
  const family = await client.query<{ id: string }>(
    `select id from worker_definitions
      where workspace_id = $1 and proposed_by = $2 and kind = 'worker'
      order by created_at, version
      limit 1`,
    [workspaceId, plannerId],
  );
  const familyId = family.rows[0]?.id;
  const publish = async (definitionId: string | undefined): Promise<WorkerDefinitionRow> => {
    const proposed = await proposeWorkerDefinition(client, workspaceId, plannerId, {
      ...(definitionId !== undefined ? { definitionId } : {}),
      kind: 'worker',
      definition: template.definition,
    });
    return publishWorkerDefinition(client, workspaceId, plannerId, {
      definitionId: proposed.id,
      version: proposed.version,
    });
  };
  if (familyId === undefined) return publish(undefined);
  const latest = await client.query<{ version: number; proposed_by: string }>(
    `select version, proposed_by from worker_definitions
      where workspace_id = $1 and id = $2 and status = 'published'
      order by version desc
      limit 1`,
    [workspaceId, familyId],
  );
  const head = latest.rows[0];
  if (!head) return null;
  const row = await getWorkerDefinition(client, workspaceId, {
    definitionId: familyId,
    version: head.version,
  });
  if (!row) return null;
  if (head.proposed_by === plannerId && plannerContentDigest(row.definition) !== template.digest) {
    return publish(familyId);
  }
  return row;
}

export interface CreatePlanningTaskInput {
  readonly definition: WorkerDefinitionRow;
  readonly requesterId: string;
  readonly goalRunId: string;
  /** The revision the planner revises — the round's base. */
  readonly planRevision: number;
  readonly planningRoundId: string;
  readonly input: unknown;
  /** What is left of the goal's tokens for it. */
  readonly tokenCap: number;
  /** What is left of the goal's wall clock, in seconds. */
  readonly durationCapSec: number;
}

/** Why a planner was not started: the requester cannot start Workers now (a refusal of the step
 *  attempt's kinds: `authority_lost`, `paused`, `quota`). */
export type CreatePlanningTaskResult =
  | { readonly kind: 'created'; readonly prepared: PreparedStepAttempt }
  | { readonly kind: 'refused'; readonly refusal: StepAttemptRefusal };

/** Half 1, inside the advance's transaction — see the module comment. Writes nothing when it
 *  refuses. */
export async function createPlanningTask(
  client: PoolClient,
  workspaceId: string,
  input: CreatePlanningTaskInput,
): Promise<CreatePlanningTaskResult> {
  const refused = (refusal: StepAttemptRefusal): CreatePlanningTaskResult => ({
    kind: 'refused',
    refusal,
  });
  if (await hasActiveSealHold(client, workspaceId, input.requesterId)) {
    return refused({ kind: 'paused', detail: STEP_ATTEMPT_PAUSED_DETAIL });
  }
  const cannot = await requesterStartRefusal(client, workspaceId, input.requesterId);
  if (cannot) return refused(cannot);

  const { definition } = input;
  const content = readDefinitionContent(definition.definition);
  const model =
    content.model ??
    ((await readEffectiveAgentProfile(client, workspaceId, input.requesterId)).model || undefined);
  const image = await resolveActiveRuntimeImage(client);
  const systemPrompt = composeSystemPrompt({
    base: content.systemPrompt,
    instanceInstructions: await readInstanceInstructions(client),
  });

  await lockTaskQuotas(client, workspaceId, input.requesterId);
  let quotas: Awaited<ReturnType<typeof assertTaskQuotas>>;
  try {
    quotas = await assertTaskQuotas(client, workspaceId, input.requesterId, definition.id, 1);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return refused({ kind: 'quota', code: err.code, detail: err.message });
    }
    throw err;
  }
  const tokenBudget = Math.min(
    ...[PLANNER_MAX_TOKEN_BUDGET, input.tokenCap, quotas.defaultTokenBudget].filter(
      (cap): cap is number => cap !== null,
    ),
  );
  // The workspace's default budget may be lower than what the goal leaves: too little for a
  // planner either way.
  if (tokenBudget < PLANNER_MIN_TOKEN_BUDGET) {
    return refused({
      kind: 'quota',
      code: 'goal_budget_exhausted',
      detail: `a planner gets ${tokenBudget} tokens here (the goal's headroom and the workspace's default Task budget), less than the ${PLANNER_MIN_TOKEN_BUDGET} it needs`,
    });
  }
  const durationLimitSec = Math.max(
    1,
    Math.min(
      PLANNER_MAX_DURATION_SEC,
      quotas.defaultDurationLimitSec,
      Math.floor(input.durationCapSec),
    ),
  );

  const inserted = await client.query(
    `insert into tasks (
       workspace_id, status, on_behalf_of, created_by_activity_id, worker_definition_id,
       worker_definition_version, input, token_budget, duration_limit_sec, goal_run_id,
       plan_revision, planning_round_id, output_schema, observe_scope, purpose
     ) values ($1, 'queued', $2, null, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb,
       '{}'::uuid[], 'planning')
     returning ${TASK_ROW_COLUMNS}`,
    [
      workspaceId,
      input.requesterId,
      definition.id,
      definition.version,
      JSON.stringify(input.input ?? null),
      tokenBudget,
      durationLimitSec,
      input.goalRunId,
      input.planRevision,
      input.planningRoundId,
      JSON.stringify(PLANNER_OUTPUT_SCHEMA),
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('createPlanningTask: tasks INSERT ... RETURNING produced no row');
  const task = mapTaskRow(row);
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId: input.requesterId,
    action: 'task.queue',
    taskId: task.id,
    resultingStatus: 'queued',
    extraAuditPayload: {
      purpose: 'planning',
      goalRunId: input.goalRunId,
      planningRoundId: input.planningRoundId,
      planRevision: input.planRevision,
    },
  });

  const handleScope: CapabilityScope = {
    capabilities: [...PLANNER_HANDLE_CAPABILITIES],
    resources: {},
  };
  const definitionName =
    typeof definition.definition.name === 'string' ? definition.definition.name : definition.id;
  return {
    kind: 'created',
    prepared: {
      task,
      spawn: {
        parentWorkerRunId: null,
        depth: 1,
        attempt: 1,
        onBehalfOf: input.requesterId,
        parentAuthority: handleScope,
        parentClaimsForLineage: undefined,
        declaredCapabilities: PLANNER_HANDLE_CAPABILITIES,
        declaredGates: [],
        model,
        systemPrompt,
        definitionName,
        skillsInline: [],
        loadedSkills: [],
        egressDeny: content.egressDeny,
        image,
      },
    },
  };
}

/** The planning round `taskId` runs for, with its GoalRun — `null` for any other Task. */
export async function readTaskPlanningRound(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
): Promise<{ readonly goalRunId: string; readonly planningRoundId: string } | null> {
  const result = await client.query<{
    goal_run_id: string | null;
    planning_round_id: string | null;
  }>('select goal_run_id, planning_round_id from tasks where workspace_id = $1 and id = $2', [
    workspaceId,
    taskId,
  ]);
  const row = result.rows[0];
  if (!row?.goal_run_id || !row.planning_round_id) return null;
  return { goalRunId: row.goal_run_id, planningRoundId: row.planning_round_id };
}
