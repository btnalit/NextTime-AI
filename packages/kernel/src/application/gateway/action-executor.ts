import { createHash } from 'node:crypto';
import { IllegalTransition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import {
  type GatekeeperClient,
  GatekeeperClientError,
  GatekeeperTimeoutError,
} from '../../adapters/gatekeeper-client/index.js';
import type { ActionExecutor, ActionExecutorResult } from '../../governance/approval/index.js';
import type { ActionRequestRow } from '../../governance/approval/index.js';
import {
  DEFAULT_MAX_REPLAY_ATTEMPTS,
  NO_OPERATION_DEFINITION,
  listStaleExecutingActionRequests,
  markActionRequestExecuted,
  markActionRequestFailed,
  recordActionRequestReplayAttempt,
} from '../../governance/approval/index.js';
import {
  OperationDefinitionUnreadableError,
  getGatekeeper,
  getPublishedOperation,
  operationRecordDigest,
} from '../../governance/gatekeepers/index.js';
import { quotedName } from '../../governance/redaction/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { operationPlatformStatus, readGateLinkPolicy } from '../gates/index.js';
import { resolveGateTarget } from './gate-target.js';
import { writeObservedFacts } from './observed-facts.js';

/**
 * application/gateway/action-executor: the real `ActionExecutor` port `governance/approval`'s
 * `ApprovalDrainer` calls to actually perform one `executing` ActionRequest's effect (design doc
 * §5.1.4 Gatekeeper `apply`; docs/development-tasks.md S2.4 "ActionExecutor implementation over
 * the gate client"). Lives in `application` (not `governance`, which may not depend on `adapters`,
 * §7.10) because it composes `adapters/gatekeeper-client` with `governance/gatekeepers` and
 * `substrate`.
 *
 * `apply`'s `actionRequestId` is the ActionRequest's own id — the stale-executing reaper's replay
 * (`replay` below; e.g. after a crash between `apply` succeeding and `markActionRequestExecuted`
 * committing) asks the gate about that key (`gate/apply_lookup`, legacy 287), and the gate's own
 * idempotency store (design doc §5.1.4 "apply 幂等") answers with the stored result — the effect
 * is never run again. Observed facts
 * from a successful `apply` are written in their own short Activity, opened and closed around the
 * write — separate from whatever Activity (if any) the original `request_action` call ran under,
 * since execution can happen well after and in a different transaction (a human approving
 * asynchronously, or the periodic drain tick).
 */

export type WithTransactionFn = <T>(
  workspaceId: string,
  principalId: string,
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

/**
 * Builds the admin-mode (`skipRoleSwitch: true`) `WithTransactionFn` every background/system
 * consumer of the Gatekeeper execution path shares: the periodic drain tick, the
 * `ActionRequestUpdated` outbox consumer, and `request_action`'s own `afterCommit` phase-2
 * continuation (S2.4 two-phase fix, request-action-handler.ts) — none of these run inside a
 * per-request RLS context (there is no single request driving them), the same category as the
 * outbox dispatcher and the approval-expiry reaper. One factory, not one inline arrow function per
 * call site, so "how the Gatekeeper execution path opens a background transaction" has exactly one
 * definition.
 */
export function createAdminWithTransaction(pool: PoolLike): WithTransactionFn {
  return (workspaceId, principalId, fn) =>
    withWorkspace(pool, { workspaceId, principalId }, fn, { skipRoleSwitch: true });
}

// -------------------------------------------------------------------------------------------
// request_action idempotency-key derivation (P1-1 fix, review job 652a4abc lane3/lane2). Kept
// here rather than in request-action-handler.ts (already near the design doc's §7.10 "单文件 ≤
// 600 行" guidance) — a small, self-contained, stateless helper set next to the other
// action-execution primitives this file already owns, not a new module.
//
// `request_action`'s own await budget (25s, request-action-handler.ts's
// `DEFAULT_AWAIT_DECISION_TIMEOUT_MS`) is deliberately kept *below* the platform-extension
// kernel-client's 30s per-call timeout (`packages/platform-extension/src/kernel-client.ts`,
// `DEFAULT_KERNEL_CLIENT_TIMEOUT_MS`) — but a caller can still retry after any transport hiccup
// (a dropped connection, a client-side abort) faster than that. Without a stable idempotency key,
// a retry with identical intent creates a *second* ActionRequest — a second policy evaluation, a
// second `apply` once approved. `governance/approval/request-action.ts` already implements the
// storage half (a partial unique index on `(workspace_id, idempotency_key)`, a SAVEPOINT around
// the INSERT, `findActionRequestByIdempotencyKey`); this is the derivation half.
// -------------------------------------------------------------------------------------------

/** Deterministic JSON serialization — sorts object keys recursively so two calls with the same
 *  params but different key order hash identically. Not a general-purpose canonical-JSON
 *  implementation (no BigInt/Date/cyclic handling) — `request_action`'s own `params` is always
 *  the result of `JSON.parse`-shaped input (a capability's `paramsSchema`), which can never
 *  contain those. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 of `params`' stable serialization, hex-encoded — same `createHash('sha256')...digest
 *  ('hex')` convention `application/gateway/auth.ts`'s `hashApiKey` already uses. */
export function hashStableParams(params: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(params), 'utf8').digest('hex');
}

/**
 * The default `request_action` idempotency key when the caller supplies none: `(sid|principal,
 * gatekeeperId, operation, stable params hash)` — a retry from the *same session* (a Worker's
 * `sid`) or the *same human principal* (no Handle, no `sid`) against the *same Operation with the
 * same arguments* collapses onto the same row while that row is in flight (R-53 / D-12: the
 * `auto:` prefix tells `governance/approval/request-action.ts` to ignore terminal rows). Two calls
 * that legitimately differ in any one of these (a different session, a different Operation, or
 * even one changed param) get independent ActionRequests, as they should — this is a narrow,
 * session-scoped default, not a general "dedupe this action forever" rule.
 */
export function deriveDefaultIdempotencyKey(args: {
  readonly identity: string;
  readonly gatekeeperId: string;
  readonly operationName: string;
  readonly params: Record<string, unknown>;
}): string {
  return `auto:${args.identity}:${args.gatekeeperId}:${args.operationName}:${hashStableParams(args.params)}`;
}

/**
 * Scopes a caller-supplied idempotency key to `(on_behalf_of, sid)` before it reaches the
 * `(workspace_id, idempotency_key)` unique index — the index itself is only workspace-scoped, so
 * two different Workers (or a Worker and a human) that happen to pass the literal same string
 * would otherwise collide and one would silently receive the other's ActionRequest.
 */
export function scopeExplicitIdempotencyKey(args: {
  readonly onBehalfOf: string;
  readonly sid: string | undefined;
  readonly key: string;
}): string {
  return `explicit:${args.onBehalfOf}:${args.sid ?? ''}:${args.key}`;
}

export interface GatekeeperActionExecutorDeps {
  readonly gatekeeperClient: GatekeeperClient;
  readonly withTransaction: WithTransactionFn;
}

/** R-48: the stale-executing reaper's port (`reapStaleExecutingActionRequests` below). `replay`
 *  asks the gate again about an `executing` row whose first `apply` gave no answer — a lookup,
 *  never an execution (legacy 287). `ok: false` with `indeterminate: true` means the gate still
 *  gave no verdict on the call's key (the row stays `executing`); any other `ok: false` is
 *  terminal. */
export interface ActionReplayer {
  replay(actionRequest: ActionRequestRow): Promise<ActionExecutorResult>;
}

export type GatekeeperActionExecutor = ActionExecutor & ActionReplayer;

/**
 * Answers to `gate/apply` that do not say whether the call ran (legacy 287, review of #586 M1): the
 * gate may have the request and may have run it, so the row stays `executing` and the reaper asks
 * the gate (`replay`). `gate_connection_lost`: the connection failed after the request may have
 * been sent. `idempotency_conflict`: an apply for this key is still running there.
 * `invalid_response` / `unrecognized_gate_error`: an HTTP answer came back that is not the gate's
 * protocol — a gate that answers badly, or a reverse proxy in front of an owner's gate that
 * forwarded the call and then answered 502 / 504 itself. `internal_error`: the gate failed in a
 * way it does not name — before it reserved the key, or after the transport ran (a failed write
 * of the result).
 */
const APPLY_IN_DOUBT_CODES = new Set([
  'gate_connection_lost',
  'idempotency_conflict',
  'invalid_response',
  'unrecognized_gate_error',
  'internal_error',
]);

/** Legacy K: the digest the gate is told was approved for `actionRequest` — the one recorded when
 *  the request was made (migrations/governance/0019). A request made against no definition (an
 *  unpublished Operation with no draft, I17: `NO_OPERATION_DEFINITION`) is refused — whatever is
 *  published by now was never what it was approved against (review of #538). A row from before
 *  that migration (`null`) falls back to the Operation published now, which is what it would have
 *  run before, now checked by the gate. `refusal`: there is nothing to send, or the stored
 *  definition does not parse. */
async function approvedOperationDigest(
  client: PoolClient,
  actionRequest: ActionRequestRow,
): Promise<{ readonly digest: string } | { readonly refusal: string }> {
  if (actionRequest.operationDigest === NO_OPERATION_DEFINITION) {
    return {
      refusal: `operation_definition_unavailable: ${quotedName(actionRequest.actionKind)} was requested while it was not published and had no draft, so it was approved without a definition — nothing was sent. Publish the Operation (its definition is what gets approved), then request it again.`,
    };
  }
  if (actionRequest.operationDigest !== null) return { digest: actionRequest.operationDigest };
  const published = await getPublishedOperation(
    client,
    actionRequest.workspaceId,
    actionRequest.gatekeeperId,
    actionRequest.actionKind,
  );
  if (!published) {
    return {
      refusal: `operation_definition_unavailable: ${quotedName(actionRequest.actionKind)} names no definition (it was requested before requests recorded one) and is not published now — this workspace holds no definition to hold the gate to, so nothing was sent. Publish the Operation (its definition is what gets approved), then request it again.`,
    };
  }
  try {
    return { digest: operationRecordDigest(published) };
  } catch (err) {
    if (err instanceof OperationDefinitionUnreadableError) {
      return { refusal: `operation_definition_unavailable: ${err.message}` };
    }
    throw err;
  }
}

type ApplyErrorVerdict =
  /** The gate gave no verdict on this key: the call timed out, or the answer is one of
   *  `APPLY_IN_DOUBT_CODES` (legacy 287). */
  | { readonly kind: 'in_doubt'; readonly message: string }
  /** The gate says it cannot know (409 `apply_outcome_unknown`, R-51 / D-11): its exec timeout
   *  killed the call, its connection to the target broke mid-call, or a gate process stopped
   *  mid-call. Or it answered and the answer cannot be read (`response_too_large`): the gate had
   *  the call, and asking again returns the same stored answer. Never re-run — a person
   *  reconciles. */
  | { readonly kind: 'outcome_unknown'; readonly message: string }
  /** Nothing ran, or the gate said the call failed: nothing was sent (`gate_unreachable`, a
   *  refused target, no credential to present — legacy 287), or the gate refused or failed the
   *  call in its own protocol (`transport_error`: its target answered with a failure). */
  | { readonly kind: 'failed'; readonly message: string };

/** How one failed `gate/apply` call reads. The line (legacy 287): a call that may have reached the
 *  gate is never "failed" unless the gate said so in its own protocol. */
function applyErrorVerdict(err: unknown): ApplyErrorVerdict {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GatekeeperTimeoutError) return { kind: 'in_doubt', message };
  if (err instanceof GatekeeperClientError) {
    if (err.code === 'apply_outcome_unknown') return { kind: 'outcome_unknown', message };
    if (APPLY_IN_DOUBT_CODES.has(err.code)) return { kind: 'in_doubt', message };
    if (err.code === 'response_too_large') {
      return {
        kind: 'outcome_unknown',
        message: `${message} — the gate had the call and answered, and its answer cannot be read; asking again returns the same answer`,
      };
    }
    // The gate's code leads the reason (`operation_definition_mismatch: …`), as on the MCP and WS
    // surfaces — the same reason-prefix convention as `outcome_unknown` / `operation_disabled`, so a
    // reader (the console's tool row, an agent) can tell which refusal it was (review of #538, G3).
    return { kind: 'failed', message: `${err.code}: ${message}` };
  }
  // Not the gate client's own error: thrown before the call left the kernel (the client wraps
  // every failure of a sent call).
  return { kind: 'failed', message };
}

/** How the reaper's `gate/apply_lookup` answer reads (legacy 287). `indeterminate`: the gate gave
 *  no verdict yet — ask again next tick, up to the reaper's cap. */
type LookupVerdict =
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'indeterminate'; readonly reason: string };

function lookupErrorVerdict(err: unknown): LookupVerdict {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof GatekeeperClientError)) return { kind: 'indeterminate', reason: message };
  // No call for the key ran on the gate, and the gate closed the key so none ever will.
  if (err.code === 'apply_not_received' && err.status === 404) {
    return { kind: 'failed', reason: notReceivedReason() };
  }
  // The first call's own stored answer.
  if (err.code === 'apply_outcome_unknown') {
    return { kind: 'failed', reason: outcomeUnknownReason(message) };
  }
  if (err.code === 'transport_error') return { kind: 'failed', reason: `${err.code}: ${message}` };
  // A 404 that is not the gate's own (`gate_not_found` is a gate host that does not serve this
  // instance right now): the gate has no `gate/apply_lookup` route — it predates it, so it cannot
  // be asked. It is never asked with `gate/apply` instead: a gate that old would run the call.
  if (err.status === 404 && err.code !== 'gate_not_found') {
    return { kind: 'failed', reason: outcomeUnknownReason(cannotAskDetail()) };
  }
  return { kind: 'indeterminate', reason: message };
}

/** The `failed` reason for an apply whose effect nobody can confirm (R-48): `outcome_unknown`, the
 *  same reason-prefix convention as `operation_disabled` below. */
function outcomeUnknownReason(detail: string): string {
  return `outcome_unknown: ${detail}`;
}

/** Legacy 287: the `failed` reason for a row whose replay found no record of it on the gate — no
 *  call for it ran there (a gate records a key durably before it runs anything, D-11, and one it
 *  refused it frees), so nothing ran. The same verdict as a first call that could not connect
 *  (`gate_unreachable`). */
function notReceivedReason(): string {
  return 'apply_not_received: the gate holds no record of this request having run, so nothing ran. Request it again if it is still wanted.';
}

/** Legacy 287: why a row whose gate cannot be asked ends `outcome_unknown`. */
function cannotAskDetail(): string {
  return 'this gate cannot be asked whether the request ran — it has no gate/apply_lookup route (its gatekeeper-base predates it), and asking with apply could run it again. Check the target system and reconcile by hand; a gate on a current gatekeeper-base can be asked.';
}

export function createGatekeeperActionExecutor(
  deps: GatekeeperActionExecutorDeps,
): GatekeeperActionExecutor {
  /** Writes a successful `apply`'s observed facts in their own short Activity (module doc). */
  async function recordApplied(
    actionRequest: ActionRequestRow,
    applyResult: Awaited<ReturnType<GatekeeperClient['apply']>>,
  ): Promise<ActionExecutorResult> {
    await deps.withTransaction(
      actionRequest.workspaceId,
      actionRequest.onBehalfOf,
      async (client) => {
        const activity = await startActivity(client, actionRequest.workspaceId, {
          kind: 'gatekeeper_apply',
          principalId: actionRequest.onBehalfOf,
          metadata: {
            actionRequestId: actionRequest.id,
            gatekeeperId: actionRequest.gatekeeperId,
          },
        });
        await writeObservedFacts(
          client,
          actionRequest.workspaceId,
          actionRequest.gatekeeperId,
          applyResult.observedFacts ?? [],
          activity.id,
        );
        await endActivity(client, actionRequest.workspaceId, activity.id, 'completed');
      },
    );

    return {
      ok: true,
      resultMetadata: { data: applyResult.data, replayed: applyResult.replayed },
    };
  }

  /** The fields the gate keys an `apply` on — the reaper's lookup asks about the same ones. */
  function applyKey(actionRequest: ActionRequestRow) {
    return {
      operation: actionRequest.actionKind,
      params: actionRequest.params,
      onBehalfOf: actionRequest.onBehalfOf,
      actionRequestId: actionRequest.id,
    };
  }

  return {
    async execute(actionRequest: ActionRequestRow): Promise<ActionExecutorResult> {
      const { gate, disabled, approved } = await deps.withTransaction(
        actionRequest.workspaceId,
        actionRequest.onBehalfOf,
        async (client) => {
          const record = await getGatekeeper(
            client,
            actionRequest.workspaceId,
            actionRequest.gatekeeperId,
          );
          // P-B1 (决定 ⑤ "按 Operation 禁用则在下一次调用就生效"): the deny list is re-read at
          // *execution* time too — an ActionRequest approved (or auto-approved) before the
          // administrator disabled its Operation must not run it (review finding).
          const link = record
            ? await readGateLinkPolicy(client, actionRequest.workspaceId, record.gatekeeperId)
            : null;
          return {
            // R-01 / D-01: which credential this gate gets (gate-target.ts).
            gate: record
              ? await resolveGateTarget(client, actionRequest.workspaceId, record)
              : null,
            disabled: operationPlatformStatus(link, actionRequest.actionKind).disabled,
            approved: await approvedOperationDigest(client, actionRequest),
          };
        },
      );
      if (!gate) {
        return {
          ok: false,
          reason: `gatekeeper "${actionRequest.gatekeeperId}" is not registered`,
        };
      }
      if (disabled) {
        return {
          ok: false,
          reason: `operation_disabled: ${quotedName(actionRequest.actionKind)} was disabled by the platform after this request was made`,
        };
      }
      if ('refusal' in approved) return { ok: false, reason: approved.refusal };

      let applyResult: Awaited<ReturnType<GatekeeperClient['apply']>>;
      try {
        applyResult = await deps.gatekeeperClient.apply(gate, {
          ...applyKey(actionRequest),
          operationDigest: approved.digest,
        });
      } catch (err) {
        const verdict = applyErrorVerdict(err);
        if (verdict.kind === 'in_doubt') {
          // The gate may have the request, or still be performing the effect — the outcome is
          // unknown, not failed. The drainer leaves the row `executing` (a barrier for this
          // Gatekeeper's queue, R-50); `reapStaleExecutingActionRequests` (below) asks the gate
          // later about this same `actionRequestId` and the gate's idempotency store answers.
          return {
            ok: false,
            indeterminate: true,
            reason: `outcome unknown: ${verdict.message} — the gate may still complete it`,
          };
        }
        if (verdict.kind === 'outcome_unknown') {
          return { ok: false, reason: outcomeUnknownReason(verdict.message) };
        }
        return { ok: false, reason: verdict.message };
      }

      return recordApplied(actionRequest, applyResult);
    },

    /**
     * R-48 / legacy 287: the reaper's replay — a lookup, never an execution. It asks
     * `gate/apply_lookup` about this row's `actionRequestId`, which the gate answers from its
     * idempotency store only, never touching the transport: the first call's stored result, its
     * stored failure (R-51), "outcome unknown" for a key a gate process left pending (D-11), 409
     * while that call still runs, or 404 `apply_not_received` for a key that holds nothing. A gate
     * records a key durably before it runs anything (D-11), so a key that holds nothing means no
     * call for it ran: the row is `failed` (`apply_not_received`) — the verdict a first call that
     * could not connect gets — and the gate closes the key in the same step, so a first call that
     * only arrives now is refused there rather than run. Running it here instead would be a fresh
     * execution that skipped `execute`'s checks (the platform deny list, the approved definition)
     * long after it was approved.
     *
     * A gate without the lookup route (built before it) answers a 404 of another shape: it cannot
     * be asked, and the row ends `failed: outcome_unknown` for a person to reconcile. It is never
     * asked with a digest-less `gate/apply` instead — a gate from before legacy K would run that.
     *
     * No deny-list or registration pre-check may end the row here: the first call may already have
     * taken effect, so only the gate can say what happened. A gate with no verdict yet (409 still
     * applying, a timeout, unreachable, any other error) leaves the row `executing` for the next
     * tick — the reaper's attempt cap bounds that.
     */
    async replay(actionRequest: ActionRequestRow): Promise<ActionExecutorResult> {
      const gate = await deps.withTransaction(
        actionRequest.workspaceId,
        actionRequest.onBehalfOf,
        async (client) => {
          const record = await getGatekeeper(
            client,
            actionRequest.workspaceId,
            actionRequest.gatekeeperId,
          );
          return record ? resolveGateTarget(client, actionRequest.workspaceId, record) : null;
        },
      );
      if (!gate) {
        return {
          ok: false,
          indeterminate: true,
          reason: `gatekeeper "${actionRequest.gatekeeperId}" is not registered — no gate to ask`,
        };
      }

      let applyResult: Awaited<ReturnType<GatekeeperClient['lookupApply']>>;
      try {
        applyResult = await deps.gatekeeperClient.lookupApply(gate, applyKey(actionRequest));
      } catch (err) {
        const verdict = lookupErrorVerdict(err);
        return verdict.kind === 'failed'
          ? { ok: false, reason: verdict.reason }
          : { ok: false, indeterminate: true, reason: verdict.reason };
      }

      return recordApplied(actionRequest, applyResult);
    },
  };
}

// -------------------------------------------------------------------------------------------
// stale-`executing` reaper (P1-3 fix, review job 652a4abc: "crash/DB failure between apply
// success and markActionRequestExecuted leaves row `executing` forever; not drainable, no
// reaper, no event, parent Task never resumes"). Lives here, not in governance/approval
// (§7.10 layering — governance may not depend on `adapters/gatekeeper-client`), same reasoning
// `createGatekeeperActionExecutor` above already establishes for this file.
// -------------------------------------------------------------------------------------------

export interface ReapStaleExecutingActionRequestsOptions {
  /** Forwarded to `listStaleExecutingActionRequests` — default `DEFAULT_STALE_EXECUTING_
   *  TIMEOUT_MS`. */
  readonly staleAfterMs?: number;
  /** R-48: replays of one row that may end without an answer before the row is marked `failed`
   *  with an `outcome_unknown` reason — default `DEFAULT_MAX_REPLAY_ATTEMPTS`. */
  readonly maxReplayAttempts?: number;
  /** Called for a row whose replay genuinely failed (a real DB/network error, not a benign race
   *  with the original executor finally finishing) — never for a benign race, which the reaper
   *  itself resolves by moving on to the next row. Defaults to a no-op; `packages/kernel/src/
   *  index.ts` passes `app.log.error`. */
  readonly onRowError?: (actionRequestId: string, error: unknown) => void;
}

export interface ReapStaleExecutingActionRequestsResult {
  readonly scanned: number;
  readonly reaped: number;
}

/**
 * Scans every workspace for `executing` ActionRequests stuck past `options.staleAfterMs`
 * (`listStaleExecutingActionRequests`) and, for each, asks the gate again through
 * `ActionReplayer.replay` (R-48 — not `execute`: no pre-check may end a row whose first call may
 * already have taken effect). The gate's own idempotency store (keyed by `actionRequestId`,
 * `apply`'s own field of that name) is what makes this safe: a completed `apply` returns its
 * stored result instead of re-running the effect, a failed one its stored failure, a key a gate
 * process left pending answers "outcome unknown" (R-51 / D-11), and a key that holds nothing is
 * closed rather than run (legacy 287: the replay is `gate/apply_lookup`) — this function does not
 * re-implement that guarantee, it only decides *when* to ask and when to stop asking.
 *
 * Bounded (R-48): each replay is counted on the row before it runs
 * (`recordActionRequestReplayAttempt`, so a replay that throws counts too, across restarts). A
 * replay with no verdict (`indeterminate`) leaves the row `executing` for the next tick until the
 * count reaches `options.maxReplayAttempts`; then the row is marked `failed` with an
 * `outcome_unknown` reason for a person to reconcile against the target system.
 *
 * Marking the outcome tolerates `IllegalTransition`: the row may have been genuinely still
 * executing (just slow) and finished — by the original caller's own phase-2, the drainer, or the
 * outbox consumer — in the window between the scan and this call, in which case
 * `markActionRequestExecuted`/`markActionRequestFailed` finds the row no longer `executing` and
 * throws; that is not a failure, it means the row is already resolved (same "benign race" swallow
 * `action-request-drain-consumer.ts` already applies to the same error class). Any other error is
 * reported via `onRowError` and the reaper moves on — one poisoned row must not block the rest of
 * the batch (mirrors `expireOverduePendingApprovals`/`runTaskReaper`'s own per-row isolation).
 */
export async function reapStaleExecutingActionRequests(
  pool: PoolLike,
  actionReplayer: ActionReplayer,
  options: ReapStaleExecutingActionRequestsOptions = {},
): Promise<ReapStaleExecutingActionRequestsResult> {
  const staleRows = await listStaleExecutingActionRequests(pool, {
    staleAfterMs: options.staleAfterMs,
  });
  const withTransaction = createAdminWithTransaction(pool);
  const onRowError = options.onRowError ?? (() => {});
  const maxReplayAttempts = options.maxReplayAttempts ?? DEFAULT_MAX_REPLAY_ATTEMPTS;

  let reaped = 0;
  for (const row of staleRows) {
    try {
      const attempt = await withTransaction(row.workspaceId, row.onBehalfOf, (client) =>
        recordActionRequestReplayAttempt(client, row.workspaceId, row.id),
      );
      if (attempt === null) continue; // benign — already resolved elsewhere since the scan.

      // Past the cap only when earlier replays threw before resolving anything: stop asking.
      const replayed: ActionExecutorResult =
        attempt > maxReplayAttempts
          ? { ok: false, indeterminate: true, reason: 'earlier replays ended in errors' }
          : await actionReplayer.replay(row);
      const noAnswer = !replayed.ok && replayed.indeterminate === true;
      if (noAnswer && attempt < maxReplayAttempts) continue; // still `executing`: next tick.
      const outcome: ActionExecutorResult = noAnswer
        ? {
            ok: false,
            reason: outcomeUnknownReason(
              `no answer from the gate after ${attempt} replays (last: ${replayed.reason}) — check the target system and reconcile by hand`,
            ),
          }
        : replayed;
      await withTransaction(row.workspaceId, row.onBehalfOf, (client) =>
        outcome.ok
          ? markActionRequestExecuted(client, row.workspaceId, row.id, {
              resultMetadata: outcome.resultMetadata,
            })
          : markActionRequestFailed(client, row.workspaceId, row.id, { reason: outcome.reason }),
      );
      reaped += 1;
    } catch (err) {
      if (err instanceof IllegalTransition) continue; // benign — already resolved elsewhere.
      onRowError(row.id, err);
    }
  }

  return { scanned: staleRows.length, reaped };
}
