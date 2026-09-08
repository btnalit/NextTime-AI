import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type { ActionExecutor, ActionExecutorResult } from '../../governance/approval/index.js';
import type { ActionRequestRow } from '../../governance/approval/index.js';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { writeObservedFacts } from './observed-facts.js';

/**
 * application/gateway/action-executor: the real `ActionExecutor` port `governance/approval`'s
 * `ApprovalDrainer` calls to actually perform one `executing` ActionRequest's effect (design doc
 * §5.1.4 Gatekeeper `apply`; docs/development-tasks.md S2.4 "ActionExecutor implementation over
 * the gate client"). Lives in `application` (not `governance`, which may not depend on `adapters`,
 * §7.10) because it composes `adapters/gatekeeper-client` with `governance/gatekeepers` and
 * `substrate`.
 *
 * `apply`'s `idempotencyKey` is the ActionRequest's own id — a `drainGatekeeper` retry (e.g. after
 * a crash between `apply` succeeding and `markActionRequestExecuted` committing) replays the same
 * key, so the gate's own idempotency store (design doc §5.1.4 "apply 幂等") returns the stored
 * result instead of re-running the effect. Observed facts from a successful `apply` are written in
 * their own short Activity, opened and closed around the write — separate from whatever Activity
 * (if any) the original `request_action` call ran under, since execution can happen well after and
 * in a different transaction (a human approving asynchronously, or the periodic drain tick).
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
 * same arguments* collapses onto the same row. Two calls that legitimately differ in any one of
 * these (a different session, a different Operation, or even one changed param) get independent
 * ActionRequests, as they should — this is a narrow, session-scoped default, not a general
 * "dedupe this action forever" rule.
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

export function createGatekeeperActionExecutor(deps: GatekeeperActionExecutorDeps): ActionExecutor {
  return {
    async execute(actionRequest: ActionRequestRow): Promise<ActionExecutorResult> {
      const gatekeeper = await deps.withTransaction(
        actionRequest.workspaceId,
        actionRequest.onBehalfOf,
        (client) => getGatekeeper(client, actionRequest.workspaceId, actionRequest.gatekeeperId),
      );
      if (!gatekeeper) {
        return {
          ok: false,
          reason: `gatekeeper "${actionRequest.gatekeeperId}" is not registered`,
        };
      }

      let applyResult: Awaited<ReturnType<GatekeeperClient['apply']>>;
      try {
        applyResult = await deps.gatekeeperClient.apply(gatekeeper.endpoint, {
          operation: actionRequest.actionKind,
          params: actionRequest.params,
          onBehalfOf: actionRequest.onBehalfOf,
          idempotencyKey: actionRequest.id,
        });
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }

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
    },
  };
}
