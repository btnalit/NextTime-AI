import {
  type GateAbsence,
  type ObservationAbsenceCheck,
  type ObservationCheck,
  type Operation,
  type Role,
  getCapability,
  operationAbsentAnswers,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type GateTarget,
  type GatekeeperClient,
  GatekeeperClientError,
  GatekeeperTimeoutError,
  gateAbsenceOf,
  gateFailureRetry,
} from '../../adapters/gatekeeper-client/index.js';
import { shownAuditReason } from '../../governance/approval/index.js';
import { roleMayUseCapability } from '../../governance/capability/index.js';
import {
  type OperationAbsentAnswersReview,
  getGatekeeper,
  getOrCreateGatekeeperServicePrincipal,
  getPublishedOperation,
  operationRecordDigest,
} from '../../governance/gatekeepers/index.js';
import {
  ObserveParamsCarryCredentialsError,
  redactSuspectedSecrets,
  reviewObserveParams,
} from '../../governance/redaction/index.js';
import {
  type PredicateEvaluation,
  endActivity,
  evaluatePredicate,
  lintPredicate,
  recordSourceObservation,
  startActivity,
} from '../../substrate/epistemic/index.js';
import {
  observeRefusal,
  readGatekeeperPlatformPolicy,
  readObserveExclusions,
} from '../gates/index.js';
import { resolveGateTarget } from '../gateway/gate-target.js';
import { getOrCreateGatekeeperSource } from '../gateway/observed-facts.js';
import { predicateCredentialProblems } from './plan.js';

/**
 * application/goal/platform-observation (S11 GO3d, GO4): an observation the platform makes for a
 * goal's requester — a declared `ObservationCheck` (an observe-class Operation, its params and a
 * predicate over its result), shared by the reconcile check of an action whose outcome is unknown
 * (`reconcile-check.ts`) and the goal's acceptance checks (`acceptance-check.ts`); or (S11
 * 「门确认不存在」 B) an `ObservationAbsenceCheck` — the call alone, met only when the gate
 * confirms the thing looked up is not there (an `observe_absent` acceptance check, plan.ts;
 * reconcile does not use it yet). Each caller owns its row, its claim and what a settled outcome
 * means; this module owns the three steps every such observation takes and the rules they keep:
 *
 *   1. {@link preparePlatformObservation} — in the requester's workspace context, before any call:
 *      the predicate passes the plan's lint and credential review again (either may have learned
 *      more since the plan was confirmed) — for an absence check, the published Operation still
 *      declares which answers mean "does not exist", in a version a person confirmed (it may have
 *      been republished since) — the requester is enabled and their role may still observe
 *      (R-35), the gate and Operation are published and not cut off for them — the rule
 *      every observation is under (`observeRefusal`), with the requester's agent exclusions applied
 *      (the platform stands in for their agent, so it reaches no gate their agent could not) — and
 *      the params carry no credential. No Grant is needed, as for any observation.
 *   2. {@link callPlatformObservation} — outside any transaction: the gate call, carrying the
 *      published definition's digest and the requester as `onBehalfOf`, like `observe_operation`'s.
 *      A failure is classed by `adapters/gatekeeper-client`'s `gateFailureRetry` alone: `transient`
 *      is no answer (the caller may try again), `deterministic` a refusal. S11 「门确认不存在」 A:
 *      a gate that answers the call as absent is taken at its word only when the published
 *      definition declares that answer means "does not exist" (`gateAbsenceOf`, else the answer is
 *      refused as `invalid_response`); the answer is then `data: null` with its `absent`.
 *   3. {@link recordPlatformObservation} — in the caller's settling transaction: an Activity of the
 *      caller's kind and an Observation on the Gatekeeper's Source holding the call, the predicate,
 *      the outcome and the result (suspected secrets redacted, cut at
 *      {@link PLATFORM_OBSERVATION_RESULT_MAX_CHARS}), so the evidence answers "why does the
 *      platform believe this". The predicate is judged on that redacted result: what the platform
 *      keeps is what it proves from, and a stored result that is not cut gives the same outcome
 *      again. An absent answer is recorded as such (`absent` in the content) and judged on `null`,
 *      which no predicate that passes the lint is satisfied by (`PREDICATE_EMPTY_PROBES`): what a
 *      check expects of a thing that is not there is not met, and the caller treats it as it treats
 *      any other unmet outcome. An absence check has no predicate (nor an `expect` in the
 *      content): it is `satisfied` exactly when the gate answered absent, and `unsatisfied` when
 *      data came back — the thing is still there, kept as the result. The database passes an
 *      `observe_absent` check only on an Observation of it that records `absent`, no `expect` and
 *      the version's `absentAnswersReview`, and an `observe_predicate` one only on one that records
 *      `expect` and no `absent` (goal/0011). No graph Facts are written: the observation answers
 *      one question, and its result mapping is the gate's business.
 *
 * {@link platformObservationRetryDelayMs} is the one backoff rule both callers retry under: 30 s
 * doubling to {@link PLATFORM_OBSERVATION_MAX_BACKOFF_MS}, capped by attempts and by duration from
 * the first attempt.
 */

/** The longest wait between two attempts. */
export const PLATFORM_OBSERVATION_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** The most characters of an observation's result kept in its evidence. */
export const PLATFORM_OBSERVATION_RESULT_MAX_CHARS = 8000;

/** Delay before attempt `attempt + 1`: 30 s, doubling, at most
 *  {@link PLATFORM_OBSERVATION_MAX_BACKOFF_MS} — five attempts within 7½ minutes. */
export function defaultPlatformObservationBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), PLATFORM_OBSERVATION_MAX_BACKOFF_MS);
}

export interface PlatformObservationRetryCaps {
  readonly maxAttempts: number;
  readonly maxDurationMs: number;
  readonly backoffMs?: (attempt: number) => number;
}

/** When the next attempt of an observation that did not settle on attempt `attempts` starts, as a
 *  delay from `now` — or `null` when this attempt is its last: `attempts` reached `maxAttempts`, or
 *  the next would start past `maxDurationMs` from `firstAttemptAt`. */
export function platformObservationRetryDelayMs(
  row: { readonly attempts: number; readonly firstAttemptAt: Date | null },
  now: Date,
  caps: PlatformObservationRetryCaps,
): number | null {
  if (row.attempts >= caps.maxAttempts) return null;
  const delayMs = (caps.backoffMs ?? defaultPlatformObservationBackoffMs)(row.attempts);
  const first = (row.firstAttemptAt ?? now).getTime();
  return now.getTime() + delayMs > first + caps.maxDurationMs ? null : delayMs;
}

/** The call of an observation the platform makes: with a predicate over its result, or (S11
 *  「门确认不存在」 B) without one — met only by the gate's declared absence. */
export type PlatformObservationCall = ObservationCheck | ObservationAbsenceCheck;

/** Whether `call` is met by the gate confirming absence rather than by a predicate — the one test
 *  the kernel makes, mirroring goal/0011's shape rule (an absence call carries no `expect`). */
export function expectsAbsence(call: PlatformObservationCall): boolean {
  return !('expect' in call);
}

/** What the gate call needs, read in the requester's context — or why it is not made. */
export type PreparedPlatformObservation =
  | {
      readonly kind: 'call';
      readonly gate: GateTarget;
      /** The published definition — what the gate's answer is checked against
       *  (`gateAbsenceOf`). */
      readonly operation: Operation;
      readonly operationDigest: string;
      readonly credentialReview: Record<string, unknown>;
      /** An absence check's (S11 「门确认不存在」 B-a/B-b): who confirmed, when the published
       *  version was, that the gate's credentials can see what it looks up — what the absence it
       *  answers is worth; recorded on the Observation. */
      readonly absentAnswersReview?: OperationAbsentAnswersReview;
    }
  | { readonly kind: 'refused'; readonly code: string };

/** The refusal of an absence check whose Operation, as published now, declares no answer that
 *  means "does not exist": nothing it could answer would meet the check. */
export const ABSENCE_NOT_DECLARED = 'absence_not_declared';

/** The refusal of an absence check whose published version was published without a person
 *  confirming the gate's credentials can see what it looks up (`absentAnswersReview`, B-a): a 404
 *  under credentials that cannot see the thing proves nothing, so it is not asked. */
export const ABSENCE_NOT_REVIEWED = 'absence_not_reviewed';

/** Step 1 — see the module comment. Refusal codes: `predicate_refused`,
 *  `credentials_in_predicate`, `requester_may_not_observe`, `observeRefusal`'s reasons,
 *  `gate_not_enabled`, {@link ABSENCE_NOT_DECLARED}, {@link ABSENCE_NOT_REVIEWED}, and the params
 *  review's. */
export async function preparePlatformObservation(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  check: PlatformObservationCall,
): Promise<PreparedPlatformObservation> {
  const ws = workspaceId;
  if ('expect' in check) {
    if (lintPredicate(check.expect).length > 0) {
      return { kind: 'refused', code: 'predicate_refused' };
    }
    if (predicateCredentialProblems(check.expect).length > 0) {
      return { kind: 'refused', code: 'credentials_in_predicate' };
    }
  }
  const principal = await client.query<{ role: Role; disabled: boolean }>(
    `select role, disabled_at is not null as disabled from principals
      where workspace_id = $1 and id = $2`,
    [ws, requesterId],
  );
  const requester = principal.rows[0];
  if (
    !requester ||
    requester.disabled ||
    !roleMayUseCapability(requester.role, getCapability('observe_operation'))
  ) {
    return { kind: 'refused', code: 'requester_may_not_observe' };
  }
  const gatekeeper = await getGatekeeper(client, ws, check.gatekeeperId);
  const platformPolicy = await readGatekeeperPlatformPolicy(client, ws, check.gatekeeperId);
  const published = await getPublishedOperation(client, ws, check.gatekeeperId, check.operation);
  const refusal = observeRefusal(await readObserveExclusions(client, ws, requesterId), {
    gatekeeperId: check.gatekeeperId,
    gateEnabled: gatekeeper !== null,
    operationName: check.operation,
    publishedMode: published?.operation.mode,
    platformPolicy,
  });
  if (refusal || !gatekeeper || !published) {
    return { kind: 'refused', code: refusal?.reason ?? 'gate_not_enabled' };
  }
  const absence = expectsAbsence(check);
  if (absence && !operationAbsentAnswers(published.operation)) {
    return { kind: 'refused', code: ABSENCE_NOT_DECLARED };
  }
  if (absence && !published.absentAnswersReview) {
    return { kind: 'refused', code: ABSENCE_NOT_REVIEWED };
  }
  let credentialReview: Record<string, unknown>;
  try {
    credentialReview = reviewObserveParams(gatekeeper.name, check.operation, check.params ?? {});
  } catch (err) {
    if (err instanceof ObserveParamsCarryCredentialsError) {
      return { kind: 'refused', code: err.code };
    }
    throw err;
  }
  return {
    kind: 'call',
    gate: await resolveGateTarget(client, ws, gatekeeper),
    operation: published.operation,
    operationDigest: operationRecordDigest(published),
    credentialReview,
    ...(absence && published.absentAnswersReview
      ? { absentAnswersReview: published.absentAnswersReview }
      : {}),
  };
}

/** What the gate answered. */
export type PlatformObservationAnswer =
  /** `absent` set: the gate answered that the target has no such thing, as the published definition
   *  declares (`data` is then `null`). */
  | { readonly kind: 'data'; readonly data: unknown; readonly absent?: GateAbsence }
  /** Nothing a retry could change (`gateFailureRetry`: `deterministic`). */
  | { readonly kind: 'refused'; readonly code: string; readonly error: string | null }
  /** No answer (`gateFailureRetry`: `transient`). */
  | { readonly kind: 'no_answer'; readonly code: string; readonly error: string | null };

function errorText(err: unknown): string | null {
  return shownAuditReason(err instanceof Error ? err.message : String(err));
}

/** Step 2 — see the module comment. */
export async function callPlatformObservation(
  gatekeeperClient: Pick<GatekeeperClient, 'observe'>,
  requesterId: string,
  check: PlatformObservationCall,
  prepared: Extract<PreparedPlatformObservation, { kind: 'call' }>,
): Promise<PlatformObservationAnswer> {
  try {
    const result = await gatekeeperClient.observe(prepared.gate, {
      operation: check.operation,
      params: check.params ?? {},
      onBehalfOf: requesterId,
      operationDigest: prepared.operationDigest,
    });
    const absent = gateAbsenceOf(prepared.operation, result);
    return absent ? { kind: 'data', data: null, absent } : { kind: 'data', data: result.data };
  } catch (err) {
    const code =
      err instanceof GatekeeperClientError
        ? err.code
        : err instanceof GatekeeperTimeoutError
          ? 'gate_timeout'
          : 'gate_error';
    return {
      kind: gateFailureRetry(err) === 'deterministic' ? 'refused' : 'no_answer',
      code,
      error: errorText(err),
    };
  }
}

/** A redacted result as the evidence keeps it: whole, or cut at
 *  {@link PLATFORM_OBSERVATION_RESULT_MAX_CHARS} of its JSON. */
function keptResult(redacted: unknown): {
  readonly result: unknown;
  readonly truncated: boolean;
} {
  const serialized = JSON.stringify(redacted) ?? 'null';
  if (serialized.length <= PLATFORM_OBSERVATION_RESULT_MAX_CHARS) {
    return { result: redacted, truncated: false };
  }
  return {
    result: `${serialized.slice(0, PLATFORM_OBSERVATION_RESULT_MAX_CHARS)}… [${serialized.length - PLATFORM_OBSERVATION_RESULT_MAX_CHARS} more characters omitted]`,
    truncated: true,
  };
}

export interface RecordPlatformObservationInput {
  readonly requesterId: string;
  readonly check: PlatformObservationCall;
  /** The Activity's kind and metadata — what the caller observed for. */
  readonly activityKind: string;
  readonly activityMetadata: Record<string, unknown>;
  /** The caller's fields at the head of the Observation's content: `purpose` and the ids the
   *  evidence is about. */
  readonly about: { readonly purpose: string } & Record<string, unknown>;
  readonly data: unknown;
  /** The gate answered that the target has no such thing (`PlatformObservationAnswer`). */
  readonly absent?: GateAbsence;
  readonly operationDigest: string;
  readonly credentialReview: Record<string, unknown>;
  /** An absence check's: the published version's confirmation (`PreparedPlatformObservation`). */
  readonly absentAnswersReview?: OperationAbsentAnswersReview;
}

export interface RecordedPlatformObservation {
  readonly observationId: string;
  readonly sourceId: string;
  readonly evaluation: PredicateEvaluation;
}

/** Step 3 — see the module comment. */
export async function recordPlatformObservation(
  client: PoolClient,
  workspaceId: string,
  input: RecordPlatformObservationInput,
): Promise<RecordedPlatformObservation> {
  const ws = workspaceId;
  const call = input.check;
  const redacted = input.absent
    ? null
    : redactSuspectedSecrets(input.data ?? null, { secretFields: true }).value;
  const predicate = 'expect' in call ? call.expect : undefined;
  const evaluation: PredicateEvaluation =
    predicate === undefined
      ? { outcome: input.absent ? 'satisfied' : 'unsatisfied', undetermined: [] }
      : evaluatePredicate(predicate, redacted);
  const { result, truncated } = keptResult(redacted);
  const activity = await startActivity(client, ws, {
    kind: input.activityKind,
    principalId: input.requesterId,
    metadata: input.activityMetadata,
  });
  const sourceId = await getOrCreateGatekeeperSource(
    client,
    ws,
    call.gatekeeperId,
    await getOrCreateGatekeeperServicePrincipal(client, ws),
  );
  const observation = await recordSourceObservation(client, ws, {
    sourceId,
    activityId: activity.id,
    content: {
      ...input.about,
      gatekeeperId: call.gatekeeperId,
      operation: call.operation,
      operationDigest: input.operationDigest,
      params: redactSuspectedSecrets(call.params ?? {}, { secretFields: true }).value,
      ...input.credentialReview,
      ...(predicate === undefined ? {} : { expect: predicate }),
      outcome: evaluation.outcome,
      undetermined: evaluation.undetermined,
      ...(input.absent ? { absent: input.absent } : {}),
      ...(predicate === undefined && input.absentAnswersReview
        ? { absentAnswersReview: input.absentAnswersReview }
        : {}),
      result,
      truncated,
    },
  });
  await endActivity(client, ws, activity.id, 'completed');
  return { observationId: observation.id, sourceId, evaluation };
}
