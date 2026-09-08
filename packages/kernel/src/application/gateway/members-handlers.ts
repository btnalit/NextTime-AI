import type { PrincipalKind, Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { revokeEntrySessionHandles } from '../../governance/capability/index.js';
import { countGatekeepers } from '../../governance/gatekeepers/index.js';
import { currentPrincipalId } from '../chat/index.js';
import { generateApiKey, hashApiKey } from './auth.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/members-handlers: the S3.11 "成员管理" capabilities (docs/development-
 * tasks.md "中台控制面", 2026-09-08 decision) — `list_principals` / `create_principal` /
 * `set_principal_role` / `rotate_api_key` / `disable_principal` / `get_workspace`. Lives in
 * `application/gateway`, not a new governance module: `principals`/`workspaces` are already this
 * module's own tables (`auth.ts`'s own doc comment — "this module is, in practice, identity's
 * owner"), so a Principal's own membership/credentials are gateway's concern, the same way the
 * human channel's API-key lookup already is.
 *
 * Invariants enforced here (docs/development-tasks.md S3.11's own dispatch):
 *   - `create_principal` always writes `kind='human'` — agent/service principals are created by
 *     the platform itself (`application/task/agent-principal.ts`, `governance/gatekeepers/
 *     service-principal.ts`), never through this capability.
 *   - `set_principal_role`/`rotate_api_key`/`disable_principal` refuse a non-`human` target
 *     (`PrincipalOperationRefusedError`) — rotating/disabling a key that was never issued, or
 *     reassigning a role that was never meaningful (migrations/core/0014's own "role is inert for
 *     an agent principal" note), is nonsensical, not merely unauthorized.
 *   - `set_principal_role`/`disable_principal` refuse ever leaving the workspace with zero active
 *     (`disabled_at is null`) owners — `lockActiveOwnerIds` takes `for update` on every currently-
 *     active owner row first, so two concurrent demote/disable calls against the same last two
 *     owners cannot both read "2 owners remain" and both proceed.
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

/** One class, several reasons (`reason` field) — last-owner protection, self-disable, and
 *  non-human-target all share the same "the request is well-formed but this Principal's current
 *  state forbids it" 409 shape (interfaces/http/capability-route.ts, interfaces/ws/rpc.ts), the
 *  same family `OperationIdentityConflictError`/`IllegalTransition` are already mapped to. */
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

const PRINCIPAL_DETAIL_COLUMNS =
  'id, kind, role, display_name, created_at, worker_definition_id, (api_key_hash is not null) as has_api_key, disabled_at';

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

async function listPrincipalsDetailed(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly PrincipalDetailRow[]> {
  const result = await client.query<PrincipalDetailDbRow>(
    `select ${PRINCIPAL_DETAIL_COLUMNS} from principals where workspace_id = $1 order by created_at asc`,
    [workspaceId],
  );
  return result.rows.map(mapPrincipalDetailRow);
}

async function getPrincipalDetailed(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<PrincipalDetailRow | null> {
  const result = await client.query<PrincipalDetailDbRow>(
    `select ${PRINCIPAL_DETAIL_COLUMNS} from principals where workspace_id = $1 and id = $2`,
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  return row ? mapPrincipalDetailRow(row) : null;
}

/** Every currently-active (`disabled_at is null`) owner's id, `for update` — locks those rows for
 *  the remainder of the caller's transaction so two concurrent demote/disable calls against the
 *  same last two owners cannot both observe "2 remain" and both proceed (see this file's own
 *  module doc comment). `nexttime_app` already holds `update` on `principals`
 *  (migrations/core/0001_identity.sql), which `select ... for update` also requires. */
async function lockActiveOwnerIds(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    `select id from principals
     where workspace_id = $1 and role = 'owner' and disabled_at is null
     for update`,
    [workspaceId],
  );
  return result.rows.map((row) => row.id);
}

/** Refuses (`PrincipalOperationRefusedError`) an operation that would leave `target` — currently
 *  an active owner — as the workspace's last one. A no-op (never queries) for any target that is
 *  not *currently* an active owner: demoting/disabling a non-owner, or re-disabling an
 *  already-disabled owner, can never reduce the active-owner count. */
async function assertNotLastActiveOwner(
  client: PoolClient,
  workspaceId: string,
  target: PrincipalDetailRow,
): Promise<void> {
  if (target.role !== 'owner' || target.disabledAt !== null) return;
  const lockedOwnerIds = await lockActiveOwnerIds(client, workspaceId);
  if (lockedOwnerIds.length <= 1) {
    throw new PrincipalOperationRefusedError(
      'last_owner',
      `cannot leave workspace ${workspaceId} with no active owner — principal ${target.id} is the last one`,
    );
  }
}

function assertHumanTarget(target: PrincipalDetailRow, capability: string): void {
  if (target.kind !== 'human') {
    throw new PrincipalOperationRefusedError(
      'not_human',
      `${capability}: principal ${target.id} is kind="${target.kind}", not a human Principal`,
    );
  }
}

// -------------------------------------------------------------------------------------------
// Wire projection (docs/wire-contract-conventions.md §2 — one projection function, application
// layer): `id`, never a duplicated `principalId`; `*At` fields as ISO strings; never
// `api_key_hash` itself, only the derived `hasApiKey` boolean.
// -------------------------------------------------------------------------------------------

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
  };
}

// -------------------------------------------------------------------------------------------
// Capability handlers
// -------------------------------------------------------------------------------------------

export const listPrincipalsHandler: CapabilityHandler = async (client, workspaceId) => {
  const rows = await listPrincipalsDetailed(client, workspaceId);
  return { result: { items: rows.map(toWirePrincipal) } };
};

const CreatePrincipalParams = (params: unknown) => params as { role: Role; displayName: string };

/** `create_principal`: always `kind='human'` (see this file's module doc). The plaintext
 *  `apiKey` is returned in the *result* only — `application/gateway/dispatch.ts` audits `params`
 *  (role/displayName), never `result`, so the key never reaches `audit_records` either. */
export const createPrincipalHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { role, displayName } = CreatePrincipalParams(params);
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  const inserted = await client.query<{ id: string; created_at: Date }>(
    `insert into principals (workspace_id, kind, role, display_name, api_key_hash)
     values ($1, 'human', $2, $3, $4)
     returning id, created_at`,
    [workspaceId, role, displayName, apiKeyHash],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('create_principal: INSERT ... RETURNING produced no row');

  const principal: PrincipalDetailRow = {
    id: row.id,
    kind: 'human',
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

export const setPrincipalRoleHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { principalId, role } = SetPrincipalRoleParams(params);
  const target = await getPrincipalDetailed(client, workspaceId, principalId);
  if (!target) throw new PrincipalNotFoundError(workspaceId, principalId);
  assertHumanTarget(target, 'set_principal_role');

  if (target.role === 'owner' && role !== 'owner') {
    await assertNotLastActiveOwner(client, workspaceId, target);
  }

  const updated = await client.query<{ id: string }>(
    'update principals set role = $1 where workspace_id = $2 and id = $3 returning id',
    [role, workspaceId, principalId],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PrincipalNotFoundError(workspaceId, principalId);
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
  assertHumanTarget(target, 'rotate_api_key');

  const apiKey = generateApiKey();
  await client.query(
    'update principals set api_key_hash = $1 where workspace_id = $2 and id = $3',
    [hashApiKey(apiKey), workspaceId, principalId],
  );

  return {
    result: { principalId, apiKey },
    resourceType: 'principal',
    resourceId: principalId,
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
  assertHumanTarget(target, 'disable_principal');
  await assertNotLastActiveOwner(client, workspaceId, target);

  const disabled = await client.query<{ disabled_at: Date }>(
    `update principals set disabled_at = coalesce(disabled_at, now())
     where workspace_id = $1 and id = $2
     returning disabled_at`,
    [workspaceId, principalId],
  );
  const disabledRow = disabled.rows[0];
  if (!disabledRow) throw new PrincipalNotFoundError(workspaceId, principalId);

  // Existing service path grant changes already use (governance/capability/handles.ts) — revokes
  // every Handle issued under this principal's own kind='entry' session(s), and (belt/suspenders)
  // application/gateway/handle-auth.ts additionally rejects any Handle, of any session kind,
  // whose on_behalf_of principal is disabled — see that module's own doc comment.
  await revokeEntrySessionHandles(client, workspaceId, principalId);

  const wire = toWirePrincipal({ ...target, disabledAt: disabledRow.disabled_at });
  return { result: wire, resourceType: 'principal', resourceId: principalId };
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
