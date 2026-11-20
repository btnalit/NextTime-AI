import type {
  HandleWire,
  PrincipalKind,
  RevokeHandleResultWire,
  SessionKind,
} from '@nexttime/shared';
import {
  CONTAINER_HELD_SESSION_KINDS,
  holderForSessionKind,
  lockSessions,
} from '../../governance/capability/index.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';

/**
 * application/gateway/handles-handlers (legacy 168): `list_handles` and `revoke_handle` — the
 * Handles a person holds, and ending one a client holds.
 *
 * Who sees what. Every Handle acting for the caller (`on_behalf_of` is the caller's Principal,
 * I13): their entry agent's, their Workers', their admin agent's (container-held) and the MCP
 * sessions they issued (bearer). A workspace owner also sees the Handles of the workspace's
 * service Principals — the ones they issue with `issue_service_handle`. Never another member's:
 * a member's MCP sessions are theirs, and seeing someone's container Handles serves nothing.
 *
 * Ending one. Only a bearer Handle, and only by ending its session the way the platform ends an
 * external runtime (`revokeExternalRuntime`): the session is revoked and every Handle issued
 * under it with it. A container-held Handle ends with its conversation or Task (the entry
 * session's rotation, the WorkerRun's end); the platform holds it, so no client has it to lose,
 * and ending it here would only break a running Turn or Task — 409 `handle_container_held`.
 */

export type HandleRevokeErrorCode = 'handle_not_found' | 'handle_container_held';

/** A refused `revoke_handle`: its wire code and status (interfaces/http/capability-route,
 *  interfaces/ws/rpc). */
export class HandleRevokeError extends Error {
  readonly code: HandleRevokeErrorCode;
  readonly status: 404 | 409;
  constructor(code: HandleRevokeErrorCode, message: string) {
    super(message);
    this.name = 'HandleRevokeError';
    this.code = code;
    this.status = code === 'handle_not_found' ? 404 : 409;
  }
}

export const DEFAULT_LIST_HANDLES_LIMIT = 100;
export const MAX_LIST_HANDLES_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keyset cursor on `(date_trunc('milliseconds', created_at), jti)`, newest first — the shape
 *  `list_tasks` uses. A cursor that does not decode reads from the start. */
function encodeCursor(issuedAt: Date, jti: string): string {
  return Buffer.from(`${issuedAt.toISOString()}|${jti}`, 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
): { readonly issuedAt: string; readonly jti: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) return null;
  const issuedAt = decoded.slice(0, sep);
  const jti = decoded.slice(sep + 1);
  if (!issuedAt || Number.isNaN(Date.parse(issuedAt)) || !UUID_PATTERN.test(jti)) return null;
  return { issuedAt, jti };
}

interface HandleRow {
  jti: string;
  session_id: string;
  session_kind: SessionKind;
  on_behalf_of: string;
  principal_kind: PrincipalKind;
  display_name: string | null;
  created_at: Date;
  expires_at: Date;
  scope: { capabilities?: unknown };
}

/** The visibility rule above, as SQL over `capability_handles h` / `sessions s` / `principals p`:
 *  live (unrevoked, unexpired, its session not revoked) and acting for `$2`, or — when `$3` (the
 *  caller is an owner) — for a service Principal. */
const VISIBLE_HANDLE = `
  h.workspace_id = $1 and h.revoked_at is null and h.expires_at > now()
  and s.status <> 'revoked'
  and (h.on_behalf_of = $2 or ($3::boolean and p.kind = 'service'))`;

const HANDLE_FROM = `
  from capability_handles h
  join sessions s on s.workspace_id = h.workspace_id and s.id = h.session_id
  join principals p on p.workspace_id = h.workspace_id and p.id = h.on_behalf_of`;

function capabilitiesOf(scope: HandleRow['scope']): string[] {
  const listed = scope?.capabilities;
  return Array.isArray(listed) ? listed.filter((name) => typeof name === 'string') : [];
}

function toWireHandle(row: HandleRow): HandleWire {
  const holder = holderForSessionKind(row.session_kind);
  return {
    jti: row.jti,
    sessionId: row.session_id,
    sessionKind: row.session_kind,
    holder,
    onBehalfOf: row.on_behalf_of,
    onBehalfOfKind: row.principal_kind,
    onBehalfOfName: row.display_name,
    issuedAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    capabilities: capabilitiesOf(row.scope),
    // Every Handle the caller sees here is one they may end, when a client holds it.
    revocable: holder === 'bearer',
  };
}

/** The calling Principal and whether it is an owner — the two inputs of the visibility rule. */
function caller(ctx: CapabilityHandlerContext | undefined): {
  readonly principalId: string;
  readonly owner: boolean;
} {
  if (!ctx?.principal) {
    throw new Error('handles handler invoked without a resolved Principal (channel:"human" only)');
  }
  return { principalId: ctx.principal.id, owner: ctx.principal.role === 'owner' };
}

export const listHandlesHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const input = params as { limit?: number; cursor?: string };
  const { principalId, owner } = caller(ctx);
  const requested = input.limit ?? DEFAULT_LIST_HANDLES_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIST_HANDLES_LIMIT);
  const cursor = decodeCursor(input.cursor);
  const result = await client.query<HandleRow>(
    `select h.jti, h.session_id, s.kind as session_kind, h.on_behalf_of,
            p.kind as principal_kind, p.display_name, h.created_at, h.expires_at, h.scope
     ${HANDLE_FROM}
     where ${VISIBLE_HANDLE}
       and ($4::timestamptz is null
            or (date_trunc('milliseconds', h.created_at), h.jti) < ($4::timestamptz, $5::uuid))
     order by date_trunc('milliseconds', h.created_at) desc, h.jti desc
     limit $6`,
    [workspaceId, principalId, owner, cursor?.issuedAt ?? null, cursor?.jti ?? null, limit + 1],
  );
  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const nextCursor =
    result.rows.length > limit && last ? encodeCursor(last.created_at, last.jti) : undefined;
  return {
    result: {
      items: rows.map(toWireHandle),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(requested > MAX_LIST_HANDLES_LIMIT ? { truncated: true as const } : {}),
    },
  };
};

export const revokeHandleHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const input = params as { jti: string };
  const { principalId, owner } = caller(ctx);
  const found = await client.query<{
    session_id: string;
    session_kind: SessionKind;
    on_behalf_of: string;
  }>(
    `select h.session_id, s.kind as session_kind, h.on_behalf_of
     ${HANDLE_FROM}
     where ${VISIBLE_HANDLE} and h.jti = $4::uuid`,
    [workspaceId, principalId, owner, input.jti],
  );
  const handle = found.rows[0];
  if (!handle) {
    throw new HandleRevokeError(
      'handle_not_found',
      'no live Handle of yours (or, for an owner, of a service Principal) has this id',
    );
  }
  if (CONTAINER_HELD_SESSION_KINDS.has(handle.session_kind)) {
    throw new HandleRevokeError(
      'handle_container_held',
      'this Handle is held by the platform for an agent and ends with its conversation or Task — stop the Task or the conversation instead',
    );
  }

  // Lock order (governance/capability/handles.ts): the session row, then its Handles. What ends
  // with it is counted under that lock: governance 0042's trigger revokes exactly the session's
  // live Handles when the UPDATE below marks it revoked.
  await lockSessions(client, [handle.session_id]);
  const live = await client.query<{ n: string }>(
    `select count(*)::text as n from capability_handles
      where workspace_id = $1 and session_id = $2 and revoked_at is null and expires_at > now()`,
    [workspaceId, handle.session_id],
  );
  const ended = await client.query(
    `update sessions set status = 'revoked', expires_at = now()
      where workspace_id = $1 and id = $2 and status <> 'revoked'`,
    [workspaceId, handle.session_id],
  );
  if ((ended.rowCount ?? 0) === 0) {
    // A revoker that came first (it held the session row): its revocation already ended this one.
    throw new HandleRevokeError('handle_not_found', 'this Handle was revoked meanwhile');
  }
  const revokedHandleCount = Number(live.rows[0]?.n ?? 0);

  const result: RevokeHandleResultWire = {
    jti: input.jti,
    sessionId: handle.session_id,
    sessionKind: handle.session_kind,
    revokedHandleCount,
  };
  return {
    result,
    resourceType: 'session',
    resourceId: handle.session_id,
    auditPayload: {
      sessionKind: handle.session_kind,
      onBehalfOf: handle.on_behalf_of,
      revokedHandleCount,
    },
  };
};
