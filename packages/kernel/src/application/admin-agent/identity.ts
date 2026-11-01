import type { Role } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import {
  ADMIN_AGENT_SESSION_KIND,
  type IssuedHandle,
  adminAgentScope,
  issueHandle,
} from '../../governance/capability/index.js';
import { type PlatformRole, effectivePlatformRole } from '../identity/users.js';

/**
 * application/admin-agent/identity (S11 AA1; docs/goal-orchestration-and-admin-agent-plan-
 * 2026-10-16.md §5.2, §5.7, I-A1–I-A3): who an admin agent acts as, and the check that its power
 * follows its person.
 *
 * An admin agent is a platform administrator's agent in one workspace. It has no Principal of its
 * own: its session (`kind = 'admin_agent'`, migration core 0049) belongs to the administrator's
 * human Principal in that workspace, as an entry session belongs to its person — the platform
 * user is that Principal's `user_id`, never stored a second time. What it may call is the code
 * constant `ADMIN_AGENT_CEILING_CAPABILITIES` (governance/capability/handles.ts), narrowed by the
 * administrator's role in the workspace; its Handles are container-held (source-bound, I19), never
 * an API key and never a service Principal's (I-A1).
 *
 * I-A3 — its authority is checked on every call, not when a Handle is issued: the Principal must
 * still be a person, enabled, in an enabled workspace, and its user active and an effective
 * platform administrator (`effectivePlatformRole`: the environment's administrator list wins,
 * as everywhere else) — and the switch below must be on. `authenticateHandle` (handle-auth.ts)
 * refuses the Handle otherwise, and the dispatcher (dispatch.ts) checks again for every call it
 * dispatches, whoever built the caller. A demotion also revokes the user's admin-agent Handles at
 * once (`update_user`, platform-handlers.ts), which is what reaches llm-proxy.
 *
 * The switch is `ADMIN_AGENT_ENABLED` in the kernel's environment, off unless set (plan §5.7:
 * "停止开关放在环境变量（被劫持的管理员会话改不了）"). Off, no admin-agent Handle is issued and
 * every call through one already issued is refused.
 */

const ADMIN_AGENT_ENABLED_VAR = 'ADMIN_AGENT_ENABLED';

/** Whether the admin agent is switched on: `ADMIN_AGENT_ENABLED` is `1` or `true` (any case).
 *  Unset or empty is off, as are `0` and `false`; anything else throws — the kernel reads it once
 *  at start (index.ts), so a mistyped value stops it there instead of leaving the agent silently
 *  off or on. */
export function adminAgentEnabled(raw: string | undefined = process.env[ADMIN_AGENT_ENABLED_VAR]) {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(
    `${ADMIN_AGENT_ENABLED_VAR}="${raw}" is neither 1/true nor 0/false — unset it to keep the admin agent off`,
  );
}

/** Why an admin agent may not act now. */
export const ADMIN_AGENT_REFUSAL_REASONS = [
  /** `ADMIN_AGENT_ENABLED` is off. */
  'switched_off',
  /** No such Principal in the workspace. */
  'unknown_principal',
  /** The Principal is not a person (an agent or service Principal never runs one, I-A1). */
  'not_a_person',
  /** The person has no platform user (a Principal from before platform users, never bound). */
  'no_platform_user',
  'principal_disabled',
  'user_disabled',
  'workspace_disabled',
  /** The user is not (or no longer) an effective platform administrator. */
  'not_platform_admin',
] as const;
export type AdminAgentRefusalReason = (typeof ADMIN_AGENT_REFUSAL_REASONS)[number];

/** Thrown when an admin agent may not act now — at issuance, or (as a refusal of the call) when a
 *  Handle of one is used. */
export class AdminAgentRefused extends Error {
  readonly reason: AdminAgentRefusalReason;
  constructor(reason: AdminAgentRefusalReason, principalId: string) {
    super(`admin agent refused for principal ${principalId}: ${reason}`);
    this.name = 'AdminAgentRefused';
    this.reason = reason;
  }
}

/** What the authority check reads about the Principal an admin agent acts as. */
export interface AdminAgentAuthorityFacts {
  readonly principalKind: string;
  readonly principalRole: Role;
  readonly principalDisabled: boolean;
  readonly workspaceStatus: string;
  readonly userId: string | null;
  readonly login: string | null;
  readonly platformRole: PlatformRole | null;
  readonly userStatus: string | null;
}

/** The authority rule itself, on facts already read (pure): `null` when the admin agent may act,
 *  else the first reason it may not, in the order the reasons are listed. */
export function adminAgentRefusalOf(
  facts: AdminAgentAuthorityFacts | undefined,
  enabled: boolean,
): AdminAgentRefusalReason | null {
  if (!enabled) return 'switched_off';
  if (facts === undefined) return 'unknown_principal';
  if (facts.principalKind !== 'human') return 'not_a_person';
  if (facts.userId === null || facts.login === null || facts.platformRole === null) {
    return 'no_platform_user';
  }
  if (facts.principalDisabled) return 'principal_disabled';
  if (facts.userStatus !== 'active') return 'user_disabled';
  if (facts.workspaceStatus !== 'active') return 'workspace_disabled';
  if (effectivePlatformRole(facts.login, facts.platformRole) !== 'admin') {
    return 'not_platform_admin';
  }
  return null;
}

interface AuthorityRow {
  principal_kind: string;
  principal_role: Role;
  principal_disabled: boolean;
  workspace_status: string;
  user_id: string | null;
  login: string | null;
  platform_role: PlatformRole | null;
  user_status: string | null;
}

/**
 * Reads the facts {@link adminAgentRefusalOf} decides on. Works on the admin client and inside a
 * transaction of the Principal's own workspace alike: that workspace's `principals` and
 * `workspaces` rows are readable there, and so is the user row of one of its members (core 0021
 * `users_workspace_members`).
 */
export async function readAdminAgentAuthorityFacts(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<AdminAgentAuthorityFacts | undefined> {
  const result = await client.query<AuthorityRow>(
    `select p.kind as principal_kind, p.role as principal_role,
            (p.disabled_at is not null) as principal_disabled,
            w.status as workspace_status,
            u.id as user_id, u.login, u.platform_role, u.status as user_status
       from principals p
       join workspaces w on w.id = p.workspace_id
       left join users u on u.id = p.user_id
      where p.workspace_id = $1 and p.id = $2`,
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    principalKind: row.principal_kind,
    principalRole: row.principal_role,
    principalDisabled: row.principal_disabled,
    workspaceStatus: row.workspace_status,
    userId: row.user_id,
    login: row.login,
    platformRole: row.platform_role,
    userStatus: row.user_status,
  };
}

/** The reason the admin agent acting as `principalId` may not act now, or `null` (I-A3). */
export async function adminAgentRefusal(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  enabled: boolean = adminAgentEnabled(),
): Promise<AdminAgentRefusalReason | null> {
  if (!enabled) return 'switched_off';
  return adminAgentRefusalOf(
    await readAdminAgentAuthorityFacts(client, workspaceId, principalId),
    enabled,
  );
}

/** Throws {@link AdminAgentRefused} unless the admin agent acting as `principalId` may act now;
 *  returns the facts it checked. */
export async function assertAdminAgentAuthority(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  enabled: boolean = adminAgentEnabled(),
): Promise<AdminAgentAuthorityFacts> {
  const facts = enabled
    ? await readAdminAgentAuthorityFacts(client, workspaceId, principalId)
    : undefined;
  const reason = adminAgentRefusalOf(facts, enabled);
  if (reason !== null || facts === undefined) {
    throw new AdminAgentRefused(reason ?? 'unknown_principal', principalId);
  }
  return facts;
}

/** The longest an admin agent's Handle lives. The authority check runs on every call whatever the
 *  ttl; llm-proxy sees only revocations, so a short life bounds what an unrevoked Handle can still
 *  spend on models after the switch is turned off. */
export const ADMIN_AGENT_HANDLE_MAX_TTL_SECONDS = 60 * 60;

export interface IssueAdminAgentHandleParams {
  readonly workspaceId: string;
  /** The administrator's human Principal in `workspaceId`. */
  readonly principalId: string;
  /** Resource scope to carry (`adminAgentScope`): which gates its observe-class tools may name. */
  readonly resources?: Readonly<Record<string, readonly string[]>>;
  readonly ttlSeconds: number;
  readonly privateKey: CryptoKey;
}

/**
 * Issues an admin agent's Handle, on `client` inside a transaction of `workspaceId`: the authority
 * check (refusing with {@link AdminAgentRefused}), then the Principal's `admin_agent` session — the
 * newest one not revoked or expired, or a new one — and a Handle under it scoped to
 * `adminAgentScope` for the Principal's role here (issueHandle refuses anything wider for this
 * session kind). AA4's runtime calls it when an administrator starts the agent; nothing else does.
 */
export async function issueAdminAgentHandle(
  client: PoolClient,
  params: IssueAdminAgentHandleParams,
): Promise<IssuedHandle> {
  if (
    !Number.isFinite(params.ttlSeconds) ||
    params.ttlSeconds <= 0 ||
    params.ttlSeconds > ADMIN_AGENT_HANDLE_MAX_TTL_SECONDS
  ) {
    throw new RangeError(
      `an admin agent's Handle lives between 1 and ${ADMIN_AGENT_HANDLE_MAX_TTL_SECONDS} seconds, got ${params.ttlSeconds}`,
    );
  }
  const facts = await assertAdminAgentAuthority(client, params.workspaceId, params.principalId);
  const sessionId = await openAdminAgentSession(client, params.workspaceId, params.principalId);
  return issueHandle(client, {
    sessionId,
    scope: adminAgentScope(params.resources ?? {}, { role: facts.principalRole }),
    ttlSeconds: params.ttlSeconds,
    privateKey: params.privateKey,
  });
}

/** The Principal's newest usable `admin_agent` session, or a new one. A revoked one — after a
 *  demotion or a disabled user — is never reused. */
async function openAdminAgentSession(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `select id from sessions
      where workspace_id = $1 and principal_id = $2 and on_behalf_of = $2 and kind = $3
        and status <> 'revoked' and (expires_at is null or expires_at > now())
      order by created_at desc, id desc
      limit 1`,
    [workspaceId, principalId, ADMIN_AGENT_SESSION_KIND],
  );
  const found = existing.rows[0];
  if (found) return found.id;
  const inserted = await client.query<{ id: string }>(
    `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
     values ($1, $2, $3, $2, 'active')
     returning id`,
    [workspaceId, principalId, ADMIN_AGENT_SESSION_KIND],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('openAdminAgentSession: INSERT ... RETURNING produced no row');
  return row.id;
}
