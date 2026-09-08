-- module: governance, version: 0010
--
-- S3.13 (docs/development-tasks.md "每用户智能体配置：AgentProfile / AgentPolicy"): two tables —
--
--   - agent_profiles(workspace_id, principal_id): at most one row per (workspace, principal) —
--     the principal's own AgentProfile. Every column defaults to null ("inherit the workspace
--     AgentPolicy default" — S3.13's own ontology: "缺省 = 继承 AgentPolicy 默认"). This is an
--     authorization projection, not application state (S3.13's own storage note: "迁移在
--     governance/（它是授权投影，不是应用状态）") — a Profile only ever narrows what the principal's
--     Grants already allow, the same "governance owns the shape of what a principal may do" role
--     `capability_grants`/`policies` already play; it is never itself a source of authority.
--   - agent_policies(workspace_id): at most one row per workspace — the workspace-wide AgentPolicy
--     an owner sets. No row means "compiled-in defaults" (`[]`, `null`, `true`, `2000`, `[]`, `[]`,
--     `false`, matching S3.13's own defaults list exactly) — the same "no row = default" convention
--     `policies`/`quotas` already use elsewhere in this module, so `set_agent_policy` never has to
--     pre-seed a row before it is first customized.
--
-- `enabled_skills`/`enabled_gatekeepers`/`enabled_worker_definitions` are `jsonb` arrays of
-- strings (skill/gatekeeper/worker-definition ids or names) rather than junction tables — the same
-- "opaque jsonb array, application code owns the shape" convention `capability_grants.scope` and
-- `worker_definitions.definition` already use in this codebase; there is no cross-table query this
-- data needs to support (S3.13's own runtime projection reads these arrays wholesale, never
-- filters by one element), so a relational join table would add write/read complexity with no
-- corresponding benefit. `null` (the column's own SQL null, not a JSON `null` literal) is the
-- "inherit" sentinel; `'[]'::jsonb` is a real, explicit empty selection — the two are distinct and
-- both representable.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

create table if not exists agent_profiles (
  workspace_id uuid not null,
  principal_id uuid not null,
  model text,
  enabled_skills jsonb,
  enabled_gatekeepers jsonb,
  enabled_worker_definitions jsonb,
  prompt_addendum text,
  auto_approve_low boolean,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, principal_id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id),
  foreign key (workspace_id, updated_by) references principals (workspace_id, id)
);

alter table agent_profiles enable row level security;

drop policy if exists agent_profiles_workspace_isolation on agent_profiles;

create policy agent_profiles_workspace_isolation on agent_profiles
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on agent_profiles to nexttime_app;

create table if not exists agent_policies (
  workspace_id uuid not null primary key,
  allowed_models jsonb not null default '[]'::jsonb,
  default_model text,
  member_can_edit_profile boolean not null default true,
  max_prompt_addendum_chars integer not null default 2000,
  allowed_skills jsonb not null default '[]'::jsonb,
  allowed_gatekeepers jsonb not null default '[]'::jsonb,
  allow_member_auto_approve_low boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, updated_by) references principals (workspace_id, id)
);

alter table agent_policies enable row level security;

drop policy if exists agent_policies_workspace_isolation on agent_policies;

create policy agent_policies_workspace_isolation on agent_policies
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on agent_policies to nexttime_app;
