import type { PoolClient } from 'pg';
import {
  endActivity,
  recordSourceObservation,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { getOrCreateWorkerRunSource } from './worker-run-source.js';

/**
 * application/task/gate-observation: leftover 75's second half (docs/STATUS.md §4 row 75, "门操作
 * 结果不作为 Observation 入图") — a Worker's gate tool calls (`request_action`, both the observe
 * branch and an execute branch that finished) are recorded as Observations of this WorkerRun's own
 * epistemic Source (`worker-run-source.ts`), even when the model's `factsToAssert` stays empty. This
 * is deliberately *not* Fact-writing: a gate's raw result has no declared `result_mapping` telling
 * this module how to turn arbitrary JSON into typed Objects/Links (that's what `writeObservedFacts`
 * already does for a gate that *does* declare one) — recording it as a bounded/truncated Observation
 * is the honest scope: a durable, `explain`-reachable provenance trail of "this Worker actually
 * called this Operation and got this back", not a claim that any graph Fact's freshness clock
 * advances because of it.
 *
 * **Never on the caller's own Activity.** `request-action-handler.ts`'s `runObserve` may already
 * have called `writeObservedFacts` on its own `activity.id`, recording an Observation from the
 * *Gatekeeper's* own Source there — `resolveFactOrigin` (`substrate/epistemic/conflicts.ts`) treats
 * an Activity as having a single origin only when exactly one distinct Source fed it; adding a
 * second Observation (from this WorkerRun's Source) to that same Activity would silently make every
 * Fact `writeObservedFacts` wrote on it fall back to "asserted-by-principal" origin instead of the
 * Gatekeeper's own Source. This module therefore always opens its own `worker_gate_call` Activity,
 * fully decoupled from whatever Activity the actual gate call ran under.
 *
 * **Best-effort, bounded.** Callers await this (same transaction/short admin transaction as the
 * gate call itself), but a failure here must never surface as the Worker's own tool error — see each
 * call site's own comment. `GATE_OBSERVATION_PAYLOAD_MAX_CHARS` bounds one payload;
 * `MAX_GATE_OBSERVATIONS_PER_WORKER_RUN` bounds how many of these rows one WorkerRun can ever write
 * (a Worker looping the same gate call must not grow the graph without bound) — past the cap, this
 * silently stops recording rather than throwing or blocking the Worker's own tool result.
 */

const GATE_OBSERVATION_ACTIVITY_KIND = 'worker_gate_call';
const GATE_OBSERVATION_PAYLOAD_MAX_CHARS = 8_000;
export const MAX_GATE_OBSERVATIONS_PER_WORKER_RUN = 200;

export interface RecordWorkerGateObservationInput {
  readonly taskId: string;
  readonly workerRunId: string;
  /** The WorkerRun's own (workspace, WorkerDefinition) agent principal — becomes this Observation's
   *  Activity's `started_by`, same convention `postWorkerResult`'s `worker_result` Activity uses. */
  readonly agentPrincipalId: string;
  /** The Task's on_behalf_of human — the WorkerRun Source's owner (matches `postWorkerResult`'s own
   *  `runSource` ownership). */
  readonly ownerPrincipalId: string;
  readonly gatekeeperId: string;
  readonly gateName: string;
  readonly operation: string;
  readonly mode: 'observe' | 'execute';
  /** A short outcome tag (`'ok'`, `'executed'`, `'failed'`, …) — never the full ActionRequest
   *  lifecycle vocabulary, just enough for a reader of this Observation's `content` to tell what
   *  kind of result `payload` holds. */
  readonly status: string;
  readonly payload: unknown;
}

function truncatePayload(payload: unknown): {
  readonly value: unknown;
  readonly truncated: boolean;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload ?? null) ?? 'null';
  } catch {
    return { value: String(payload), truncated: false };
  }
  if (serialized.length <= GATE_OBSERVATION_PAYLOAD_MAX_CHARS) {
    return { value: payload ?? null, truncated: false };
  }
  const omitted = serialized.length - GATE_OBSERVATION_PAYLOAD_MAX_CHARS;
  return {
    value: `${serialized.slice(0, GATE_OBSERVATION_PAYLOAD_MAX_CHARS)}… [${omitted} more characters omitted]`,
    truncated: true,
  };
}

async function countExistingGateObservations(
  client: PoolClient,
  workspaceId: string,
  workerRunId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count from activities
      where workspace_id = $1 and kind = $2 and metadata ->> 'workerRunId' = $3`,
    [workspaceId, GATE_OBSERVATION_ACTIVITY_KIND, workerRunId],
  );
  return Number.parseInt(result.rows[0]?.count ?? '0', 10);
}

export async function recordWorkerGateObservation(
  client: PoolClient,
  workspaceId: string,
  input: RecordWorkerGateObservationInput,
): Promise<void> {
  const existingCount = await countExistingGateObservations(client, workspaceId, input.workerRunId);
  if (existingCount >= MAX_GATE_OBSERVATIONS_PER_WORKER_RUN) return;

  const sourceId = await getOrCreateWorkerRunSource(client, workspaceId, {
    workerRunId: input.workerRunId,
    taskId: input.taskId,
    ownerPrincipalId: input.ownerPrincipalId,
  });

  const { value: payload, truncated } = truncatePayload(input.payload);
  const activity = await startActivity(client, workspaceId, {
    kind: GATE_OBSERVATION_ACTIVITY_KIND,
    principalId: input.agentPrincipalId,
    metadata: {
      taskId: input.taskId,
      workerRunId: input.workerRunId,
      gatekeeperId: input.gatekeeperId,
      gateName: input.gateName,
      operation: input.operation,
      mode: input.mode,
      status: input.status,
    },
  });
  await recordSourceObservation(client, workspaceId, {
    sourceId,
    activityId: activity.id,
    content: {
      gatekeeperId: input.gatekeeperId,
      gateName: input.gateName,
      operation: input.operation,
      mode: input.mode,
      status: input.status,
      payload,
      truncated,
    },
  });
  await endActivity(client, workspaceId, activity.id, 'completed');
}
