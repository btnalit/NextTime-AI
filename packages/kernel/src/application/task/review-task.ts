import { type CapabilityScope, REVIEWER_OUTPUT_SCHEMA } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { TaskUpstreamFilesInput } from '../../adapters/supervisor-client/index.js';
import { readEffectiveAgentProfile } from '../../governance/agent-profile/index.js';
import { resolveOntologyDir } from '../../substrate/ontology/index.js';
import { hasActiveSealHold } from '../eval-seal/index.js';
import { readExecuteAccess } from '../gates/execute-access.js';
import {
  composeSystemPrompt,
  readInstanceInstructions,
} from '../platform/instance-instructions.js';
import { resolveActiveRuntimeImage } from '../platform/runtime.js';
import type { WorkerDefinitionRow } from '../worker/index.js';
import { readDefinitionContent } from './definition-content.js';
import {
  PLANNER_HANDLE_CAPABILITIES,
  type PlannerTemplate,
  ensureKernelWorkerDefinition,
  findKernelWorkerFamily,
  loadKernelWorkerTemplate,
} from './planning-task.js';
import { assertTaskQuotas, lockTaskQuotas } from './quota-check.js';
import {
  type PreparedStepAttempt,
  STEP_ATTEMPT_PAUSED_DETAIL,
  type StepAttemptRefusal,
  requesterStartAuthority,
} from './step-attempt.js';
import { recordTaskTransition } from './transition-log.js';
import { QuotaExceededError, TASK_ROW_COLUMNS, mapTaskRow } from './types.js';

/**
 * application/task/review-task (S11 GO18; plan §4.6, I-G5; migrations/task/0014, goal/0019;
 * s11-w4/go18-default-plan.md): the goal reviewer's Task — what a `review` acceptance check of a
 * verifying GoalRun runs (`application/goal/review.ts`). Made like the goal planner's
 * (`planning-task.ts`), in two halves: {@link createReviewTask} inside the advance that reaches the
 * check (the Task, and the check's one attempt, commit together), then `startStepAttemptTask`
 * after that commit (a failed start fails the Task `spawn_failed`, which leaves the check
 * `unavailable`).
 *
 * What it runs with:
 *   - the workspace's reviewer WorkerDefinition ({@link ensureReviewerDefinition}): the kernel's
 *     template (`ontology/goal-reviewer.yaml`), proposed and published for the workspace's goal
 *     reviewer Principal ({@link GOAL_REVIEWER_PRINCIPAL_DISPLAY_NAME}) — never a person's draft,
 *     never offered to `find_workers`, never a step's Worker;
 *   - for the goal's requester (`on_behalf_of`), whom the review stands in for: their I18 quotas
 *     apply (the concurrency quota only delays it), and the model is the one the check asks for,
 *     else the requester's effective model; the goal's token budget caps its own (`tokenCap`), so
 *     its tokens count against the goal (I-G6);
 *   - a closed Handle: exactly {@link REVIEWER_HANDLE_CAPABILITIES} (its own Task, its empty tool
 *     list, its report), no gate resource — it cannot observe, act or start a Worker; its
 *     observation scope is empty and its container has no egress (`spawn.ts`);
 *   - the reviewed steps' handoff directories, read-only at `/upstream/<step>` (`upstream`, the
 *     GO14 mount — the supervisor checks each one belongs to this goal run, as for a step);
 *   - its output contract, `REVIEWER_OUTPUT_SCHEMA`, which `report_task_result` holds it to, then
 *     to the check's criteria (`application/goal/review.ts` `reviewerReportProblems`);
 *   - one try: a crashed run is not retried (`lifecycle.ts`: a Task with a purpose never is).
 */

/** The workspace's goal reviewer Principal — what proposes and publishes the reviewer definition.
 *  Internal (`__…__`): off the Members page, and no service Handle is issued for it. */
export const GOAL_REVIEWER_PRINCIPAL_DISPLAY_NAME = '__goal_reviewer__';

/** A reviewer Worker's Handle — the planner's three: its own Task, its (empty) tool list, its
 *  report. */
export const REVIEWER_HANDLE_CAPABILITIES: readonly string[] = PLANNER_HANDLE_CAPABILITIES;

/** The reviewer Task's token budget at most — less when the workspace default or what is left of
 *  the goal's is less. */
export const REVIEWER_MAX_TOKEN_BUDGET = 100_000;
/** Below this many tokens a reviewer is not started: too little to read what it reviews. */
export const REVIEWER_MIN_TOKEN_BUDGET = 10_000;
/** How long a reviewer Task may run, at most — less when the workspace default or what is left of
 *  the goal's wall clock is less. */
export const REVIEWER_MAX_DURATION_SEC = 600;

/** `ontology/goal-reviewer.yaml` under `ontologyDir` (default `resolveOntologyDir()`). */
export function loadReviewerTemplate(
  ontologyDir: string = resolveOntologyDir(),
): Promise<PlannerTemplate> {
  return loadKernelWorkerTemplate('goal-reviewer.yaml', ontologyDir);
}

/** The reviewer WorkerDefinition a review runs — `ensureKernelWorkerDefinition` for the goal
 *  reviewer Principal (`null`: an owner deprecated the family; no review runs until one is
 *  published again). */
export async function ensureReviewerDefinition(
  client: PoolClient,
  workspaceId: string,
  template: PlannerTemplate,
): Promise<WorkerDefinitionRow | null> {
  return ensureKernelWorkerDefinition(
    client,
    workspaceId,
    GOAL_REVIEWER_PRINCIPAL_DISPLAY_NAME,
    template,
  );
}

/** The goal reviewer's WorkerDefinition family in the workspace, or `null` when it has none yet.
 *  Read only. */
export async function findGoalReviewerFamily(
  client: PoolClient,
  workspaceId: string,
): Promise<string | null> {
  return findKernelWorkerFamily(client, workspaceId, GOAL_REVIEWER_PRINCIPAL_DISPLAY_NAME);
}

/** The models the requester's workspace lets a Worker run on (AgentPolicy `allowedModels`; `[]`:
 *  any) — a review's `model` is held to it when the plan is checked and again when it starts. */
export async function requesterAllowedModels(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
): Promise<readonly string[]> {
  return (await readExecuteAccess(client, workspaceId, requesterId)).policy.allowedModels;
}

export interface CreateReviewTaskInput {
  readonly definition: WorkerDefinitionRow;
  readonly requesterId: string;
  readonly goalRunId: string;
  /** The revision the check was declared in — its round's. */
  readonly planRevision: number;
  readonly round: number;
  readonly checkKey: string;
  readonly input: unknown;
  /** What is left of the goal's tokens for it. */
  readonly tokenCap: number;
  /** What is left of the goal's wall clock, in seconds — the reviewer runs no longer than that,
   *  as a step's attempt does (`createStepAttemptTask`'s `durationCapSec`; review #493 on #1123). */
  readonly durationCapSec: number;
  /** The model the check asks for (`undefined`: the definition's, else the requester's). */
  readonly model?: string;
  /** The reviewed steps' handoff directories it mounts read-only. */
  readonly upstream: readonly TaskUpstreamFilesInput[];
}

/** Why a reviewer was not started: the requester cannot start Workers now (`authority_lost`,
 *  `paused`, `quota` — the concurrency quota only delays it), or the goal leaves it too few tokens
 *  (`quota`, `goal_budget_exhausted`). */
export type CreateReviewTaskResult =
  | { readonly kind: 'created'; readonly prepared: PreparedStepAttempt }
  | { readonly kind: 'refused'; readonly refusal: StepAttemptRefusal };

/** Half 1, inside the advance's transaction — see the module comment. Writes nothing when it
 *  refuses. */
export async function createReviewTask(
  client: PoolClient,
  workspaceId: string,
  input: CreateReviewTaskInput,
): Promise<CreateReviewTaskResult> {
  const refused = (refusal: StepAttemptRefusal): CreateReviewTaskResult => ({
    kind: 'refused',
    refusal,
  });
  if (await hasActiveSealHold(client, workspaceId, input.requesterId)) {
    return refused({ kind: 'paused', detail: STEP_ATTEMPT_PAUSED_DETAIL });
  }
  const authority = await requesterStartAuthority(client, workspaceId, input.requesterId);
  if ('refusal' in authority) return refused(authority.refusal);

  const { definition } = input;
  const content = readDefinitionContent(definition.definition);
  const model =
    input.model ??
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
    ...[REVIEWER_MAX_TOKEN_BUDGET, input.tokenCap, quotas.defaultTokenBudget].filter(
      (cap): cap is number => cap !== null,
    ),
  );
  if (tokenBudget < REVIEWER_MIN_TOKEN_BUDGET) {
    return refused({
      kind: 'quota',
      code: 'goal_budget_exhausted',
      detail: `a reviewer gets ${tokenBudget} tokens here (the goal's headroom and the workspace's default Task budget), less than the ${REVIEWER_MIN_TOKEN_BUDGET} it needs`,
    });
  }
  const durationLimitSec = Math.max(
    1,
    Math.min(
      REVIEWER_MAX_DURATION_SEC,
      quotas.defaultDurationLimitSec,
      Math.floor(input.durationCapSec),
    ),
  );

  const inserted = await client.query(
    `insert into tasks (
       workspace_id, status, on_behalf_of, created_by_activity_id, worker_definition_id,
       worker_definition_version, input, token_budget, duration_limit_sec, goal_run_id,
       plan_revision, review_round, review_check_key, output_schema, observe_scope, purpose
     ) values ($1, 'queued', $2, null, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb,
       '{}'::uuid[], 'review')
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
      input.round,
      input.checkKey,
      JSON.stringify(REVIEWER_OUTPUT_SCHEMA),
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('createReviewTask: tasks INSERT ... RETURNING produced no row');
  const task = mapTaskRow(row);
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId: input.requesterId,
    action: 'task.queue',
    taskId: task.id,
    resultingStatus: 'queued',
    extraAuditPayload: {
      purpose: 'review',
      goalRunId: input.goalRunId,
      round: input.round,
      checkKey: input.checkKey,
      planRevision: input.planRevision,
      ...(input.upstream.length > 0
        ? { upstreamFiles: input.upstream.map((entry) => entry.stepKey) }
        : {}),
    },
  });

  const handleScope: CapabilityScope = {
    capabilities: [...REVIEWER_HANDLE_CAPABILITIES],
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
        // Legacy 702: issued only while the requester's role is still the one read above.
        issuanceBasis: { kind: 'role', role: authority.role },
        declaredCapabilities: REVIEWER_HANDLE_CAPABILITIES,
        declaredGates: [],
        model,
        systemPrompt,
        definitionName,
        skillsInline: [],
        loadedSkills: [],
        egressDeny: content.egressDeny,
        image,
        // GO14: the supervisor mounts the reviewed steps' handoff directories only for a Task of
        // the same goal run, after checking them again.
        goalRunId: input.goalRunId,
        ...(input.upstream.length > 0
          ? {
              upstream: input.upstream.map((entry) => ({
                stepKey: entry.stepKey,
                taskId: entry.taskId,
              })),
            }
          : {}),
      },
    },
  };
}

/** The review check `taskId` runs for, with its GoalRun — `null` for any other Task. */
export async function readTaskReview(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
): Promise<{
  readonly goalRunId: string;
  readonly round: number;
  readonly checkKey: string;
} | null> {
  const result = await client.query<{
    goal_run_id: string | null;
    review_round: number | null;
    review_check_key: string | null;
  }>(
    'select goal_run_id, review_round, review_check_key from tasks where workspace_id = $1 and id = $2',
    [workspaceId, taskId],
  );
  const row = result.rows[0];
  if (!row?.goal_run_id || row.review_round === null || row.review_check_key === null) return null;
  return { goalRunId: row.goal_run_id, round: row.review_round, checkKey: row.review_check_key };
}
