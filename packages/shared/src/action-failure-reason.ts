import type { ActionRequestFailureKind } from './enums.js';

/**
 * action-failure-reason (S11 GO1, review of #601 M1): which kind of failure
 * (`ActionRequestFailureKind`) an ActionRequest's failure reason names — by the code it starts with
 * (`<code>: <detail>`). Only for what holds the reason text alone: migrations/governance/0021's
 * backfill of rows from before `failure_kind` (its CASE lists these same codes; a kernel test holds
 * them equal), and the console reading a tool result from before `failureKind`. A failure written
 * since carries its kind, and nothing reads it back out of a reason.
 *
 * A whitelist, read one way: only a code that says for certain nothing ran is `not_delivered` or
 * `refused`. Every other reason is `outcome_unknown` — no code, a code not listed here, and the
 * reasons earlier releases wrote for a call that may have run: `outcome unknown: …` (with a space),
 * a bare `gatekeeper client: gate/apply timed out …`, `network_error: …`, `response_too_large: …`,
 * `invalid_response: …`, `internal_error: …`, `unrecognized_gate_error: …`, and `transport_error: …`
 * from a gate before legacy 287, which did not yet tell a failure that may have reached the target
 * from one that did not. Reading an unknown reason as "outcome unknown" sends a person to check the
 * target; reading it as "refused" would tell them asking again is harmless.
 */

/** Nothing reached the gate, or the gate holds no record of the call: nothing ran. */
export const NOT_DELIVERED_FAILURE_CODES = [
  'gate_unreachable',
  'gate_token_unavailable',
  'connection_secret_missing',
  'gate_not_found',
  'apply_not_received',
] as const;

/**
 * Refused before anything ran. By the platform at execution time: the Operation was disabled, it
 * names no approved definition, the gate's endpoint is not an allowed target or answered with a
 * redirect the kernel does not follow. By the gate before its transport ran (gatekeeper-base
 * `apply`, `server.ts` `mapGatekeeperError`): the call was not authenticated, names no Operation or
 * one this gate runs under another definition, its params do not validate, the gate's transport
 * refused it, or the gate had no credential for it — each of which frees the call's key unused.
 */
export const REFUSED_BEFORE_RUNNING_FAILURE_CODES = [
  'operation_disabled',
  'operation_definition_unavailable',
  'target_refused',
  'redirect_refused',
  'unauthorized',
  'operation_not_found',
  'invalid_params',
  'invalid_operation_schema',
  'operation_definition_mismatch',
  'operation_refused',
  'credential_unavailable',
] as const;

/** The one refusal reason with no code: the request's gatekeeper is no longer registered
 *  (`application/gateway/action-executor.ts` `execute`). */
const GATEKEEPER_NOT_REGISTERED = /^gatekeeper "[^"]*" is not registered$/;

const REASON_CODE = /^([a-z][a-z_]*):/;

const NOT_DELIVERED: ReadonlySet<string> = new Set(NOT_DELIVERED_FAILURE_CODES);
const REFUSED: ReadonlySet<string> = new Set(REFUSED_BEFORE_RUNNING_FAILURE_CODES);

/** The failure kind `reason` names — `outcome_unknown` unless its code says for certain nothing
 *  ran (see the module comment). */
export function failureKindOfReason(reason: string | null | undefined): ActionRequestFailureKind {
  if (!reason) return 'outcome_unknown';
  if (GATEKEEPER_NOT_REGISTERED.test(reason)) return 'refused';
  const code = REASON_CODE.exec(reason)?.[1];
  if (code === undefined) return 'outcome_unknown';
  if (NOT_DELIVERED.has(code)) return 'not_delivered';
  if (REFUSED.has(code)) return 'refused';
  return 'outcome_unknown';
}
