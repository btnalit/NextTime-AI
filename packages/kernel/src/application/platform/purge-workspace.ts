import { randomUUID } from 'node:crypto';
import type {
  PurgeWarningWire,
  PurgeWorkspaceReasonWire,
  PurgeWorkspaceResultWire,
  PurgedUserWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';
import type { WorkspacePurpose } from '../workspace/create.js';
import { readPlatformSettings } from './settings.js';

/**
 * application/platform/purge-workspace: the `purged` terminal state of a Workspace
 * (docs/console-completion-plan.md §4 "Workspace 生命周期", §5.2 `purge_workspace`, §6, §7, §12
 * 决定 3 / 5; S6 A1 / A6). One application function behind two entry points — the
 * `purge_workspace` platform capability (application/gateway/platform-handlers.ts) and the
 * bootstrap CLI's `purge-workspace` / `purge-expired-workspaces` subcommands that
 * `scripts/delete-workspace.sh` / `scripts/delete-workspaces-matching.sh` drive — so the console
 * and the operator scripts are one path (§5.2: "脚本与页面同一条路径").
 *
 * **Why the superuser path.** A platform transaction is `nexttime_app` under `app.platform = on`
 * (adapters/db/platform-context.ts): no DELETE on `workspaces` (0022 grants column updates only),
 * no DELETE on `audit_records` (0004 — and its `before delete` trigger raises for everyone), and
 * disabling that trigger needs table ownership. The cascade therefore runs on the same
 * skip-role-switch (superuser, RLS-bypassing) path `application/workspace/create.ts` uses for
 * bootstrap — invoked by the capability handler from its `afterCommit` phase, exactly as
 * `create_workspace` runs `createWorkspaceWithOwner` after its own platform transaction commits.
 * The application role's grants do not change: audit only ever grows for it, and the one place
 * that can remove a workspace's audit rows is this function, inside a governed, administrator-
 * only capability that leaves a platform audit row behind (`platform.workspace_purged`).
 *
 * **Preconditions** (`assessPurgeEligibility`, §5.2 / §12 决定 3): `status = 'disabled'` and
 * `disabled_at` is either null (disabled before migration core 0030 — treated as "retention
 * elapsed") or older than {@link PURGE_RETENTION_DAYS}; or `purpose = 'ephemeral'` and
 * `expires_at < now()` — the S5.3 `--expired` rule, which admits an ephemeral workspace that is
 * still `active`. The platform default workspace is always refused. The capability handler
 * checks these in its platform transaction for a clean 409 with no audit row; this function
 * re-checks them under `select … for update` on the workspace row, so a workspace re-enabled
 * between the two phases is never deleted.
 *
 * **Cascade order** (§4, "顺序即依赖"): revoke and delete every CapabilityHandle → Tasks (the
 * host-side `workspaces/tasks/<id>` directories are reported back, not deleted here — the kernel
 * is mechanism and never touches host paths, design §7.10) → Chat / Turn / Activity / Decision /
 * Conflict / Fact / Object / Source / Observation / Evidence → the workspace's audit rows →
 * Principals → the workspace row. The order is derived from the live schema
 * (`discoverWorkspaceScopedSchema`: every table with a `workspace_id` column and every foreign
 * key among them, so a future migration's table is picked up automatically) and sorted by
 * `computeWorkspaceTableDeletionOrder` — children before parents, ties broken by
 * {@link PURGE_TABLE_PRIORITY} so the result reads as §4 wherever the foreign keys leave a
 * choice. Every statement runs in one transaction; the two append-only triggers (`links` I4,
 * `audit_records` I11) are disabled and re-enabled inside it, never past COMMIT.
 *
 * **Edge (a)** — a `service` Principal (a collector, an external runtime over `/mcp`) may have a
 * Handle some process is still presenting: the preview and the result carry a
 * `service_handle_in_use` warning per such Principal (leftover 41: a collector pointed at a
 * disabled acceptance workspace 401'd for a week unnoticed).
 *
 * **Edge (b)** — users whose memberships were all in this workspace and who never activated are
 * deleted with it: no password (`has_password`), no console session, not a platform
 * administrator, and — checked explicitly against every foreign key that references `users(id)`
 * in the live catalog, never by catching an FK error mid-transaction — no other row that survives
 * the purge references them (a platform audit row, a settings version). Any surviving reference
 * keeps the user (audit only grows; §5.2 "护栏而不是障碍"); the users page's `hideResidual`
 * filter hides them meanwhile. This is what keeps the 0019 invariant (a human Principal always
 * has a user) while letting acceptance-run users die with their ephemeral workspace (决定 5).
 */

/** §5.2 / §12 决定 3: a disabled workspace is purgeable after this many days — the same 7 days
 *  the acceptance scripts give an ephemeral workspace's TTL. */
export const PURGE_RETENTION_DAYS = 7;

/** Matches a bare lowercase Postgres identifier. Every table name this module ever builds a
 *  dynamic statement for comes from `discoverWorkspaceScopedSchema` / `findUserReferences`
 *  (information_schema / pg_constraint — real catalog data, never caller input), so this is cheap
 *  defense-in-depth against building a malformed statement, not a real injection concern. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// -------------------------------------------------------------------------------------------
// Live-schema discovery + deletion order (moved here from cli/bootstrap.ts, which re-exports
// them: the CLI's `delete-workspace` and this cascade share one mechanism).
// -------------------------------------------------------------------------------------------

export interface ForeignKeyEdge {
  readonly childTable: string;
  readonly parentTable: string;
}

export interface WorkspaceScopedSchema {
  readonly tables: readonly string[];
  readonly foreignKeys: readonly ForeignKeyEdge[];
}

/**
 * Reads every `public` table with a `workspace_id` column, and every foreign key constraint
 * between two such tables, from the live schema — the raw input
 * `computeWorkspaceTableDeletionOrder` turns into a safe per-table delete order. Runtime
 * discovery, not a table list maintained by hand, so it never drifts from whatever
 * `packages/kernel/migrations/**\/*.sql` actually declares.
 */
export async function discoverWorkspaceScopedSchema(
  client: PoolClient,
): Promise<WorkspaceScopedSchema> {
  const tablesResult = await client.query<{ table_name: string }>(
    `select distinct table_name
     from information_schema.columns
     where table_schema = 'public' and column_name = 'workspace_id'`,
  );
  const tables = tablesResult.rows.map((row) => row.table_name).sort();

  const foreignKeysResult = await client.query<{ child_table: string; parent_table: string }>(
    `select child.relname as child_table, parent.relname as parent_table
     from pg_constraint c
     join pg_class child on child.oid = c.conrelid
     join pg_class parent on parent.oid = c.confrelid
     join pg_namespace ns on ns.oid = child.relnamespace
     where c.contype = 'f' and ns.nspname = 'public'`,
  );
  const foreignKeys = foreignKeysResult.rows.map((row) => ({
    childTable: row.child_table,
    parentTable: row.parent_table,
  }));

  return { tables, foreignKeys };
}

export class WorkspaceDeletionOrderCycleError extends Error {
  constructor(remainingTables: readonly string[]) {
    super(
      `purge-workspace: cannot compute a safe deletion order — cyclic foreign keys among: ${remainingTables.join(', ')}`,
    );
    this.name = 'WorkspaceDeletionOrderCycleError';
  }
}

/**
 * §4's cascade order as a tie-break for the topological sort: whenever several tables are
 * deletable at once, this is the order they go in. Tables not listed here (policies, grants,
 * ontology versions, the outbox, …) follow alphabetically; `principals` and the audit rows are
 * last on purpose, exactly as §4 states. Foreign keys always win over this list — it never
 * produces an order a `no action` constraint would reject.
 */
export const PURGE_TABLE_PRIORITY: readonly string[] = [
  'capability_handles',
  'sessions',
  'tasks',
  'worker_runs',
  'chats',
  'chat_messages',
  'activities',
  'decisions',
  'conflicts',
  'links',
  'objects',
  'sources',
  'observations',
  'evidence',
  'audit_records',
  'principals',
];

function priorityOf(table: string): number {
  const index = PURGE_TABLE_PRIORITY.indexOf(table);
  return index === -1 ? PURGE_TABLE_PRIORITY.length : index;
}

function compareTables(a: string, b: string): number {
  const delta = priorityOf(a) - priorityOf(b);
  return delta !== 0 ? delta : a.localeCompare(b);
}

/**
 * Topologically sorts `schema.tables` so that every table is deleted before every other table it
 * holds a foreign key to (Kahn's algorithm: a table becomes eligible once nothing still in the
 * graph references it) — exactly the order a bare `delete from <table> where workspace_id = $1`
 * per table needs to never hit a "no action" FK violation.
 *
 * Self-referencing foreign keys (`links.supersedes_id`, `capability_handles.parent_jti`,
 * `worker_runs.parent_worker_run_id`) need no ordering at all — a single `delete ... where
 * workspace_id = $1` statement removes every row of that table together, satisfying its own
 * self-FK regardless of which row the constraint machinery happens to check first — so an edge
 * from a table to itself is dropped before building the graph, not treated as a 1-node cycle.
 *
 * Pure — no DB access — so the topology (including the self-reference and multi-level-chain
 * cases) is unit-testable against a fabricated `WorkspaceScopedSchema`, independent of the live
 * schema `discoverWorkspaceScopedSchema` reads. Throws `WorkspaceDeletionOrderCycleError` if a
 * genuine (non-self) cycle makes no valid order possible — not expected against this codebase's
 * actual schema, but a real possibility for a fabricated/future one, so left as a hard failure
 * rather than a silently-wrong partial order.
 */
export function computeWorkspaceTableDeletionOrder(schema: WorkspaceScopedSchema): string[] {
  const tables = new Set(schema.tables);
  const inDegree = new Map<string, number>();
  // childTable -> the parentTables it must be deleted before (its own outgoing foreign keys).
  const mustPrecede = new Map<string, string[]>();

  for (const table of tables) {
    inDegree.set(table, 0);
    mustPrecede.set(table, []);
  }

  for (const edge of schema.foreignKeys) {
    if (edge.childTable === edge.parentTable) continue;
    if (!tables.has(edge.childTable) || !tables.has(edge.parentTable)) continue;
    mustPrecede.get(edge.childTable)?.push(edge.parentTable);
    inDegree.set(edge.parentTable, (inDegree.get(edge.parentTable) ?? 0) + 1);
  }

  // Nothing (still in the graph) references a zero-in-degree table — it is safe to delete first.
  const ready = [...tables].filter((table) => inDegree.get(table) === 0).sort(compareTables);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort(compareTables);
    const table = ready.shift();
    if (table === undefined) break;
    order.push(table);
    for (const parent of mustPrecede.get(table) ?? []) {
      const remaining = (inDegree.get(parent) ?? 0) - 1;
      inDegree.set(parent, remaining);
      if (remaining === 0) ready.push(parent);
    }
  }

  if (order.length !== tables.size) {
    const remaining = [...tables].filter((table) => !order.includes(table));
    throw new WorkspaceDeletionOrderCycleError(remaining);
  }

  return order;
}

// -------------------------------------------------------------------------------------------
// Eligibility
// -------------------------------------------------------------------------------------------

export interface PurgeEligibilityRow {
  readonly status: 'active' | 'disabled';
  readonly purpose: WorkspacePurpose;
  readonly expiresAt: Date | null;
  readonly disabledAt: Date | null;
}

export type PurgeRefusalCode = 'workspace_active' | 'retention_not_elapsed';

export type PurgeEligibility =
  | { readonly eligible: true; readonly reason: PurgeWorkspaceReasonWire }
  | { readonly eligible: false; readonly code: PurgeRefusalCode; readonly message: string };

/**
 * §5.2's two preconditions, pure (unit-testable without a database). The ephemeral branch is
 * checked first: an expired ephemeral workspace is purgeable whatever its status, the S5.3
 * `--expired` contract. A disabled workspace with `disabledAt === null` was disabled before
 * migration core 0030 and counts as retention-elapsed (§12 决定 3).
 */
export function assessPurgeEligibility(
  row: PurgeEligibilityRow,
  now: Date = new Date(),
): PurgeEligibility {
  if (
    row.purpose === 'ephemeral' &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() < now.getTime()
  ) {
    return { eligible: true, reason: 'ephemeral_expired' };
  }
  if (row.status !== 'disabled') {
    return {
      eligible: false,
      code: 'workspace_active',
      message:
        row.purpose === 'ephemeral'
          ? 'the workspace is active and its expiry has not passed — disable it, or wait for it to expire'
          : 'the workspace is active — disable it first; it becomes purgeable after 7 days',
    };
  }
  if (row.disabledAt === null) {
    return { eligible: true, reason: 'disabled_retention_elapsed' };
  }
  const purgeableAt = new Date(
    row.disabledAt.getTime() + PURGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  if (purgeableAt.getTime() <= now.getTime()) {
    return { eligible: true, reason: 'disabled_retention_elapsed' };
  }
  return {
    eligible: false,
    code: 'retention_not_elapsed',
    message: `the workspace was disabled on ${row.disabledAt.toISOString()} and becomes purgeable on ${purgeableAt.toISOString()} (${PURGE_RETENTION_DAYS}-day retention)`,
  };
}

// -------------------------------------------------------------------------------------------
// Users referenced elsewhere (edge (b), and `purge_user`'s own guard)
// -------------------------------------------------------------------------------------------

export interface UserReference {
  readonly table: string;
  readonly column: string;
  readonly rows: number;
}

/**
 * Every foreign key in the live catalog that references `users(id)`, checked for rows that
 * point at `userId` — the explicit form of "would deleting this user violate a constraint",
 * decided before any DELETE instead of by catching the error mid-transaction. Rows that the
 * purge in progress will remove anyway are excluded: with `excludeWorkspaceId`, a referencing
 * table that is itself workspace-scoped (has a `workspace_id` column) only counts rows of
 * *other* workspaces — the target workspace's Principals and audit rows go first. Today that is
 * `principals.user_id`, `user_sessions.user_id`, `audit_records.actor_user_id` and the two
 * `platform_settings*.updated_by` columns (0019 / 0021), but a migration that adds another one
 * is covered without touching this code.
 *
 * Runs on whatever `client` it is given: under a platform transaction it sees what the platform
 * policies expose (every platform row; workspace rows only through `*_platform_admin`), under
 * the superuser path everything. A reference the transaction cannot see still makes the DELETE
 * fail and roll back — never a partial purge.
 */
export async function findUserReferences(
  client: PoolClient,
  userId: string,
  options: { readonly excludeWorkspaceId?: string } = {},
): Promise<UserReference[]> {
  const catalog = await client.query<{
    child_table: string;
    child_column: string;
    workspace_scoped: boolean;
  }>(
    `select child.relname as child_table,
            a.attname as child_column,
            exists (
              select 1 from pg_attribute w
               where w.attrelid = child.oid and w.attname = 'workspace_id' and not w.attisdropped
            ) as workspace_scoped
       from pg_constraint c
       join pg_class child on child.oid = c.conrelid
       join pg_class parent on parent.oid = c.confrelid
       join pg_namespace ns on ns.oid = parent.relnamespace
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and ns.nspname = 'public' and parent.relname = 'users'
      order by child.relname, a.attname`,
  );
  const references: UserReference[] = [];
  for (const fk of catalog.rows) {
    if (!SAFE_IDENTIFIER.test(fk.child_table) || !SAFE_IDENTIFIER.test(fk.child_column)) {
      throw new Error(
        `purge-workspace: refusing to query unexpected catalog name "${fk.child_table}.${fk.child_column}"`,
      );
    }
    const excludeWorkspace = options.excludeWorkspaceId !== undefined && fk.workspace_scoped;
    const result = await client.query<{ n: string }>(
      `select count(*)::text as n from "${fk.child_table}"
        where "${fk.child_column}" = $1${excludeWorkspace ? ' and (workspace_id is null or workspace_id <> $2)' : ''}`,
      excludeWorkspace ? [userId, options.excludeWorkspaceId] : [userId],
    );
    const rows = Number(result.rows[0]?.n ?? '0');
    if (rows > 0) references.push({ table: fk.child_table, column: fk.child_column, rows });
  }
  return references;
}

// -------------------------------------------------------------------------------------------
// The cascade
// -------------------------------------------------------------------------------------------

/** Thrown when the workspace cannot be purged. `code` is what the capability handler maps onto
 *  its `PlatformAdminError` (409 / 404) and what the CLI prints. */
export class PurgeWorkspaceRefusedError extends Error {
  readonly code: PurgeRefusalCode | 'workspace_not_found' | 'default_workspace';
  constructor(code: PurgeWorkspaceRefusedError['code'], message: string) {
    super(message);
    this.name = 'PurgeWorkspaceRefusedError';
    this.code = code;
  }
}

export interface PurgeWorkspaceInput {
  readonly workspaceId: string;
  /** `false`: preview only (nothing written). `true`: execute. */
  readonly confirm: boolean;
  /** The acting administrator, for the `platform.workspace_purged` audit row
   *  (`audit_records_actor_shape` needs one on a platform row). Omitted — the operator CLI with
   *  no resolvable administrator — means no audit row: the CLI then prints its own structured
   *  event line instead. */
  readonly actorUserId?: string;
  /** Operator override (the bootstrap CLI's legacy `delete-workspace`, `scripts/delete-
   *  workspace.sh --force`): skip the eligibility and default-workspace checks. Never reachable
   *  from a capability. */
  readonly force?: boolean;
}

const LINKS_DELETE_TRIGGER = 'links_immutable_delete';
const AUDIT_RECORDS_DELETE_TRIGGER = 'audit_records_no_delete';

interface WorkspaceRow {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  purpose: WorkspacePurpose;
  expires_at: Date | null;
  disabled_at: Date | null;
}

interface PrincipalRow {
  id: string;
  kind: string;
  display_name: string | null;
  active_handles: string;
}

/** `capability_handles` → `capabilityHandles`: the wire never shows a snake_case column name
 *  (docs/wire-contract-conventions.md §2). */
export function wireTableKey(table: string): string {
  return table.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
}

async function loadWorkspaceForUpdate(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceRow> {
  const result = await client.query<WorkspaceRow>(
    `select id, name, status, purpose, expires_at, disabled_at
       from workspaces where id = $1 for update`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new PurgeWorkspaceRefusedError(
      'workspace_not_found',
      `workspace not found: ${workspaceId}`,
    );
  }
  return row;
}

/** §4 edge (b): the users this purge takes with it — see the module doc comment. */
async function findCascadedUsers(
  client: PoolClient,
  workspaceId: string,
): Promise<PurgedUserWire[]> {
  const candidates = await client.query<{ id: string; login: string }>(
    `select distinct u.id, u.login
       from users u
       join principals p on p.user_id = u.id
      where p.workspace_id = $1 and p.kind = 'human'
        and u.has_password = false
        and u.platform_role <> 'admin'
        and not exists (select 1 from user_sessions s where s.user_id = u.id)
        and not exists (
          select 1 from principals o where o.user_id = u.id and o.workspace_id <> $1
        )
      order by u.login`,
    [workspaceId],
  );
  const purgeable: PurgedUserWire[] = [];
  for (const candidate of candidates.rows) {
    const references = await findUserReferences(client, candidate.id, {
      excludeWorkspaceId: workspaceId,
    });
    if (references.length === 0) purgeable.push({ id: candidate.id, login: candidate.login });
  }
  return purgeable;
}

/**
 * Purges (or, with `confirm: false`, only assesses) one workspace. Resolves with the same shape
 * either way — the preview's `counts` are what a purge would delete, the execution's are what it
 * did. Throws `PurgeWorkspaceRefusedError` for a missing, ineligible or default workspace; any
 * other error rolls the whole transaction back (nothing is ever half-purged).
 */
export async function purgeWorkspace(
  pool: PoolLike,
  input: PurgeWorkspaceInput,
): Promise<PurgeWorkspaceResultWire> {
  return withWorkspace(
    pool,
    { workspaceId: input.workspaceId, principalId: randomUUID() },
    async (client) => {
      const workspace = await loadWorkspaceForUpdate(client, input.workspaceId);

      let reason: PurgeWorkspaceReasonWire;
      const eligibility = assessPurgeEligibility({
        status: workspace.status,
        purpose: workspace.purpose,
        expiresAt: workspace.expires_at,
        disabledAt: workspace.disabled_at,
      });
      if (eligibility.eligible) {
        reason = eligibility.reason;
      } else if (input.force) {
        // The operator override still records *why* it needed forcing: the row is reported
        // under the reason it would have had, so the audit payload reads the same either way.
        reason =
          workspace.purpose === 'ephemeral' ? 'ephemeral_expired' : 'disabled_retention_elapsed';
      } else {
        throw new PurgeWorkspaceRefusedError(eligibility.code, eligibility.message);
      }
      if (!input.force) {
        const { settings } = await readPlatformSettings(client);
        if (settings.defaultWorkspaceId === workspace.id) {
          throw new PurgeWorkspaceRefusedError(
            'default_workspace',
            'the platform default workspace cannot be purged — pick another default first',
          );
        }
      }

      const principals = await client.query<PrincipalRow>(
        `select p.id, p.kind, p.display_name,
                (select count(*) from capability_handles h
                  where h.workspace_id = p.workspace_id and h.on_behalf_of = p.id
                    and h.revoked_at is null and h.expires_at > now())::text as active_handles
           from principals p
          where p.workspace_id = $1
          order by p.created_at, p.id`,
        [workspace.id],
      );
      const warnings: PurgeWarningWire[] = principals.rows
        .filter((p) => p.kind === 'service')
        .map((p) => ({
          kind: 'service_handle_in_use',
          principalId: p.id,
          name: p.display_name,
          activeHandles: Number(p.active_handles),
        }));
      const activeHandles = Number(
        (
          await client.query<{ n: string }>(
            `select count(*)::text as n from capability_handles
              where workspace_id = $1 and revoked_at is null and expires_at > now()`,
            [workspace.id],
          )
        ).rows[0]?.n ?? '0',
      );
      const taskIds = (
        await client.query<{ id: string }>(
          'select id from tasks where workspace_id = $1 order by created_at, id',
          [workspace.id],
        )
      ).rows.map((row) => row.id);
      const purgedUsers = await findCascadedUsers(client, workspace.id);

      const schema = await discoverWorkspaceScopedSchema(client);
      const order = computeWorkspaceTableDeletionOrder(schema);
      for (const table of order) {
        if (!SAFE_IDENTIFIER.test(table)) {
          throw new Error(`purge-workspace: refusing to touch unexpected table name "${table}"`);
        }
      }

      const counts: Record<string, number> = {};
      let totalRows = 0;
      const record = (table: string, rows: number): void => {
        if (rows <= 0) return;
        counts[wireTableKey(table)] = rows;
        totalRows += rows;
      };

      if (!input.confirm) {
        for (const table of order) {
          const result = await client.query<{ n: string }>(
            `select count(*)::text as n from "${table}" where workspace_id = $1`,
            [workspace.id],
          );
          record(table, Number(result.rows[0]?.n ?? '0'));
        }
        return {
          workspaceId: workspace.id,
          name: workspace.name,
          purpose: workspace.purpose,
          status: workspace.status,
          reason,
          executed: false,
          counts,
          totalRows,
          activeHandles,
          warnings,
          purgedUsers,
          principalIds: principals.rows.map((p) => p.id),
          taskIds,
        };
      }

      // §4 step 1: revoke first, then delete. In one transaction the revoke is invisible outside
      // it, but `createDbRevocationCheck` fails closed on a missing row anyway — the revoke is
      // what the audit payload counts (`activeHandles`), and what a verifier holding a cached row
      // would see if this transaction ever became visible mid-way (it cannot).
      await client.query(
        `update capability_handles set revoked_at = now()
          where workspace_id = $1 and revoked_at is null`,
        [workspace.id],
      );

      // I4 / I11: the two append-only triggers raise for every role, superuser included. This is
      // the one deliberate, audited override anywhere in the kernel; both are re-enabled before
      // COMMIT (`alter table … enable trigger` is DDL inside the same transaction — leaving either
      // disabled past COMMIT would silently remove the invariant for every future write).
      if (order.includes('links')) {
        await client.query(`alter table links disable trigger ${LINKS_DELETE_TRIGGER}`);
      }
      if (order.includes('audit_records')) {
        await client.query(
          `alter table audit_records disable trigger ${AUDIT_RECORDS_DELETE_TRIGGER}`,
        );
      }
      for (const table of order) {
        const result = await client.query(`delete from "${table}" where workspace_id = $1`, [
          workspace.id,
        ]);
        record(table, result.rowCount ?? 0);
      }
      if (order.includes('audit_records')) {
        await client.query(
          `alter table audit_records enable trigger ${AUDIT_RECORDS_DELETE_TRIGGER}`,
        );
      }
      if (order.includes('links')) {
        await client.query(`alter table links enable trigger ${LINKS_DELETE_TRIGGER}`);
      }

      const deletedWorkspace = await client.query('delete from workspaces where id = $1', [
        workspace.id,
      ]);
      if ((deletedWorkspace.rowCount ?? 0) !== 1) {
        throw new Error(
          `purge-workspace: workspace row vanished during its own purge: ${workspace.id}`,
        );
      }

      if (purgedUsers.length > 0) {
        const userIds = purgedUsers.map((u) => u.id);
        // No sessions by construction (checked above); the delete keeps the statement honest.
        await client.query('delete from user_sessions where user_id = any($1::uuid[])', [userIds]);
        const deletedUsers = await client.query('delete from users where id = any($1::uuid[])', [
          userIds,
        ]);
        record('users', deletedUsers.rowCount ?? 0);
      }

      const result: PurgeWorkspaceResultWire = {
        workspaceId: workspace.id,
        name: workspace.name,
        purpose: workspace.purpose,
        status: workspace.status,
        reason,
        executed: true,
        counts,
        totalRows,
        activeHandles,
        warnings,
        purgedUsers,
        principalIds: principals.rows.map((p) => p.id),
        taskIds,
      };

      if (input.actorUserId !== undefined) {
        // The platform audit row that outlives the workspace (§4 "平台审计行保留", §8). Written
        // here, inside the cascade's own transaction, so it exists exactly when the purge does.
        // `params.workspaceId` mirrors what dispatch writes for every capability row, so
        // `platform_audit_query {targetWorkspaceId}` finds this row too.
        await writeAudit(client, {
          workspaceId: null,
          actorPrincipalId: null,
          actorUserId: input.actorUserId,
          action: 'platform.workspace_purged',
          resourceType: 'workspace',
          resourceId: workspace.id,
          payload: {
            channel: 'platform',
            params: { workspaceId: workspace.id },
            workspaceName: workspace.name,
            purpose: workspace.purpose,
            status: workspace.status,
            reason,
            forced: input.force === true,
            counts,
            totalRows,
            activeHandles,
            warnings,
            purgedUsers,
            principalIds: result.principalIds,
            taskIds,
          },
        });
      }

      return result;
    },
    { skipRoleSwitch: true },
  );
}
