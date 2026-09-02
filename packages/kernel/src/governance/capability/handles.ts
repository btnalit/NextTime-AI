import { randomUUID } from 'node:crypto';
import {
  CAPABILITY_REGISTRY,
  type CapabilityScope,
  CapabilityScopeSchema,
  type HandleClaims,
  HandleClaimsSchema,
  HandleTokenExpired,
  HandleTokenInvalid,
  getCapability,
  verifyHandleToken,
} from '@nexttime/shared';
import { SignJWT } from 'jose';
import type { CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import { HANDLE_SIGNING_ALG } from './keys.js';

/** Re-exported unchanged so every existing importer of `./handles.js` keeps working — the schema
 *  and type now live in `@nexttime/shared`'s `handle-token` module (S1.7 "共享 Handle-token 原语"),
 *  this module's own public API (names, shapes, behavior) is otherwise untouched. */
export { CapabilityScopeSchema, HandleClaimsSchema };
export type { CapabilityScope, HandleClaims };

/**
 * governance/capability/handles: issue / verify / attenuate / revoke Capability Handles (design
 * doc §5.1.4, §5.4 I13, §9.2, §11; docs/development-tasks.md S1.9).
 *
 * A Handle is a short-lived, EdDSA-signed compact JWT bound to a Session (`sessions`,
 * core/0001_identity.sql). Its claims (`ws / sid / obo / scope / jti / exp / iat / par?`) are the
 * same fields recorded in `capability_handles` (migrations/governance/0001_capability_handles.sql)
 * — the token is self-describing to any verifier holding only the kernel's public key (llm-proxy,
 * S1.7, verifies locally with no DB round trip per request); this table is the kernel's own
 * revocation/lineage record.
 *
 * Every function that touches the database takes an already-open `PoolClient` (design doc S1.9
 * task brief: `issueHandle(client, ...)`) rather than a `Pool` — the caller is expected to already
 * be running inside `withWorkspace(...)` (packages/kernel/src/adapters/db/pool.ts), scoped to the
 * Handle's workspace, so that RLS (I1) and the two-argument `withWorkspace` transaction/session-var
 * contract apply uniformly across this module and the rest of the kernel. This module never calls
 * `withWorkspace` itself.
 */

// -------------------------------------------------------------------------------------------
// CapabilityScope — schema/type now defined in @nexttime/shared, re-exported above.
// -------------------------------------------------------------------------------------------

/** Thrown when a `CapabilityScope` names an unknown or human-channel-only capability. */
export class ScopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeValidationError';
  }
}

/**
 * Validates a `CapabilityScope` against the shared capability registry (design doc §9.3;
 * docs/development-tasks.md S1.9): every named capability must exist, and none may be
 * human-channel-only (§5.3 item 8 "Handle 范围大于其来源" / §5.1.4 — a Handle is a `handle`-channel
 * credential by construction, so a human-only capability could never legitimately be exercised
 * through one). Does not evaluate `resources` — resource-id validity is capability-specific and
 * not modeled by the shared registry.
 *
 * Deliberately does not attempt to validate the dynamic `<gate>.<op>` pattern's concrete
 * instantiations (e.g. a real capability name like `example_gatekeeper.example_operation`,
 * generated at runtime from a Gatekeeper's published interface manifest, §5.1.4/§7.5) — no
 * Gatekeeper exists yet at S1.9 (that machinery lands in S2.4+). Only the two literal pattern rows
 * registered in packages/shared/src/capabilities.ts (`<gate>.<op>` observe, `<gate>.<op>:execute`)
 * are recognized here; a scope naming an unrecognized dynamic gate capability is rejected as
 * unknown, same as any other unregistered name, until a later task extends this check.
 */
export function assertValidScope(scope: CapabilityScope): void {
  for (const name of scope.capabilities) {
    const capability = getCapability(name);
    if (!capability) {
      throw new ScopeValidationError(`unknown capability "${name}" in scope`);
    }
    if (capability.channel !== 'handle') {
      throw new ScopeValidationError(
        `capability "${name}" is human-channel-only and can never appear in a Handle scope`,
      );
    }
  }
}

// -------------------------------------------------------------------------------------------
// entryScope — the fixed entry-agent ceiling (design doc §5.1.4 WorkerDefinition row)
// -------------------------------------------------------------------------------------------

/**
 * Capability names that belong in the entry-agent ceiling but are not identified by the `graph`
 * group or the `propose_*` name prefix alone (§5.1.4: "`find_*`、`invoke_worker`、
 * `request_connection`、`record_decision`"; `get_task`/`get_entry_context`/`report_turn` are the
 * S1.6 per-Turn bootstrap/write-back capabilities, packages/shared/src/capabilities.ts `task`
 * group doc comment). `find_operations`/`find_workers`/`find_procedures` ("find_*") are already
 * covered by the `graph` group below and are not repeated here.
 */
const ENTRY_CEILING_EXTRA_CAPABILITY_NAMES = [
  'get_task',
  'get_entry_context',
  'report_turn',
  'invoke_worker',
  'request_connection',
  'record_decision',
] as const;

/**
 * The observe-class Gatekeeper Operation pattern (§5.1.4: "门上的 observe 类 Operation" is part of
 * the entry ceiling; "没有门上的 execute" — the execute-class pattern, `<gate>.<op>:execute`, is
 * deliberately never added here). This is the same placeholder registry row every entry and
 * Worker Handle's observe-mode gate access projects through (packages/shared/src/capabilities.ts
 * `gate` group doc comment) — concrete per-Gatekeeper Operation names are resolved at grant time
 * (S2.4+), not by this fixed ceiling.
 */
const ENTRY_CEILING_GATE_OBSERVE_CAPABILITY_NAME = '<gate>.<op>';

/**
 * Builds the fixed set of capability names in the entry-agent ceiling (design doc §5.1.4): every
 * `graph`-group capability (observe-only by construction — includes `find_*`), every capability
 * whose name starts with `propose_` (spans the `ontology`/`meta`/`worker` groups), the
 * observe-class gate pattern, and the extra fixed names above. Never includes an execute-mode
 * capability, `request_action`, or the gate execute pattern (§5.3 item 11 "入口 agent 的 Handle 含
 * execute 能力" is one of the relationships that must never exist).
 */
function buildEntryCeilingCapabilityNames(): readonly string[] {
  const names = new Set<string>();
  for (const capability of CAPABILITY_REGISTRY) {
    if (capability.group === 'graph' || capability.name.startsWith('propose_')) {
      names.add(capability.name);
    }
  }
  names.add(ENTRY_CEILING_GATE_OBSERVE_CAPABILITY_NAME);
  for (const name of ENTRY_CEILING_EXTRA_CAPABILITY_NAMES) {
    names.add(name);
  }
  return Object.freeze([...names]);
}

/** The entry-agent capability ceiling (design doc §5.1.4), computed once at module load. */
export const ENTRY_CEILING_CAPABILITIES: readonly string[] = buildEntryCeilingCapabilityNames();

/**
 * A WorkerDefinition's resource scoping, as far as this module needs it. No `WorkerDefinition`
 * type exists yet (design doc §9.2's `worker_definitions` table and its TS projection land in
 * S2.6) — this is deliberately the minimal local shape `entryScope` needs today (assumption, see
 * PR body "假设"): once S2.6 defines the real type, a caller can pass any object that is
 * structurally compatible (a `.resources` map of the same shape), or this local type can be
 * replaced with an import from that module.
 */
export interface EntryWorkerDefinitionInput {
  /** Per-capability-key resource scope to merge into the returned CapabilityScope's `resources`. */
  readonly resources?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Builds the fixed entry-agent Handle ceiling (design doc §5.1.4). `capabilities` is always
 * exactly `ENTRY_CEILING_CAPABILITIES` — it does not vary by `definition`, because the ceiling is
 * fixed platform policy, not something a WorkerDefinition author can widen. `resources` is taken
 * from `definition.resources` (e.g. which Gatekeepers/objects this entry WorkerDefinition may
 * observe) and defaults to `{}` (no resource access) when omitted.
 */
export function entryScope(definition: EntryWorkerDefinitionInput = {}): CapabilityScope {
  const resources: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(definition.resources ?? {})) {
    resources[key] = [...ids];
  }
  return {
    capabilities: [...ENTRY_CEILING_CAPABILITIES],
    resources,
  };
}

// -------------------------------------------------------------------------------------------
// HandleClaims — schema/type now defined in @nexttime/shared, re-exported above.
// -------------------------------------------------------------------------------------------

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** Thrown by `verifyHandle` when the token's `exp` claim is in the past. */
export class HandleExpired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleExpired';
  }
}

/** Thrown by `verifyHandle` when `isRevoked(jti)` reports the token has been revoked. */
export class HandleRevoked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleRevoked';
  }
}

/** Thrown by `verifyHandle` for a malformed token: bad signature, bad shape, wrong algorithm. */
export class HandleInvalid extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HandleInvalid';
  }
}

/** Thrown by `attenuate` when the requested child scope/ttl is not a subset of the parent's. */
export class AttenuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttenuationError';
  }
}

/** Thrown by `issueHandle` for an invalid issuance request (unknown session, non-positive ttl). */
export class HandleIssuanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleIssuanceError';
  }
}

// -------------------------------------------------------------------------------------------
// issueHandle
// -------------------------------------------------------------------------------------------

export interface IssueHandleParams {
  readonly sessionId: string;
  readonly scope: CapabilityScope;
  /** Handle lifetime in seconds from issuance; must be positive. */
  readonly ttlSeconds: number;
  /** Set only when this Handle is the product of `attenuate`. */
  readonly parentJti?: string;
  readonly privateKey: CryptoKey;
}

export interface IssuedHandle {
  readonly token: string;
  readonly jti: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  /** Copied from the session row (I13) — never equal to a caller-supplied value. */
  readonly onBehalfOf: string;
  readonly scope: CapabilityScope;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly parentJti?: string;
}

interface SessionRow {
  workspace_id: string;
  on_behalf_of: string;
}

/**
 * Issues a new Handle: reads `workspace_id`/`on_behalf_of` from the `sessionId`'s session row
 * (I13 — `obo` is never accepted as a parameter), signs an EdDSA compact JWT, and records the
 * `capability_handles` row in the same transaction the caller's `client` is already part of.
 *
 * `client` must already be inside a `withWorkspace(...)` transaction scoped to the session's
 * workspace (this function does not itself set RLS session variables or open a transaction) —
 * both the session lookup and the `capability_handles` insert are subject to RLS (I1), so a
 * `client` scoped to a different workspace than the session's simply sees/writes nothing, rather
 * than silently issuing a Handle into the wrong workspace.
 */
export async function issueHandle(
  client: PoolClient,
  params: IssueHandleParams,
): Promise<IssuedHandle> {
  assertValidScope(params.scope);
  if (!Number.isFinite(params.ttlSeconds) || params.ttlSeconds <= 0) {
    throw new HandleIssuanceError(`ttlSeconds must be a positive number, got ${params.ttlSeconds}`);
  }

  const sessionResult = await client.query<SessionRow>(
    'select workspace_id, on_behalf_of from sessions where id = $1',
    [params.sessionId],
  );
  const sessionRow = sessionResult.rows[0];
  if (!sessionRow) {
    throw new HandleIssuanceError(`no session found for sessionId "${params.sessionId}"`);
  }

  const jti = randomUUID();
  const iatSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = iatSeconds + Math.floor(params.ttlSeconds);

  const claims: HandleClaims = {
    ws: sessionRow.workspace_id,
    sid: params.sessionId,
    obo: sessionRow.on_behalf_of,
    scope: params.scope,
    jti,
    iat: iatSeconds,
    exp: expSeconds,
    ...(params.parentJti !== undefined ? { par: params.parentJti } : {}),
  };

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
    .sign(params.privateKey);

  await client.query(
    `insert into capability_handles
       (workspace_id, jti, session_id, on_behalf_of, parent_jti, scope, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      sessionRow.workspace_id,
      jti,
      params.sessionId,
      sessionRow.on_behalf_of,
      params.parentJti ?? null,
      JSON.stringify(params.scope),
      new Date(expSeconds * 1000).toISOString(),
    ],
  );

  return {
    token,
    jti,
    workspaceId: sessionRow.workspace_id,
    sessionId: params.sessionId,
    onBehalfOf: sessionRow.on_behalf_of,
    scope: params.scope,
    issuedAt: new Date(iatSeconds * 1000),
    expiresAt: new Date(expSeconds * 1000),
    ...(params.parentJti !== undefined ? { parentJti: params.parentJti } : {}),
  };
}

// -------------------------------------------------------------------------------------------
// verifyHandle
// -------------------------------------------------------------------------------------------

export interface VerifyHandleOptions {
  readonly publicKey: CryptoKey;
  /**
   * Revocation lookup, keyed by `jti`. `llm-proxy` (S1.7) syncs a local revocation set on a
   * period rather than calling back to the kernel per request (design doc §7.7); the kernel's own
   * `createDbRevocationCheck` below is a direct per-call DB lookup, suitable for kernel-internal
   * verification where an extra query is cheap.
   */
  readonly isRevoked: (jti: string) => Promise<boolean> | boolean;
}

/**
 * Verifies a Handle's EdDSA signature and standard JWT claims (algorithm pinned to `EdDSA` —
 * never trusts a token's own `alg` header, closing the classic alg-confusion hole), validates the
 * decoded claims against `HandleClaimsSchema`, and checks revocation. Returns the validated
 * `HandleClaims` on success; throws `HandleExpired`, `HandleRevoked`, or `HandleInvalid`
 * otherwise — never the raw `jose` error.
 *
 * The signature/claims-shape half delegates to `@nexttime/shared`'s `verifyHandleToken` (S1.7
 * "共享 Handle-token 原语" — the same function `llm-proxy` calls); this function's own job is
 * layering the kernel's revocation check on top and translating the shared module's
 * `HandleTokenExpired`/`HandleTokenInvalid` into this module's pre-existing `HandleExpired`/
 * `HandleInvalid` classes, so every existing caller of `verifyHandle` sees the exact same error
 * types and behavior as before this refactor.
 */
export async function verifyHandle(
  token: string,
  options: VerifyHandleOptions,
): Promise<HandleClaims> {
  let claims: HandleClaims;
  try {
    claims = await verifyHandleToken(token, options.publicKey);
  } catch (err) {
    if (err instanceof HandleTokenExpired) {
      throw new HandleExpired('handle token is expired');
    }
    if (err instanceof HandleTokenInvalid) {
      throw new HandleInvalid('handle token failed signature or claims verification', {
        cause: err,
      });
    }
    throw err;
  }

  if (await options.isRevoked(claims.jti)) {
    throw new HandleRevoked(`handle ${claims.jti} has been revoked`);
  }

  return claims;
}

/**
 * A DB-backed `isRevoked` check for `verifyHandle`: looks up the `capability_handles` row for
 * `jti` and reports revoked if it is missing (fail closed — a `jti` this workspace's
 * `capability_handles` has no record of is never treated as valid) or has `revoked_at` set.
 */
export function createDbRevocationCheck(client: PoolClient): (jti: string) => Promise<boolean> {
  return async (jti: string): Promise<boolean> => {
    const result = await client.query<{ revoked_at: Date | null }>(
      'select revoked_at from capability_handles where jti = $1',
      [jti],
    );
    const row = result.rows[0];
    if (!row) return true;
    return row.revoked_at !== null;
  };
}

// -------------------------------------------------------------------------------------------
// attenuate
// -------------------------------------------------------------------------------------------

export interface AttenuateOptions {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly isRevoked: (jti: string) => Promise<boolean> | boolean;
  /**
   * Child Handle lifetime in seconds. Omit to inherit the parent's exact remaining ttl. If given,
   * must not exceed the parent's remaining ttl (design doc S1.9 task brief: "ttl ≤ parent
   * remaining") — a larger value is an `AttenuationError`, not silently clamped, so a caller never
   * mistakes a request for a longer-lived Handle than it actually got.
   */
  readonly ttlSeconds?: number;
}

/**
 * Verifies `parentToken` (signature, expiry, revocation — the same checks `verifyHandle` makes,
 * since an already-invalid parent can never legitimately produce a child) and issues a child
 * Handle bound to the *same session* as the parent (design doc §5.1.4 "子 Handle 是自身 Handle 的
 * 衰减" — attenuation narrows scope, it does not start a new session), recording `parentJti` as
 * lineage. The child scope must be a subset of the parent's on every axis:
 *
 *   - `capabilities`: every name in `subsetScope.capabilities` must be in the parent's.
 *   - `resources`: for every resource key in `subsetScope.resources`, every id must be in the
 *     parent's ids for that key (a key absent from the parent's `resources` has no ids at all).
 *   - `ttl`: the child's expiry must not exceed the parent's remaining ttl (see `ttlSeconds` doc).
 *
 * Any violation throws `AttenuationError`, never a partially-narrowed Handle.
 */
export async function attenuate(
  client: PoolClient,
  parentToken: string,
  subsetScope: CapabilityScope,
  options: AttenuateOptions,
): Promise<IssuedHandle> {
  assertValidScope(subsetScope);

  const parentClaims = await verifyHandle(parentToken, options);

  const parentCapabilities = new Set(parentClaims.scope.capabilities);
  for (const name of subsetScope.capabilities) {
    if (!parentCapabilities.has(name)) {
      throw new AttenuationError(
        `capability "${name}" is not in the parent handle's scope — attenuation can only narrow`,
      );
    }
  }

  for (const [resourceKey, ids] of Object.entries(subsetScope.resources)) {
    const parentIds = new Set(parentClaims.scope.resources[resourceKey] ?? []);
    for (const id of ids) {
      if (!parentIds.has(id)) {
        throw new AttenuationError(
          `resource "${resourceKey}:${id}" is not in the parent handle's scope — attenuation can only narrow`,
        );
      }
    }
  }

  const parentRemainingSeconds = parentClaims.exp - Math.floor(Date.now() / 1000);
  const ttlSeconds = options.ttlSeconds ?? parentRemainingSeconds;
  if (ttlSeconds > parentRemainingSeconds) {
    throw new AttenuationError(
      `requested ttlSeconds (${ttlSeconds}) exceeds the parent handle's remaining ttl ` +
        `(${parentRemainingSeconds})`,
    );
  }

  return issueHandle(client, {
    sessionId: parentClaims.sid,
    scope: subsetScope,
    ttlSeconds,
    parentJti: parentClaims.jti,
    privateKey: options.privateKey,
  });
}

// -------------------------------------------------------------------------------------------
// revocation
// -------------------------------------------------------------------------------------------

/**
 * Revokes a single Handle by `jti` (idempotent — revoking an already-revoked or unknown `jti` is
 * a no-op, not an error). `jti` values are `randomUUID()`-generated and therefore globally unique
 * regardless of workspace, so no `workspaceId` parameter is needed for correctness; RLS (I1)
 * still confines which row `client`'s transaction can see/update to its own workspace.
 */
export async function revokeHandle(client: PoolClient, jti: string): Promise<void> {
  await client.query(
    'update capability_handles set revoked_at = now() where jti = $1 and revoked_at is null',
    [jti],
  );
}

/**
 * Revokes every Handle issued under a session (docs/development-tasks.md S1.9:
 * "revokeSession(client, sessionId) — all handles of a session").
 */
export async function revokeSession(client: PoolClient, sessionId: string): Promise<void> {
  await client.query(
    'update capability_handles set revoked_at = now() where session_id = $1 and revoked_at is null',
    [sessionId],
  );
}
