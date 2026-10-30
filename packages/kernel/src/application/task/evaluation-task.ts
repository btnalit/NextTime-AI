import type { CapabilityScope } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { readEffectiveAgentProfile } from '../../governance/agent-profile/index.js';
import {
  composeSystemPrompt,
  readInstanceInstructions,
} from '../platform/instance-instructions.js';
import { resolveActiveRuntimeImage } from '../platform/runtime.js';
import { getWorkerDefinition } from '../worker/index.js';
import {
  type ResolvedRunSkills,
  readDefinitionContent,
  resolveSkillsInline,
} from './definition-content.js';
import { normalizeObserveScope } from './observe-scope.js';
import { assertTaskQuotas, lockTaskQuotas } from './quota-check.js';
import type { PreparedStepAttempt } from './step-attempt.js';
import { recordTaskTransition } from './transition-log.js';
import { TASK_ROW_COLUMNS, mapTaskRow } from './types.js';

/**
 * application/task/evaluation-task (S10 E3-2a; docs/s10-evolution-plan-2026-10-04.md §3.3 I-E1,
 * §5.5 封闭): the Task an evaluation trial runs — `purpose = 'evaluation'` (migrations/task/0011),
 * created by `application/eval`'s trial runner in two halves like a goal step's attempt
 * (`step-attempt.ts`): {@link createEvaluationTask} inside the runner's transaction (the Task and
 * its trial commit together), then `startStepAttemptTask` after that commit (spawn, `running`; a
 * failed start fails the Task `spawn_failed`).
 *
 * What it runs with:
 *   - the suite's pinned WorkerDefinition version, which must still be published (a draft
 *     evaluation's later trials: or deprecated since); its Skills (the latest published, as
 *     `invoke_worker` resolves them — a draft evaluation's arm passes its own), its model (else the
 *     workspace default),
 *     its system prompt with the platform's instance instructions, the platform runtime image;
 *   - for the workspace's evaluation service Principal, never a person — so it runs under that
 *     Principal's I18 quotas (its own concurrency count) and no person's;
 *   - a closed Handle: exactly {@link EVALUATION_HANDLE_CAPABILITIES}, no gate resources, whatever
 *     the definition declares (the gateway closes the session again: application/eval-session);
 *   - an observation scope of the suite's fixture gates (the shape 0011 requires);
 *   - one attempt: a crashed run is not retried (`lifecycle.ts`), so a trial is one try.
 * The container's egress is denied (`spawn.ts` sets `egressDenyAll` for every evaluation Task).
 */

/** An evaluation Worker's Handle — its own Task, its tools, its gate calls, its report. */
export const EVALUATION_HANDLE_CAPABILITIES: readonly string[] = [
  'get_task',
  'list_allowed_operations',
  'observe_operation',
  'request_action',
  'report_task_result',
];

export interface CreateEvaluationTaskInput {
  /** The workspace's evaluation service Principal (`application/eval`). */
  readonly evaluationPrincipalId: string;
  readonly definition: { readonly id: string; readonly version: number };
  /** The case's input. */
  readonly input: unknown;
  /** The suite's fixture gates. */
  readonly fixtureGateIds: readonly string[];
  /** S10 E3-2b: the Skills to mount instead of the definition's own — a draft evaluation's arm (the
   *  pinned other Skills with the baseline version, or with the draft). A draft goes in
   *  `skillsInline` only: `loadedSkills` names published rows (`worker_run_skills` keys them), and a
   *  draft is deleted when discarded. */
  readonly skills?: ResolvedRunSkills;
  /** S10 E3-2b: a pinned version deprecated since is still run — a draft evaluation pinned it when
   *  it started, and its later trials run what its first did. */
  readonly acceptDeprecated?: boolean;
}

export type CreateEvaluationTaskResult =
  | { readonly kind: 'created'; readonly prepared: PreparedStepAttempt }
  /** The pinned version is no longer published (nor, with `acceptDeprecated`, deprecated). */
  | { readonly kind: 'definition_unavailable' };

/** Half 1, inside the caller's transaction. Throws `QuotaExceededError` (429) when the evaluation
 *  Principal is at its concurrency limit; writes nothing when it refuses. */
export async function createEvaluationTask(
  client: PoolClient,
  workspaceId: string,
  input: CreateEvaluationTaskInput,
): Promise<CreateEvaluationTaskResult> {
  const definition = await getWorkerDefinition(client, workspaceId, {
    definitionId: input.definition.id,
    version: input.definition.version,
  });
  const runnable =
    definition?.status === 'published' ||
    (input.acceptDeprecated === true && definition?.status === 'deprecated');
  if (!definition || !runnable || definition.kind !== 'worker') {
    return { kind: 'definition_unavailable' };
  }
  const content = readDefinitionContent(definition.definition);
  const skills =
    input.skills ?? (await resolveSkillsInline(client, workspaceId, content.skills ?? []));
  const model =
    content.model ??
    ((await readEffectiveAgentProfile(client, workspaceId, input.evaluationPrincipalId)).model ||
      undefined);
  const image = await resolveActiveRuntimeImage(client);
  const systemPrompt = composeSystemPrompt({
    base: content.systemPrompt,
    instanceInstructions: await readInstanceInstructions(client),
  });

  await lockTaskQuotas(client, workspaceId, input.evaluationPrincipalId);
  const quotas = await assertTaskQuotas(
    client,
    workspaceId,
    input.evaluationPrincipalId,
    definition.id,
    1,
  );

  const inserted = await client.query(
    `insert into tasks (
       workspace_id, status, on_behalf_of, created_by_activity_id, worker_definition_id,
       worker_definition_version, input, token_budget, duration_limit_sec, observe_scope, purpose
     ) values ($1, 'queued', $2, null, $3, $4, $5::jsonb, $6, $7, $8::uuid[], 'evaluation')
     returning ${TASK_ROW_COLUMNS}`,
    [
      workspaceId,
      input.evaluationPrincipalId,
      definition.id,
      definition.version,
      JSON.stringify(input.input ?? null),
      quotas.defaultTokenBudget,
      quotas.defaultDurationLimitSec,
      normalizeObserveScope(input.fixtureGateIds),
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('createEvaluationTask: tasks INSERT ... RETURNING produced no row');
  const task = mapTaskRow(row);
  await recordTaskTransition(client, workspaceId, {
    actorPrincipalId: input.evaluationPrincipalId,
    action: 'task.queue',
    taskId: task.id,
    resultingStatus: 'queued',
    extraAuditPayload: { purpose: 'evaluation' },
  });

  const handleScope: CapabilityScope = {
    capabilities: [...EVALUATION_HANDLE_CAPABILITIES],
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
        onBehalfOf: input.evaluationPrincipalId,
        parentAuthority: handleScope,
        parentClaimsForLineage: undefined,
        declaredCapabilities: EVALUATION_HANDLE_CAPABILITIES,
        declaredGates: [],
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
