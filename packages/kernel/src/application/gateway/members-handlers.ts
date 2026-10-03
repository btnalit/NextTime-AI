import type { PrincipalKind, Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  revokeOnBehalfOfSessionHandles,
  revokeRoleScopedSessionHandles,
} from '../../governance/capability/index.js';
import { countGatekeepers } from '../../governance/gatekeepers/index.js';
import { currentPrincipalId } from '../chat/index.js';
import { generateApiKey, hashApiKey, isLastActiveHumanOwner } from './auth.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { publishSessionKick } from './session-revocation.js';

/**
 * application/gateway/members-handlers: the S3.11 "成员管理" capabilities (docs/development-
 * tasks.md "中台控制面", 2026-09-08 decision) — `list_principals` / `create_principal` /
 * `set_principal_role` / `rotate_api_key` / `disable_principal` / `get_workspace`. Lives in
 * `application/gateway`, not a new governance module: `principals`/`workspaces` are already this
 * module's own tables (`auth.ts`'s own doc comment — "this module is, in practice, identity's
 * owner"), so a Principal's own membership/credentials are gateway's concern, the same way the
 * human channel's API-key lookup already is.
 *
 * Invariants enforced here (docs/development-tasks.md S3.11's own dispatch; review 2026-10-02
 * R-06, maintainer decision D-05):
 *   - `create_principal` always writes `kind='service'` (P-A1) — an automation credential with an
 *     API key; people join through `add_member` (`kind='human'`, no key). Agent Principals and the
 *     platform's own internal service Principals are created by the platform itself
 *     (`application/task/agent-principal.ts`, `governance/gatekeepers/service-principal.ts`,
 *     `application/worker/draft-lifecycle.ts`), never through a capability — so
 *     `create_principal` refuses the reserved `__…__` display name those internal ones carry.
 *   - `set_principal_role`/`rotate_api_key`/`disable_principal` manage `human` and `service`
 *     Principals alike — a leaked service key can always be disabled, re-keyed or re-roled from
 *     the workspace. They refuse an `agent` Principal or an internal service Principal
 *     (`PrincipalOperationRefusedError` `platform_managed`): an agent's role is inert
 *     (migrations/core/0014) and it holds no key; an internal one is platform plumbing.
 *   - A workspace always keeps at least one active (`disabled_at is null`) **human** owner; a
 *     service Principal never counts toward it, whatever its role. `isLastActiveHumanOwner`
 *     (auth.ts, identity's owner) is the one predicate for it — `set_principal_role`/
 *     `disable_principal` here and the platform plane's `set_membership_role`/`remove_membership`
 *     (platform-handlers.ts) all call it — and it takes `for update` on every active human owner
 *     row first, so two concurrent demote/disable calls against the same last two owners cannot
 *     both read "2 owners remain" and both proceed.
 *   - `disable_principal` additionally refuses disabling the caller's own principal.
 *   - `rotate_api_key`'s registry `minRole` is `'member'` (anyone may rotate their own key); this
 *     handler is what actually enforces "owner, or the caller's own id" — the same "minRole gates
 *     entry, the handler narrows further" shape `set_auto_approved_action_kind` (handlers.ts)
 *     already established for I14.
 */

export class PrincipalNotFoundError extends Error {
  constructor(workspaceId: string, principalId: string) {
    super(`Principal not found: workspace ${workspaceId}, id ${principalId}`);
    this.name = 'PrincipalNotFoundError';
  }
}

/** One class, several reasons (`reason` field) — last-owner protection, self-disable, a
 *  platform-managed target and a reserved display name all share the same "the request is
 *  well-formed but this Principal's current state forbids it" 409 shape (interfaces/http/
 *  capability-route.ts, interfaces/ws/rpc.ts), the same family `OperationIdentityConflictError`/
 *  `IllegalTransition` are already mapped to. */
export class PrincipalOperationRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PrincipalOperationRefusedError';
    this.reason = reason;
  }
}

// -------------------------------------------------------------------------------------------
// Row reads/writes — this module's own queries against `principals` (see this file's module doc).
// -------------------------------------------------------------------------------------------

export interface PrincipalDetailRow {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly role: Role;
  readonly displayName: string | null;
  readonly createdAt: Date;
  readonly workerDefinitionId: string | null;
  readonly hasApiKey: boolean;
  readonly disabledAt: Date | null;
}

interface PrincipalDetailDbRow {
  id: string;
  kind: string;
  role: string;
  display_name: string | null;
  created_at: Date;
  worker_definition_id: string | null;
  has_api_key: boolean;
  disabled_at: Date | null;
}

// S8 W4 (audit S15 "同一个人三个名字"): a human Principal's own `display_name` column is only the
// snapshot `add_member` copied from `users.display_name` at membership time (members-handlers.ts's
// own `addMemberHandler`) — a later `PATCH /api/auth/me` rename updates `users` only, so every
// workspace membership created before the rename keeps showing the stale copy while the Sidebar
// (which reads the live `users.display_name` via the console-session channel, `resolve-caller.ts`'s
// `resolveConsoleUser`) already shows the new one. `left join users` + `coalesce` makes this read
// agree with that live value for every linked (human) Principal, falling back to the stored column
// only for a Principal with no `user_id` (service/agent kind, or a legacy row never linked) — the
// exact join migration 0021's own `users_workspace_members` RLS policy comment anticipated
// ("A workspace transaction may read the users who are members of *its* workspace — the members
// page shows login / display name").
const PRINCIPAL_DETAIL_COLUMNS =
  'p.id, p.kind, p.role, coalesce(u.display_name, p.display_name) as display_name, p.created_at, p.worker_definition_id, (p.api_key_hash is not null) as has_api_key, p.disabled_at';

const PRINCIPAL_DETAIL_FROM = 'principals p left join users u on u.id = p.user_id';

function mapPrincipalDetailRow(row: PrincipalDetailDbRow): PrincipalDetailRow {
  return {
    id: row.id,
    kind: row.kind as PrincipalKind,
    role: row.role as Role,
    displayName: row.display_name,
    createdAt: row.created_at,
    workerDefinitionId: row.worker_definition_id,
    hasApiKey: row.has_api_key,
    disabledAt: row.disabled_at,
  };
}

// -------------------------------------------------------------------------------------------
// S8 W1-C (selector data source, F6 item 3 + leftover 48 pagination list): `list_principals`
// keyset cursor — same `(date_trunc('milliseconds', created_at), id)` shape
// docs/wire-contract-conventions.md §3 names, one private copy per list (this codebase's own
// established convention — `governance/approval/reads.ts`'s own doc comment: "a fourth private
// copy, deliberately"). `DEFAULT_LIST_PRINCIPALS_LIMIT` is chosen generously so a workspace with
// today's realistic member counts still gets every row with no `limit` — the same "no `limit` →
// unchanged behavior" contract every other list in this task carries.
// -------------------------------------------------------------------------------------------
export const DEFAULT_LIST_PRINCIPALS_LIMIT = 100;
export const MAX_LIST_PRINCIPALS_LIMIT = 500;

const PRINCIPAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeListPrincipalsCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeListPrincipalsCursor(
  cursor: string | undefined,
): { readonly createdAt: string; readonly id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const createdAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !PRINCIPAL_UUID_PATTERN.test(id)) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface ListPrincipalsFilter {
  /** Case-insensitive substring on `display_name`; a principal with no display name never
   *  matches a non-empty `q`. */
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListPrincipalsPage {
  readonly items: readonly PrincipalDetailRow[];
  readonly nextCursor?: string;
  readonly truncated?: true;
}

async function listPrincipalsDetailed(
  client: PoolClient,
  workspaceId: string,
  filter: ListPrincipalsFilter = {},
): Promise<ListPrincipalsPage> {
  const requestedLimit = filter.limit ?? DEFAULT_LIST_PRINCIPALS_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIST_PRINCIPALS_LIMIT);
  const cursor = decodeListPrincipalsCursor(filter.cursor);

  // Ascending (oldest first, `>` past the cursor) — deliberately the opposite direction of this
  // task's other new cursors: `listPrincipalsDetailed` returned `order by created_at asc` before
  // this change, and the console's Members/Access pages (`packages/web/src/components/
  // MembersPage.tsx`/`AccessPage.tsx`) render that order as-is with no client-side re-sort — a
  // `desc` default here would silently reorder those tables for every existing caller that still
  // passes no `limit`/`cursor`. Over-fetch by one: a (limit + 1)th row proves there is a next page
  // without a second query (same convention `governance/approval/reads.ts`'s
  // `listActionRequestsForApprover` uses).
  const result = await client.query<PrincipalDetailDbRow>(
    `select ${PRINCIPAL_DETAIL_COLUMNS} from ${PRINCIPAL_DETAIL_FROM}
     where p.workspace_id = $1
       and ($2::text is null or coalesce(u.display_name, p.display_name) ilike '%' || $2 || '%')
       and (
         $3::timestamptz is null
         or (date_trunc('milliseconds', p.created_at), p.id) > ($3::timestamptz, $4::uuid)
       )
     order by date_trunc('milliseconds', p.created_at) asc, p.id asc
     limit $5`,
    [workspaceId, filter.q ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );

  const rows = result.rows.slice(0, limit).map(mapPrincipalDetailRow);
  const last = rows[rows.length - 1];
  const nextCursor =
    result.rows.length > limit && last
      ? encodeListPrincipalsCursor(last.createdAt, last.id)
      : undefined;
  const truncated = requestedLimit > MAX_LIST_PRINCIPALS_LIMIT ? (true as const) : undefined;
  return {
    items: rows,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

async function getPrincipalDetailed(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<PrincipalDetailRow | null> {
  const result = await client.query<PrincipalDetailDbRow>(
    `select ${PRINCIPAL_DETAIL_COLUMNS} from ${PRINCIPAL_DETAIL_FROM} where p.workspace_id = $1 and p.id = $2`,
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  return row ? mapPrincipalDetailRow(row) : null;
}

/** Refuses (`PrincipalOperationRefusedError` `last_owner`) demoting or disabling `target` when
 *  it is the workspace's last active human owner ({@link isLastActiveHumanOwner}). Never queries
 *  for a target that is not currently an active human owner (the common case) — a service or
 *  non-owner target, or an already-disabled owner, can never reduce the count. */
async function assertNotLastActiveHumanOwner(
  client: PoolClient,
  workspaceId: string,
  target: PrincipalDetailRow,
): Promise<void> {
  if (target.kind !== 'human' || target.role !== 'owner' || target.disabledAt !== null) return;
  if (await isLastActiveHumanOwner(client, workspaceId, target.id)) {
    throw new PrincipalOperationRefusedError(
      'last_owner',
      `cannot leave workspace ${workspaceId} with no active human owner — principal ${target.id} is the last one`,
    );
  }
}

/** R-06 (D-05): `set_principal_role`/`rotate_api_key`/`disable_principal` take a `human` or a
 *  `service` target and refuse the platform's own identities — a Worker's `agent` Principal, or
 *  an internal service Principal ({@link isInternalPrincipal}). */
function assertManageableTarget(target: PrincipalDetailRow, capability: string): void {
  if (target.kind === 'agent' || isInternalPrincipal(target)) {
    throw new PrincipalOperationRefusedError(
      'platform_managed',
      `${capability}: principal ${target.id} is managed by the platform (kind="${target.kind}"), not from a workspace`,
    );
  }
}

// -------------------------------------------------------------------------------------------
// Wire projection (docs/wire-contract-conventions.md §2 — one projection function, application
// layer): `id`, never a duplicated `principalId`; `*At` fields as ISO strings; never
// `api_key_hash` itself, only the derived `hasApiKey` boolean.
// -------------------------------------------------------------------------------------------

// S8 W4 (leftover 88 "内部服务主体与普通服务主体混在一起"): every internal service Principal this
// platform creates for itself uses a `display_name` wrapped in double underscores
// (`__gatekeeper_service__`, `governance/gatekeepers/service-principal.ts`; `__draft_reaper__`,
// `application/worker/draft-lifecycle.ts`) — a name `create_principal` refuses (R-06). Derived
// once, here, in the wire projection every reader shares (`list_principals`/`create_principal`/
// `set_principal_role`/`rotate_api_key`/`disable_principal`) rather than each web consumer
// re-deriving its own guess from a hardcoded name list — the kernel is the single source of truth
// for "is this principal internal". R-06: `kind='service'` only — a person's display name is
// their own (`PATCH /api/auth/me`), and a person renamed `__…__` must neither drop off the Members
// page nor become unmanageable through `assertManageableTarget`.
const INTERNAL_PRINCIPAL_DISPLAY_NAME_PATTERN = /^__.+__$/;

export function isInternalPrincipalDisplayName(displayName: string | null): boolean {
  return displayName !== null && INTERNAL_PRINCIPAL_DISPLAY_NAME_PATTERN.test(displayName);
}

function isInternalPrincipal(row: Pick<PrincipalDetailRow, 'kind' | 'displayName'>): boolean {
  return row.kind === 'service' && isInternalPrincipalDisplayName(row.displayName);
}

function toWirePrincipal(row: PrincipalDetailRow) {
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    ...(row.workerDefinitionId !== null ? { workerDefinitionId: row.workerDefinitionId } : {}),
    hasApiKey: row.hasApiKey,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    internal: isInternalPrincipal(row),
  };
}

// -------------------------------------------------------------------------------------------
// Capability handlers
// -------------------------------------------------------------------------------------------

export const listPrincipalsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { q, limit, cursor } = params as { q?: string; limit?: number; cursor?: string };
  const page = await listPrincipalsDetailed(client, workspaceId, { q, limit, cursor });
  return {
    result: {
      items: page.items.map(toWirePrincipal),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
    },
  };
};

const CreatePrincipalParams = (params: unknown) => params as { role: Role; displayName: string };

/** `create_principal`: always `kind='service'` (see this file's module doc). The plaintext
 *  `apiKey` is returned in the *result* only — `application/gateway/dispatch.ts` audits `params`
 *  (role/displayName), never `result`, so the key never reaches `audit_records` either. */
export const createPrincipalHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { role, displayName } = CreatePrincipalParams(params);
  // R-06: an `__…__` name would make this key read as internal — hidden from the Members page
  // and refused by `assertManageableTarget`, i.e. a credential nobody could disable from the
  // workspace.
  if (isInternalPrincipalDisplayName(displayName)) {
    throw new PrincipalOperationRefusedError(
      'reserved_name',
      `create_principal: display name "${displayName}" is reserved for the platform's internal Principals`,
    );
  }
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  // P-A1 (docs/platform-admin-design.md §5): people are memberships of platform users
  // (`add_member` in the workspace, `add_membership` on the platform) — `create_principal` now
  // mints a `service` Principal, the automation credential (scripts, acceptance harnesses,
  // external runtimes). Migration 0021 put `users` behind RLS with no INSERT policy for a
  // workspace transaction, so the pre-P-A1 "human Principal + passwordless user" path is gone.
  const inserted = await client.query<{ id: string; created_at: Date }>(
    `insert into principals (workspace_id, kind, role, display_name, api_key_hash)
     values ($1, 'service', $2, $3, $4)
     returning id, created_at`,
    [workspaceId, role, displayName, apiKeyHash],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('create_principal: INSERT ... RETURNING produced no row');

  const principal: PrincipalDetailRow = {
    id: row.id,
    kind: 'service',
    role,
    displayName,
    createdAt: row.created_at,
    workerDefinitionId: null,
    hasApiKey: true,
    disabledAt: null,
  };

  return {
    result: { principal: toWirePrincipal(principal), apiKey },
    resourceType: 'principal',
    resourceId: row.id,
  };
};

const SetPrincipalRoleParams = (params: unknown) => params as { principalId: string; role: Role };

/**
 * `add_member` (P-A1, docs/platform-admin-design.md §5 "工作区配置里的成员页语义变为从平台用户中添加"):
 * an owner adds an existing platform user to this workspace by login. The lookup goes through
 * `lookup_user_by_login` (migration 0021, `security definer`) because a workspace transaction
 * may otherwise only see users who are *already* members (`users_workspace_members` policy);
 * the function returns id / display name / status and nothing else. The membership Principal
 * carries no API key — it is a person, not an automation credential.
 */
export const addMemberHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { login, role } = params as { login: string; role: Role };
  const found = await client.query<{ id: string; display_name: string; status: string }>(
    'select id, display_name, status from lookup_user_by_login($1)',
    [login.trim().toLowerCase()],
  );
  const user = found.rows[0];
  if (!user) throw new MemberUserNotFoundError(login);
  if (user.status !== 'active') throw new MemberUserNotFoundError(login);
  const existing = await client.query(
    `select 1 from principals where workspace_id = $1 and user_id = $2 and kind = 'human'`,
    [workspaceId, user.id],
  );
  if ((existing.rowCount ?? 0) > 0) throw new AlreadyMemberError(login);
  const inserted = await client.query<{ id: string; created_at: Date }>(
    `insert into principals (workspace_id, kind, role, display_name, user_id)
     values ($1, 'human', $2, $3, $4)
     returning id, created_at`,
    [workspaceId, role, user.display_name, user.id],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('add_member: INSERT ... RETURNING produced no row');
  const principal: PrincipalDetailRow = {
    id: row.id,
    kind: 'human',
    role,
    displayName: user.display_name,
    createdAt: row.created_at,
    workerDefinitionId: null,
    hasApiKey: false,
    disabledAt: null,
  };
  return { result: toWirePrincipal(principal), resourceType: 'principal', resourceId: row.id };
};

export class MemberUserNotFoundError extends Error {
  constructor(login: string) {
    super(`no active platform user with login "${login}"`);
    this.name = 'MemberUserNotFoundError';
  }
}

export class AlreadyMemberError extends Error {
  constructor(login: string) {
    super(`"${login}" is already a member of this workspace`);
    this.name = 'AlreadyMemberError';
  }
}

export const setPrincipalRoleHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { principalId, role } = SetPrincipalRoleParams(params);
  const target = await getPrincipalDetailed(client, workspaceId, principalId);
  if (!target) throw new PrincipalNotFoundError(workspaceId, principalId);
  assertManageableTarget(target, 'set_principal_role');

  if (target.role === 'owner' && role !== 'owner') {
    await assertNotLastActiveHumanOwner(client, workspaceId, target);
  }

  const updated = await client.query<{ id: string }>(
    'update principals set role = $1 where workspace_id = $2 and id = $3 returning id',
    [role, workspaceId, principalId],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PrincipalNotFoundError(workspaceId, principalId);
  }

  // W5.5 (STATUS leftover 18): a Handle's ceiling is narrowed by role at issuance
  // (`entryScope({ role })`), so a role change must invalidate every Handle issued under the old
  // role — the resident entry agent's *and* any `issue_handle` `mcp_session` ones (which can carry
  // a ttl of up to 30 days) — otherwise a demoted member keeps builder-gated `propose_*` until ttl,
  // and a promoted one waits for it. The agent-host runtime's in-memory cache re-checks its cached
  // Handle's revocation on the next Turn and reissues on its own.
  if (role !== target.role) {
    await revokeRoleScopedSessionHandles(client, workspaceId, principalId);
  }

  const wire = toWirePrincipal({ ...target, role });
  return { result: wire, resourceType: 'principal', resourceId: principalId };
};

const RotateApiKeyParams = (params: unknown) => params as { principalId: string };

export const rotateApiKeyHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { principalId } = RotateApiKeyParams(params);
  const callerId = ctx?.principalId ?? (await currentPrincipalId(client));

  if (callerId !== principalId) {
    const caller = await getPrincipalDetailed(client, workspaceId, callerId);
    if (!caller || caller.role !== 'owner') {
      throw new ForbiddenError(
        `rotate_api_key: only an owner may rotate another principal's API key`,
      );
    }
  }

  const target = await getPrincipalDetailed(client, workspaceId, principalId);
  if (!target) throw new PrincipalNotFoundError(workspaceId, principalId);
  assertManageableTarget(target, 'rotate_api_key');

  const apiKey = generateApiKey();
  await client.query(
    'update principals set api_key_hash = $1 where workspace_id = $2 and id = $3',
    [hashApiKey(apiKey), workspaceId, principalId],
  );

  const result = { principalId, apiKey };
  return {
    result,
    resourceType: 'principal',
    resourceId: principalId,
    // R-06: the old key stops resolving at once (`lookupPrincipalByApiKeyHash`), but a `/ws`
    // socket authenticates only at connect — so when someone else re-keys a service credential,
    // its open sockets (every one of them rode the old key) close too
    // (application/gateway/session-revocation.ts). Not for a person: their console sockets ride
    // the cookie, not the key, and a principal kick would close those as well. Not on
    // self-rotation either: the socket asking may be the one waiting for the new key.
    ...(target.kind === 'service' && callerId !== principalId
      ? {
          afterCommit: async () => {
            publishSessionKick({ principalIds: [principalId] });
            return result;
          },
        }
      : {}),
  };
};

const DisablePrincipalParams = (params: unknown) => params as { principalId: string };

export const disablePrincipalHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { principalId } = DisablePrincipalParams(params);
  const callerId = ctx?.principalId ?? (await currentPrincipalId(client));

  if (callerId === principalId) {
    throw new PrincipalOperationRefusedError(
      'self_disable',
      'disable_principal: refusing to disable the calling principal itself',
    );
  }

  const target = await getPrincipalDetailed(client, workspaceId, principalId);
  if (!target) throw new PrincipalNotFoundError(workspaceId, principalId);
  assertManageableTarget(target, 'disable_principal');
  await assertNotLastActiveHumanOwner(client, workspaceId, target);

  const disabled = await client.query<{ disabled_at: Date }>(
    `update principals set disabled_at = coalesce(disabled_at, now())
     where workspace_id = $1 and id = $2
     returning disabled_at`,
    [workspaceId, principalId],
  );
  const disabledRow = disabled.rows[0];
  if (!disabledRow) throw new PrincipalNotFoundError(workspaceId, principalId);

  // R-05: revokes every Handle issued under any session on this principal's behalf — entry,
  // mcp_session and worker_run (governance/capability/handles.ts), so a running Worker loses its
  // LLM access too; for a service Principal (R-06) also `issue_service_handle`'s `service`
  // sessions — and (belt/suspenders) application/gateway/handle-auth.ts additionally
  // rejects any Handle whose on_behalf_of principal is disabled — see that module's own doc
  // comment.
  await revokeOnBehalfOfSessionHandles(client, workspaceId, principalId);

  const wire = toWirePrincipal({ ...target, disabledAt: disabledRow.disabled_at });
  return {
    result: wire,
    resourceType: 'principal',
    resourceId: principalId,
    // R-05: once committed, the principal's open /ws sockets close and stop receiving pushes
    // (application/gateway/session-revocation.ts) instead of at their next call.
    afterCommit: async () => {
      publishSessionKick({ principalIds: [principalId] });
      return wire;
    },
  };
};

// -------------------------------------------------------------------------------------------
// get_workspace
// -------------------------------------------------------------------------------------------

/**
 * `caller` (coordinator addition, 2026-09-08): the resolved calling Principal's own identity —
 * the web console has no other capability that answers "who am I / what's my role", and was
 * inferring it indirectly from which capabilities come back `403 forbidden` (a real usability
 * gap, not a hypothetical). Projected straight from `ctx.principal`
 * (`application/gateway/dispatch.ts`'s own `resolve-caller.ts`-resolved `PrincipalRow`, threaded
 * through purely additively — `capability-handler.ts`'s own doc comment) — never a second query
 * by API key. Always present in production: `get_workspace` is `channel:'human'`-only
 * (packages/shared/src/capabilities.ts), and `dispatchCapability` supplies `ctx.principal` for
 * every human-channel call.
 */
export const getWorkspaceHandler: CapabilityHandler = async (client, workspaceId, _params, ctx) => {
  if (!ctx?.principal) {
    throw new Error(
      'get_workspace: no resolved human principal in context (this capability is channel:"human"-only)',
    );
  }

  const workspaceResult = await client.query<{ id: string; name: string; created_at: Date }>(
    'select id, name, created_at from workspaces where id = $1',
    [workspaceId],
  );
  const workspaceRow = workspaceResult.rows[0];
  if (!workspaceRow) {
    throw new Error(`get_workspace: workspace ${workspaceId} not found for its own caller`);
  }

  const principalCountResult = await client.query<{ count: string }>(
    'select count(*)::bigint as count from principals where workspace_id = $1',
    [workspaceId],
  );
  const principalCount = Number(principalCountResult.rows[0]?.count ?? 0);
  const gatekeeperCount = await countGatekeepers(client, workspaceId);

  return {
    result: {
      id: workspaceRow.id,
      name: workspaceRow.name,
      createdAt: workspaceRow.created_at.toISOString(),
      principalCount,
      gatekeeperCount,
      caller: {
        id: ctx.principal.id,
        role: ctx.principal.role,
        displayName: ctx.principal.displayName,
        kind: ctx.principal.kind,
      },
    },
    resourceType: 'workspace',
    resourceId: workspaceRow.id,
  };
};
