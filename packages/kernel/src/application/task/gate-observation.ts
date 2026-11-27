import { sliceKeepingPairs } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  namesASecretField,
  redactSecretFieldsInJsonText,
  redactSuspectedSecrets,
  redactSuspectedSecretsUpTo,
  scrubOutsideSpans,
  scrubSecretValues,
} from '../../governance/redaction/index.js';
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
 *
 * **Never the raw result (legacy 237).** `payload` is kept as the call-argument rule's copy
 * (`redactSuspectedSecrets` with `secretFields`: every value under a field named after a secret, at
 * any depth, and every secret-looking value, shape kept) — the rule the platform's own goal
 * observations keep their evidence by (`application/goal/platform-observation.ts`). An execute
 * branch's result arrives here already in that form (read back from its audit row,
 * `readTerminalOutcome`) and the rule replaces nothing twice; an observe branch's result arrives as
 * the gate sent it and would otherwise be written as is, and go into every dump of the table.
 *
 * **Only what is kept is read.** A gate's result is as large as the gate sent it (legacy 808) and
 * the redactor runs on the kernel's event loop, so `keptGatePayload` redacts only the start of it
 * (`redactSuspectedSecretsUpTo`: `GATE_OBSERVATION_READ_CHARS` characters of keys and values, the
 * rest left out unread however many keys or items it has) and cuts that to
 * `GATE_OBSERVATION_PAYLOAD_MAX_CHARS` once serialized — the read reaches past the cut by a margin
 * longer than any secret replaced whole, so a secret the cut crosses was read whole and replaced
 * (as application/chat/tool-call-record.ts reads a tool call's result). Replacements shorten the
 * copy, so after more than a margin's worth of them the copy can end where reading stopped, inside
 * the one string or key reading stopped in; that one is cut by `scrubbedCut` (legacy 819), so it
 * never ends in the start of a secret, and `truncated` is set though the copy is shorter than the
 * cut.
 *
 * **Marked as kept (legacy 817).** `content.payloadRedacted: true` says the payload is that copy.
 * Legacy 237 and the marker reach a release together, so on a deployment a row without it was
 * written before legacy 237, with the result as the gate sent it; `gatePayloadKeptRaw` tells the
 * scrub which of those to count.
 */

export const GATE_OBSERVATION_ACTIVITY_KIND = 'worker_gate_call';
const GATE_OBSERVATION_PAYLOAD_MAX_CHARS = 8_000;
/** Characters of a result read (keys and values): what is kept plus a margin longer than any secret
 *  replaced whole (a PEM RSA-4096 private key is ~3.3k characters) — the margin
 *  application/chat/tool-call-record.ts's `SECRET_MARGIN_CHARS` reads a tool call's result by. */
const GATE_OBSERVATION_READ_CHARS = GATE_OBSERVATION_PAYLOAD_MAX_CHARS + 4_096;
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
  /** The gate's result as the caller got it; kept redacted (module doc). */
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
  // Never through a surrogate pair: half of one is no text `jsonb` stores (legacy 834).
  const kept = sliceKeepingPairs(serialized, GATE_OBSERVATION_PAYLOAD_MAX_CHARS);
  const omitted = serialized.length - kept.length;
  return {
    value: `${kept}… [${omitted} more characters omitted]`,
    truncated: true,
  };
}

/** What an Observation keeps of a gate's result: the call-argument rule's copy of its start, cut
 *  to `GATE_OBSERVATION_PAYLOAD_MAX_CHARS` once serialized (module doc). `truncated`: anything was
 *  cut or left out. */
export function keptGatePayload(payload: unknown): {
  readonly value: unknown;
  readonly truncated: boolean;
} {
  const redacted = redactSuspectedSecretsUpTo(payload ?? null, GATE_OBSERVATION_READ_CHARS, {
    secretFields: true,
  });
  const kept = truncatePayload(redacted.value);
  return { value: kept.value, truncated: kept.truncated || redacted.omitted };
}

/**
 * Whether a stored Observation's `content` keeps something of the gate's result that the rule it
 * is now kept by would hide. `cli/scrub-raw-secrets.ts` counts these (`gateCallObservations`,
 * legacy 817). A row marked `payloadRedacted` holds that rule's copy and is never counted. Any
 * other row was written before legacy 237: a payload kept whole is judged by the rule itself
 * (`redactSuspectedSecrets` with `secretFields`); one stored cut, as text (`truncated`: the
 * serialized result cut at `GATE_OBSERVATION_PAYLOAD_MAX_CHARS`), by the same field rule over its
 * JSON text — its escaped strings scrubbed decoded too (legacy 916) — and then the value patterns
 * over all of it — as a stored tool call's result is
 * (application/chat/tool-call-record.ts `rescrubStoredToolCallResult`). Over text the patterns
 * also read the JSON's punctuation (`"credentials":{` reads as a value given to `credentials`), so
 * a cut row can be counted that the rule would leave as it is: an upper bound, which is why a row
 * written now carries the marker rather than being judged again. Copies are compared, not counts:
 * the field rule replaces a `[redacted]` under a secret-named field again and counts it.
 */
export function gatePayloadKeptRaw(content: Record<string, unknown>): boolean {
  if (content.payloadRedacted === true) return false;
  const payload = content.payload ?? null;
  if (content.truncated === true && typeof payload === 'string') {
    const fields = redactSecretFieldsInJsonText(payload, namesASecretField, scrubSecretValues);
    return (
      scrubOutsideSpans(fields.value, fields.decodedSpans, scrubSecretValues).value !== payload
    );
  }
  const redacted = redactSuspectedSecrets(payload, { secretFields: true });
  return JSON.stringify(redacted.value) !== JSON.stringify(payload);
}

/** The Observation's `content`: the call, and what is kept of its result (`keptGatePayload`),
 *  marked as that copy (`payloadRedacted`, module doc). */
export function gateObservationContent(
  input: Pick<
    RecordWorkerGateObservationInput,
    'gatekeeperId' | 'gateName' | 'operation' | 'mode' | 'status' | 'payload'
  >,
): Record<string, unknown> {
  const { value: payload, truncated } = keptGatePayload(input.payload);
  return {
    gatekeeperId: input.gatekeeperId,
    gateName: input.gateName,
    operation: input.operation,
    mode: input.mode,
    status: input.status,
    payload,
    truncated,
    payloadRedacted: true,
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

  const content = gateObservationContent(input);
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
    content,
  });
  await endActivity(client, workspaceId, activity.id, 'completed');
}
