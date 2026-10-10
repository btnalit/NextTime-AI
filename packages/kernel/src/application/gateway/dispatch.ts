import type { Capability } from '@nexttime/shared';
import { getCapability } from '@nexttime/shared';
import { withPlatform } from '../../adapters/db/platform-context.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { redactSuspectedSecrets } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { ForbiddenError, authorizeCapabilityCall } from './authorize.js';
import { CAPABILITY_HANDLERS } from './handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/dispatch: `POST /api/cap/<name>`'s business logic (design doc §9.3, I11;
 * docs/development-tasks.md S1.3, items 3-4). `interfaces/http` calls only `dispatchCapability` —
 * everything below (registry lookup, authorization, param validation, the transaction, the audit
 * write) is this module's job, keeping `interfaces/http` a thin HTTP adapter that never reaches
 * into substrate directly (depcruise `kernel-interfaces-must-not-reach-into-substrate-directly`).
 *
 * I11 mechanism: a capability with a wired handler (handlers.ts) runs inside exactly one
 * `withWorkspace()` transaction that also calls `writeAudit` before returning — if the audit
 * insert throws (e.g. a forced failure in a test, or a real constraint violation), `withWorkspace`
 * rolls back the *whole* transaction, so the handler's own writes (once S1.4+ wires a write
 * capability here) never persist either. A capability with no wired handler
 * (`CapabilityNotImplementedError`, HTTP 501) never opens a transaction at all — nothing was
 * "executed", so there is nothing to audit.
 *
 * **Two-phase handlers** (S2.4, `CapabilityHandlerResult.afterCommit` — capability-handler.ts):
 * a handler may return `afterCommit(pool)` alongside its phase-1 `result`. Phase 1 (this
 * function's existing behavior, unchanged) runs the handler inside the one transaction, writes
 * the audit row for the *phase-1* result, and commits — this is deliberately correct as-is: the
 * phase-1 result (e.g. `request_action`'s `{actionRequestId, status}`) is what actually happened
 * inside this transaction, and any phase-2 state transitions (approve-triggered execution, etc.)
 * write their own audit rows through the governed service functions that perform them, same as
 * every other multi-step governed flow in this codebase. Only once the transaction has committed
 * (so the row a phase-2 continuation needs to see — e.g. a human approving it from a different
 * connection — is actually visible outside this call) does `dispatchCapability` invoke
 * `afterCommit(deps.pool)` and use *its* resolved value as the capability's real `result`. A
 * handler with no `afterCommit` behaves exactly as before. `afterCommit` is intentionally generic
 * and tiny (one function, `pool` in, `unknown` out) — `request_action` (this task) is the first
 * user; S2.7's `invoke_worker` (a long, possibly-async wait with the same "must not hold the
 * request's own transaction open" constraint) is expected to need the identical shape. An error
 * thrown by `afterCommit` propagates and is mapped exactly like any other handler error — the
 * phase-1 work has already committed by then regardless (it is not, and cannot be, rolled back by
 * a phase-2 failure).
 */

export class CapabilityNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown capability "${name}"`);
    this.name = 'CapabilityNotFoundError';
  }
}

export class InvalidCapabilityParamsError extends Error {
  readonly issues: unknown;
  constructor(name: string, issues: unknown) {
    super(`invalid params for capability "${name}"`);
    this.name = 'InvalidCapabilityParamsError';
    this.issues = issues;
  }
}

export class CapabilityNotImplementedError extends Error {
  constructor(name: string) {
    super(`capability "${name}" is not implemented yet`);
    this.name = 'CapabilityNotImplementedError';
  }
}

/**
 * S3.7 (docs/wire-contract-conventions.md §5): thrown by `dispatchCapability` when
 * `KERNEL_VALIDATE_RESULTS=1` is set and a capability's actual result does not match its own
 * registered `resultSchema` — an internal bug (the handler drifted from the contract its own
 * registry entry declares), never a caller-input problem, so this is deliberately not shaped like
 * `InvalidCapabilityParamsError`; `interfaces/http`/`interfaces/ws` fall through to their generic
 * 500/INTERNAL_ERROR mapping for it, same as any other unmapped internal `Error`.
 */
export class CapabilityResultValidationError extends Error {
  readonly issues: unknown;
  constructor(name: string, issues: unknown) {
    super(
      `capability "${name}" returned a result that does not match its own resultSchema (KERNEL_VALIDATE_RESULTS=1) — this is an internal contract bug, not a caller error`,
    );
    this.name = 'CapabilityResultValidationError';
    this.issues = issues;
  }
}

/**
 * Env var gating `dispatchCapability`'s own result-shape self-check (docs/wire-contract-
 * conventions.md §5, S3.7 "为每个 capability 增加 resultSchema... 结果校验只在测试/CI 跑，不进生产").
 * Unset in production (default): zero runtime cost, zero behavior change — every capability
 * result is returned exactly as the handler produced it, same as before this flag existed. Set to
 * `'1'` in `vitest.base.ts` (kernel unit + integration tests) and in CI's `quality` job, so every
 * existing test exercises every dispatched capability's own contract for free. Read fresh on every
 * call (not cached at module load) so a test can toggle it per-case.
 */
const RESULT_VALIDATION_ENV_VAR = 'KERNEL_VALIDATE_RESULTS';

/** Exported for a narrow unit test (dispatch.test.ts) that does not want to depend on vitest.base
 *  .ts's own global env wiring to prove the flag itself works. */
export function isResultValidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RESULT_VALIDATION_ENV_VAR] === '1';
}

function validateResultAgainstSchema(capability: Capability, name: string, result: unknown): void {
  if (!isResultValidationEnabled()) return;
  if (!capability.resultSchema) return;
  const parsed = capability.resultSchema.safeParse(result);
  if (!parsed.success) {
    throw new CapabilityResultValidationError(name, parsed.error.issues);
  }
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `audit_records.resource_id` is a uuid column (migrations/core/0004_audit.sql). A handler that
 * returns a non-uuid `resourceId` (a quota key, an operation name, …) must not turn the whole
 * capability call into a 500 at the audit INSERT — the row is written with `resource_id = null`
 * and the raw reference preserved in the payload instead, so the call still succeeds and the
 * audit trail still says what was touched. Handlers should still return uuids where they have
 * them; this is the safety net, not the convention.
 */
export function auditResourceRef(resourceId: string | undefined): {
  readonly resourceId: string | undefined;
  readonly resourceRef: string | undefined;
} {
  if (resourceId === undefined || UUID_SHAPE.test(resourceId)) {
    return { resourceId, resourceRef: undefined };
  }
  return { resourceId: undefined, resourceRef: resourceId };
}

export interface DispatchDeps {
  readonly pool: PoolLike;
}

/** The acting (workspaceId, principalId) for RLS + audit attribution — I13: always the Handle's
 *  `on_behalf_of` for a handle caller, never a session/agent id of its own. */
function callerContext(caller: ResolvedCaller): { workspaceId: string; principalId: string } {
  if (caller.channel === 'human') {
    return { workspaceId: caller.principal.workspaceId, principalId: caller.principal.id };
  }
  if (caller.channel === 'handle') {
    return { workspaceId: caller.claims.ws, principalId: caller.claims.obo };
  }
  // Unreachable: dispatchCapability takes the platform branch before asking. Kept total so a
  // future caller kind is a compile error here rather than an undefined workspace downstream.
  throw new Error('callerContext: a platform caller has no workspace context');
}

function lookupCapabilityOrThrow(name: string): Capability {
  const capability = getCapability(name);
  if (!capability) throw new CapabilityNotFoundError(name);
  return capability;
}

/**
 * The copy of a call's params written into `audit_records.payload` below. The audit log is read by
 * every auditor and kept, so a credential in it is one more place to leak from.
 *
 * Every channel's params are redacted by #526's rule (governance/redaction/credential-review.ts,
 * `redactSuspectedSecrets` with the call-argument rule): every string or number under a field whose
 * name names a secret (`password`, `apiKey`, `pageToken` — `@nexttime/shared`'s
 * `namesASecretField`, the rule the console masks by), and every value that looks like a secret
 * wherever it is (a JWT, `Bearer …`, `PGPASSWORD=…` — the patterns that scrub a Turn's tool calls).
 * A Handle-channel call's params come from an agent, which can be talked into passing its own
 * Handle; a person's call can carry a password or a token pasted into a field; a platform call's
 * `create_user` carries one by design. So the audit copy hides exactly what the console would
 * hide, and what an approval counts. Only the audit copy is redacted — the handler gets the params
 * as sent — and the payload's `redactedValues` says how many values were replaced.
 *
 * S2.13 (design doc §11 "凭证不进内核进程"; `Capability.redactedParamKeys`'s own doc comment,
 * packages/shared/src/capabilities.ts): then every field named in `capability.redactedParamKeys`
 * is replaced whole by the placeholder, whatever it holds — `create_connection`'s `credentials`.
 */
function auditParams(
  capability: Capability,
  params: Record<string, unknown>,
): { readonly params: Record<string, unknown>; readonly redactedValues?: number } {
  // Unbounded walk: the params already passed their schema, and the copy keeps their shape.
  const redacted = redactSuspectedSecrets(params, { secretFields: true });
  let audited = redacted.value as Record<string, unknown>;
  if (capability.redactedParamKeys && capability.redactedParamKeys.length > 0) {
    audited = { ...audited };
    for (const key of capability.redactedParamKeys) {
      if (key in audited) audited[key] = '[redacted]';
    }
  }
  return redacted.count > 0
    ? { params: audited, redactedValues: redacted.count }
    : { params: audited };
}

/**
 * Dispatches one capability call. Throws `CapabilityNotFoundError` (404), `ForbiddenError` (403,
 * authorize.ts), `InvalidCapabilityParamsError` (400), `CapabilityNotImplementedError` (501), or —
 * only when `KERNEL_VALIDATE_RESULTS=1` — `CapabilityResultValidationError`; resolves with the
 * handler's `result` on success.
 */
export async function dispatchCapability(
  deps: DispatchDeps,
  caller: ResolvedCaller,
  name: string,
  rawParams: unknown,
): Promise<unknown> {
  const capability = lookupCapabilityOrThrow(name);

  authorizeCapabilityCall(caller, capability);

  const parsed = capability.paramsSchema.safeParse(rawParams ?? {});
  if (!parsed.success) throw new InvalidCapabilityParamsError(name, parsed.error.issues);

  const handler = CAPABILITY_HANDLERS.get(name);
  // `typeof … === 'function'` rather than a truthiness check: the registry lookup above already
  // proved `name` is a known capability, and this makes the dynamic call's target explicit
  // (CodeQL js/unvalidated-dynamic-method-call) — a Map entry is never a prototype property.
  if (typeof handler !== 'function') throw new CapabilityNotImplementedError(name);

  // P-A1 (docs/platform-admin-design.md §7): a platform-scope capability runs in a platform
  // transaction — `app.platform = on`, still `nexttime_app` — with no workspace and no Principal,
  // and its audit row is the platform shape (`workspace_id is null`, `actor_user_id`).
  // authorizeCapabilityCall above already guaranteed `caller.channel === 'platform'` here.
  if (capability.scope === 'platform') {
    if (caller.channel !== 'platform') {
      throw new ForbiddenError(`capability "${name}" requires a platform administrator`);
    }
    const platformUser = { id: caller.user.id, login: caller.user.login };
    const platformResult = await withPlatform(
      deps.pool,
      { userId: platformUser.id },
      async (client) => {
        const result = await handler(client, '', parsed.data, {
          channel: 'human',
          principalId: '',
          platformUser,
        });
        const resourceRef = auditResourceRef(result.resourceId);
        await writeAudit(client, {
          workspaceId: null,
          actorPrincipalId: null,
          actorUserId: platformUser.id,
          action: name,
          resourceType: result.resourceType,
          resourceId: resourceRef.resourceId,
          payload: {
            channel: 'platform',
            actorLogin: platformUser.login,
            ...auditParams(capability, parsed.data as Record<string, unknown>),
            ...(resourceRef.resourceRef !== undefined
              ? { resourceRef: resourceRef.resourceRef }
              : {}),
          },
        });
        return result;
      },
    );
    const platformFinal = platformResult.afterCommit
      ? await platformResult.afterCommit(deps.pool)
      : platformResult.result;
    validateResultAgainstSchema(capability, name, platformFinal);
    return platformFinal;
  }

  if (caller.channel === 'platform') {
    // authorizeCapabilityCall already refused this pairing; the check narrows `caller` for the
    // workspace path below.
    throw new ForbiddenError(`capability "${name}" is workspace-scoped`);
  }
  const { workspaceId, principalId } = callerContext(caller);
  const onBehalfOf = principalId;

  const handlerResult = await withWorkspace(
    deps.pool,
    { workspaceId, principalId },
    async (client) => {
      // P-A2 (`set_workspace_status`): a disabled workspace is closed on every channel *per call*,
      // not only at authentication — a WebSocket authenticated before the disable would otherwise
      // keep dispatching (and `send_chat_message` would re-mint an entry session the disable just
      // revoked). One primary-key read; `workspaces` is readable by the application role (0001).
      const workspaceRow = await client.query<{ status: string }>(
        'select status from workspaces where id = $1',
        [workspaceId],
      );
      if (workspaceRow.rows[0]?.status !== 'active') {
        throw new ForbiddenError('workspace_disabled: this workspace is disabled');
      }
      const result = await handler(client, workspaceId, parsed.data, {
        channel: caller.channel,
        principalId,
        scope: caller.channel === 'handle' ? caller.claims.scope : undefined,
        // S2.7 addition (purely additive, alongside `scope` above): `invoke_worker`'s child-Handle
        // minting needs the caller's full Handle claims (jti/sid/exp, not just scope) to attenuate
        // from and to look up its own WorkerRun (I18 depth) — this is the only place that has
        // verified claims in hand.
        ...(caller.channel === 'handle' ? { claims: caller.claims } : {}),
        // S3.11 addition (purely additive, alongside `scope`/`claims` above): the already-resolved
        // human Principal row (resolve-caller.ts), so a handler needing "who am I / what's my
        // role" (get_workspace's own `caller` field) never re-queries `principals` a second time.
        ...(caller.channel === 'human'
          ? {
              principal: {
                id: caller.principal.id,
                kind: caller.principal.kind,
                role: caller.principal.role,
                displayName: caller.principal.displayName,
              },
            }
          : {}),
        // S8 W1-C addition, purely additive alongside `principal` above: only set when this
        // human-channel call authenticated via the S4.1 console-session cookie *and* that login
        // is a platform administrator (`capability-handler.ts`'s own `consoleUser` doc comment —
        // resolve_refs's `workspace` kind is the first reader).
        ...(caller.channel === 'human' && caller.user
          ? { consoleUser: { platformRole: caller.user.platformRole } }
          : {}),
      });
      const resourceRef = auditResourceRef(result.resourceId);
      await writeAudit(client, {
        workspaceId,
        actorPrincipalId: principalId,
        action: name,
        resourceType: result.resourceType,
        resourceId: resourceRef.resourceId,
        payload: {
          // First, so the fixed fields below always win over a handler's additions.
          ...result.auditPayload,
          channel: caller.channel,
          onBehalfOf,
          ...auditParams(capability, parsed.data as Record<string, unknown>),
          ...(resourceRef.resourceRef !== undefined
            ? { resourceRef: resourceRef.resourceRef }
            : {}),
        },
      });
      return result;
    },
  );

  const finalResult = handlerResult.afterCommit
    ? await handlerResult.afterCommit(deps.pool)
    : handlerResult.result;
  validateResultAgainstSchema(capability, name, finalResult);
  return finalResult;
}
