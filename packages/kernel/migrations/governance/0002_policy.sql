-- module: governance, version: 0002
--
-- Policy and CapabilityGrant (design doc §5.1.4, §5.4 I8/I14, §5.8; docs/development-tasks.md
-- S2.1). Two workspace-configurable governance primitives that `action_requests`
-- (0003_action_requests.sql, same module) is evaluated and approved against:
--
--   - `policies`: the workspace half of I8's "double signal" auto-approval (§5.4: "自动批准 =
--     ActionType 声明 且 Workspace 规则开启"). Signal 1 (an ActionType/Operation declaring
--     `auto_approvable`) lives on the platform meta-ontology Operation object (§5.1.2,
--     §9.2 "gatekeeper_instances / operations ... 存于 objects / links") — not a kernel table, so
--     not created here. Signal 2 — the workspace opting an `action_kind` into auto-approval — is
--     this table's `auto_approve` column, one row per `(workspace_id, action_kind)`, written by
--     the `set_policy` / `set_auto_approved_action_kind` capabilities
--     (packages/shared/src/capabilities.ts governance group).
--   - `capability_grants`: the other table CapabilityGrant needs beyond `capability_handles`
--     (governance/0001) — a durable, revocable "Principal P may use Capability C within Scope S"
--     record (§5.5 CapabilityGrant `active → revoked | expired`), written by `grant_capability`
--     and read back by I14's approval check.
--
-- Column shapes below are taken verbatim from the existing capability contracts in
-- packages/shared/src/capabilities.ts (not re-invented), so the DB row shape matches what the
-- service layer (a later task) will actually receive and persist:
--   - `grant_capability` paramsSchema: `{ principalId: id, capability: z.string(), scope: jsonRecord }`
--     → `capability_grants.principal_id / capability / scope`.
--   - `set_auto_approved_action_kind` paramsSchema: `{ actionKind: z.string() }`
--     → `policies.action_kind`.
--   - `set_policy` paramsSchema: `{ policy: jsonRecord }` is the human-channel entry point that
--     writes a row here; this migration exposes named, CHECK-able columns
--     (`blast_radius` / `auto_approve` / `requester_can_approve`) rather than storing that payload
--     as an opaque blob, so the one invariant that must never be representable — a `high`
--     blast-radius action_kind marked auto-approvable — is enforced by Postgres itself (I8, §5.4
--     "工作区不能关闭"; docs/development-tasks.md S2.2 acceptance "试图为 high 开自动批准被拒"),
--     not only by the (not-yet-written) policy engine. `set_policy`'s service implementation
--     (S2.2) maps its `policy: jsonRecord` payload onto these columns.
--
-- Runner ordering (mirrors governance/0001's own note): packages/kernel/src/adapters/db/
-- migrate.ts's `discoverMigrations` sorts strictly by module directory name, then by version
-- within a module. This file is the second migration in the `governance` module, so it reuses
-- that module's advisory-lock key (no new key needed — the lock is per module, not per file).
select pg_advisory_xact_lock(7241000201);

-- policies (§5.4 I8, §5.8, §9.3 `set_policy` / `set_auto_approved_action_kind`): one row per
-- `(workspace_id, action_kind)` a workspace owner has explicitly configured. No row for a given
-- action_kind means "use the compiled-in default" (docs/development-tasks.md S2.3: "默认策略表：
-- low 自动批准、medium / high 与未分类要人批") — that default table is policy-engine logic (S2.2),
-- not data seeded by this migration.
create table if not exists policies (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  action_kind text not null,
  -- Nullable: a rule may exist only to set `requester_can_approve` for an action_kind whose
  -- blast_radius is intrinsic to its Operation definition (graph-stored) rather than duplicated
  -- here. When present, it is the snapshot this row's `auto_approve` CHECK below is judged
  -- against.
  blast_radius text check (blast_radius in ('low', 'medium', 'high')),
  auto_approve boolean not null default false,
  requester_can_approve boolean,
  set_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, action_kind),
  foreign key (workspace_id, set_by) references principals (workspace_id, id),
  -- I8 / §5.4 "工作区不能关闭" (high-impact auto-approval can never be turned on, and a workspace
  -- rule cannot override that): the hard half of the double signal, enforced independently of
  -- whatever the (not-yet-written) policy engine checks in application code.
  check (blast_radius is distinct from 'high' or auto_approve = false)
);

alter table policies enable row level security;

drop policy if exists policies_workspace_isolation on policies;

create policy policies_workspace_isolation on policies
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Delete is granted (unlike capability_grants/action_requests below): a Policy row is pure
-- mutable configuration, not an audit-relevant governed record on its own — removing an
-- action_kind override to fall back to the compiled-in default is a legitimate operation, and
-- nothing in G2/§12 requires policy-rule history to survive a delete. Every *use* of a policy
-- when evaluating an ActionRequest is still recorded via that ActionRequest's own
-- `policy_decision` (0003_action_requests.sql) and its audit_records row (I11).
grant select, insert, update, delete on policies to nexttime_app;

-- capability_grants (§5.1.4, §5.5, §5.4 I14): durable, revocable grants beyond the fixed
-- entry-agent ceiling and role-based defaults. `capability` doubles as an action_kind when the
-- grant exists specifically to satisfy I14 (the approver must hold the ActionRequest's
-- `action_kind` × `resource_scope`, see 0003_action_requests.sql) — `connect_gatekeeper` and
-- `grant_capability` both write rows here (design doc §5.1.4: "`connect_gatekeeper` ...
-- 本质是一条 CapabilityGrant"). The I14 check itself (a later task, S2.3) is expected to read this
-- table as:
--   select 1 from capability_grants
--    where workspace_id = :ws and principal_id = :approver and status = 'active'
--      and capability = :action_kind
--      and (scope ->> 'resourceScope' is null or scope ->> 'resourceScope' = :resource_scope)
-- — an application-level match (§5.4 I14 mechanism: "approve 前置检查"), not a DB constraint.
create table if not exists capability_grants (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  principal_id uuid not null,
  capability text not null,
  scope jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  expires_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id),
  foreign key (workspace_id, granted_by) references principals (workspace_id, id)
);

alter table capability_grants enable row level security;

drop policy if exists capability_grants_workspace_isolation on capability_grants;

create policy capability_grants_workspace_isolation on capability_grants
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant (mirrors governance/0001's capability_handles exactly, same reasoning): a Grant
-- is revoked (`status = 'revoked'` / `revoked_at` set) or left to expire, never removed — the row
-- is the durable record of a grant having existed (§12 audit/reconstruct may need it long after
-- revocation).
grant select, insert, update on capability_grants to nexttime_app;
