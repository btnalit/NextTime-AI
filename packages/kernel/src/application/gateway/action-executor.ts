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
 * committing) asks again under the same key, so the gate's own idempotency store (design doc
 * §5.1.4 "apply 幂等") returns the stored result instead of re-running the effect. Observed facts
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
 *  asks the gate again about an `executing` row whose first `apply` gave no answer — never a fresh
 *  execution decision. `ok: false` with `indeterminate: true` means the gate still gave no verdict
 *  on the call's key (the row stays `executing`); any other `ok: false` is terminal. */
export interface ActionReplayer {
  replay(actionRequest: ActionRequestRow): Promise<ActionExecutorResult>;
}

export type GatekeeperActionExecutor = ActionExecutor & ActionReplayer;

/** Gate error codes (`@nexttime/gatekeeper-base` `server.ts`) that settle an `apply` for its key on
 *  a replay (R-48): the call's own stored failure (502 `transport_error`, R-51), or a refusal that
 *  ran nothing and freed the key (403 `operation_refused`, 424 `credential_unavailable`, 409
 *  `operation_definition_mismatch` — legacy K: the gate answers a key that holds a result before
 *  it compares definitions, so this one means the key holds none). */
const SETTLED_FAILURE_CODES = new Set([
  'transport_error',
  'operation_refused',
  'credential_unavailable',
  'operation_definition_mismatch',
]);

/** Legacy K: the digest the gate is told was approved for `actionRequest` — the one recorded when
 *  the request was made (migrations/governance/0019). A row that names none (made before that
 *  migration, or for an unpublished Operation with no draft, I17) falls back to the Operation
 *  published now, which is what it would have run before, now checked by the gate. `refusal`:
 *  there is nothing to send, or the stored definition does not parse. */
async function approvedOperationDigest(
  client: PoolClient,
  actionRequest: ActionRequestRow,
): Promise<{ readonly digest: string } | { readonly refusal: string }> {
  if (actionRequest.operationDigest !== null) return { digest: actionRequest.operationDigest };
  const published = await getPublishedOperation(
    client,
    actionRequest.workspaceId,
    actionRequest.gatekeeperId,
    actionRequest.actionKind,
  );
  if (!published) {
    return {
      refusal: `operation_definition_unavailable: "${actionRequest.actionKind}" was requested while it was not published and had no draft, and it is still not published — this workspace holds no definition to hold the gate to, so nothing was sent. Publish the Operation (its definition is what gets approved), then request it again.`,
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
  /** The gate gave no verdict on this key: the call timed out, or the gate answered 409
   *  `idempotency_conflict` — an apply for this key is still running there. */
  | { readonly kind: 'in_doubt'; readonly message: string }
  /** The gate says it cannot know (409 `apply_outcome_unknown`, R-51 / D-11): its exec timeout
   *  killed the call, or a gate process stopped mid-call. Never re-run — a person reconciles. */
  | { readonly kind: 'outcome_unknown'; readonly message: string }
  /** `settled`: the gate answered from the key's own record (`SETTLED_FAILURE_CODES`). */
  | { readonly kind: 'failed'; readonly message: string; readonly settled: boolean };

/** How one failed `gate/apply` call reads — shared by the first execution and the reaper's replay,
 *  so both draw the same line between "failed", "outcome unknown" and "no answer yet". */
function applyErrorVerdict(err: unknown): ApplyErrorVerdict {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GatekeeperTimeoutError) return { kind: 'in_doubt', message };
  if (err instanceof GatekeeperClientError) {
    if (err.code === 'apply_outcome_unknown') return { kind: 'outcome_unknown', message };
    if (err.code === 'idempotency_conflict') return { kind: 'in_doubt', message };
    return { kind: 'failed', message, settled: SETTLED_FAILURE_CODES.has(err.code) };
  }
  return { kind: 'failed', message, settled: false };
}

/** The `failed` reason for an apply whose effect nobody can confirm (R-48): `outcome_unknown`, the
 *  same reason-prefix convention as `operation_disabled` below. */
function outcomeUnknownReason(detail: string): string {
  return `outcome_unknown: ${detail}`;
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

  function applyInput(actionRequest: ActionRequestRow, operationDigest: string | undefined) {
    return {
      operation: actionRequest.actionKind,
      params: actionRequest.params,
      onBehalfOf: actionRequest.onBehalfOf,
      actionRequestId: actionRequest.id,
      operationDigest,
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
          reason: `operation_disabled: "${actionRequest.actionKind}" was disabled by the platform after this request was made`,
        };
      }
      if ('refusal' in approved) return { ok: false, reason: approved.refusal };

      let applyResult: Awaited<ReturnType<GatekeeperClient['apply']>>;
      try {
        applyResult = await deps.gatekeeperClient.apply(
          gate,
          applyInput(actionRequest, approved.digest),
        );
      } catch (err) {
        const verdict = applyErrorVerdict(err);
        if (verdict.kind === 'in_doubt') {
          // The gate may still be performing the effect — the outcome is unknown, not failed.
          // The drainer leaves the row `executing` (a barrier for this Gatekeeper's queue, R-50);
          // `reapStaleExecutingActionRequests` (below) asks the gate again later under this same
          // `actionRequestId` and the gate's idempotency store answers.
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
     * R-48: the reaper's replay. Unlike `execute`, no deny-list or registration pre-check may end
     * the row here: the first call may already have taken effect, so only the gate can say what
     * happened. It always asks the gate — an idempotent `apply` under the same `actionRequestId`,
     * which the gate's idempotency store answers with the first call's stored result, its stored
     * failure (R-51), or "outcome unknown" (a key a gate process left pending, D-11). A gate with
     * no verdict yet (409 still applying, a timeout, unreachable, any other error) leaves the row
     * `executing` for the next tick — the reaper's attempt cap bounds that.
     *
     * Known edge: a key the first call never reserved (its request never reached the gate) is
     * free, so this replay runs the effect fresh — `apply` is the only lookup the gate protocol has.
     */
    async replay(actionRequest: ActionRequestRow): Promise<ActionExecutorResult> {
      const { gate, approved } = await deps.withTransaction(
        actionRequest.workspaceId,
        actionRequest.onBehalfOf,
        async (client) => {
          const record = await getGatekeeper(
            client,
            actionRequest.workspaceId,
            actionRequest.gatekeeperId,
          );
          return {
            gate: record
              ? await resolveGateTarget(client, actionRequest.workspaceId, record)
              : null,
            approved: await approvedOperationDigest(client, actionRequest),
          };
        },
      );
      if (!gate) {
        return {
          ok: false,
          indeterminate: true,
          reason: `gatekeeper "${actionRequest.gatekeeperId}" is not registered — no gate to ask`,
        };
      }

      // Legacy K: unlike `execute`, no refusal here — the first call may have run, and the gate
      // answers a key that holds a result whatever digest comes with it. With none to send, it
      // answers only from its store and refuses (settles) a key that holds nothing.
      const operationDigest = 'digest' in approved ? approved.digest : undefined;
      let applyResult: Awaited<ReturnType<GatekeeperClient['apply']>>;
      try {
        applyResult = await deps.gatekeeperClient.apply(
          gate,
          applyInput(actionRequest, operationDigest),
        );
      } catch (err) {
        const verdict = applyErrorVerdict(err);
        if (verdict.kind === 'outcome_unknown') {
          return { ok: false, reason: outcomeUnknownReason(verdict.message) };
        }
        if (verdict.kind === 'failed' && verdict.settled) {
          return { ok: false, reason: verdict.message };
        }
        return { ok: false, indeterminate: true, reason: verdict.message };
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
 * stored result instead of re-running the effect, a failed one its stored failure, and a key a
 * gate process left pending answers "outcome unknown" (R-51 / D-11) — this function does not
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
