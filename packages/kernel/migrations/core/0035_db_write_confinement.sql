-- module: core, version: 0035
--
-- The database confines the writes the design assumes it does (R-29, review 2026-10-02; the P3
-- items of the same class L4-11 and L4-12 bullets 1–2 folded in). Defence in depth: no kernel
-- code path changes behaviour. Every change below was checked against every write the kernel
-- makes as `nexttime_app` — a `withWorkspace` transaction without `skipRoleSwitch`, or
-- `withPlatform`; those are the only two places that switch role. The login role (bootstrap, the
-- CLI, the workspace purge cascade, the outbox dispatcher, the identity admin client) owns these
-- tables and bypasses RLS, so it keeps full power: purge still deletes every row of a workspace.
--
-- 1. Unused grants revoked. As `nexttime_app`, no kernel path deletes or updates these; the only
--    deleter is the purge cascade, on the login role:
--      - DELETE on objects, activities, sources, observations, evidence, conflicts, decisions,
--        chats, sessions, outbox;
--      - UPDATE on sources, observations, evidence, decisions (insert-only records) and outbox
--        (the dispatcher claims, counts and marks rows on the login role).
--    Before this, a bug or an injection in any workspace handler could delete the Evidence behind
--    a verified Fact. Kept because a real path writes them: UPDATE on objects (upsert, meta-object
--    status), activities (Turn and run status), conflicts (resolve), chats (title, archive),
--    sessions (revocation); DELETE on policies (0002_policy: dropping an override falls back to
--    the default, documented as legitimate), users / user_sessions / gate_instances (platform
--    transactions, RLS) and the draft-only deletes of 0033 and worker 0003. DELETE on
--    workspace_gate_links is unused as well (the runbook's manual unlink runs on the login role)
--    but stays for now: gate-link changes are in flight separately (L4-13), revoke it with them.
--    A path that later needs one of the revoked writes re-grants it narrowly, with a guard
--    trigger limited to `current_user = 'nexttime_app'` (the 0033 / worker 0003 pattern).
--
-- 2. RLS on workspaces, platform_settings and platform_settings_history. They are platform-wide
--    configuration, the access model 0023 gave connectors / gate_instances: every transaction may
--    read them (dispatch reads its workspace's status on every call, the ontology guard reads
--    `ontology_enforcement`, every prompt reads `instanceInstructions`, a platform administrator's
--    `resolve_refs` names other workspaces), only a platform transaction (`app_platform()`) may
--    write. Before this, any workspace transaction could rename, disable or re-enable another
--    tenant's workspace and rewrite `instanceInstructions`, which every agent prompt carries; the
--    history table is what `rollback_runtime_image` restores from. Not FORCEd: the owning login
--    role keeps bypassing RLS, as it does on every table here except 0021's and 0023's.
--
--    One compatibility allowance: a workspace transaction may still change its own workspace's
--    `ontology_enforcement`, and no other column. No kernel code does that (the administrator's
--    switch is the platform `update_workspace`), but the previous release's integration suite sets
--    it that way, and the reversibility probe runs that suite on this schema (docs/runbooks/
--    release.md §6). The current suite sets it on the login role; a later migration can drop
--    `workspaces_own_ontology_enforcement` and the matching branch of the trigger once no rollback
--    target's suite needs them.
--
-- 3. L4-11: the security-definer helpers lose PUBLIC execute (`nexttime_app` keeps its explicit
--    grant; the owner runs them inside policies), and `lookup_user_by_login` puts `pg_temp` last
--    in its search_path like the other four, so a session's temporary tables cannot shadow `users`.
--
-- 4. L4-12: a Fact is superseded or invalidated, never both (0012 refused the second timestamp
--    after the first, not both in one UPDATE); a deprecated OntologyVersion's definition is as
--    immutable as a published one's (0011 checked `published` only).
--
-- `capability_handles` / `capability_grants` get their monotonic-revocation triggers in
-- governance 0015: every core file runs before governance 0001 creates those tables.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration.
select pg_advisory_xact_lock(7241000101);

-- ---------------------------------------------------------------------------------------------
-- 1. Unused grants
-- ---------------------------------------------------------------------------------------------

revoke delete on objects, activities, sources, observations, evidence, conflicts, decisions, chats
  from nexttime_app;
revoke update on sources, observations, evidence, decisions from nexttime_app;
revoke delete on sessions from nexttime_app;
revoke update, delete on outbox from nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- 2. workspaces / platform_settings / platform_settings_history
-- ---------------------------------------------------------------------------------------------

alter table workspaces enable row level security;

drop policy if exists workspaces_read_all on workspaces;
create policy workspaces_read_all on workspaces for select using (true);

drop policy if exists workspaces_platform_admin on workspaces;
create policy workspaces_platform_admin on workspaces
  for all using (app_platform()) with check (app_platform());

drop policy if exists workspaces_own_ontology_enforcement on workspaces;
create policy workspaces_own_ontology_enforcement on workspaces
  for update using (id = app_workspace()) with check (id = app_workspace());

-- The row policy above cannot name columns; this keeps the allowance to `ontology_enforcement`.
create or replace function workspaces_block_workspace_plane_update() returns trigger
language plpgsql as $$
begin
  if current_user = 'nexttime_app' and not app_platform()
    and (to_jsonb(new) - 'ontology_enforcement') is distinct from (to_jsonb(old) - 'ontology_enforcement')
  then
    raise exception 'workspaces: only a platform transaction may change a workspace (R-29)';
  end if;
  return new;
end;
$$;

create or replace trigger workspaces_platform_only_update
  before update on workspaces
  for each row execute function workspaces_block_workspace_plane_update();

alter table platform_settings enable row level security;

drop policy if exists platform_settings_read_all on platform_settings;
create policy platform_settings_read_all on platform_settings for select using (true);

drop policy if exists platform_settings_platform_admin on platform_settings;
create policy platform_settings_platform_admin on platform_settings
  for all using (app_platform()) with check (app_platform());

alter table platform_settings_history enable row level security;

drop policy if exists platform_settings_history_read_all on platform_settings_history;
create policy platform_settings_history_read_all on platform_settings_history
  for select using (true);

drop policy if exists platform_settings_history_platform_admin on platform_settings_history;
create policy platform_settings_history_platform_admin on platform_settings_history
  for all using (app_platform()) with check (app_platform());

-- ---------------------------------------------------------------------------------------------
-- 3. L4-11: security-definer helpers
-- ---------------------------------------------------------------------------------------------

revoke execute on function link_visible_to_caller(uuid, uuid) from public;
revoke execute on function conflict_visible_to_caller(uuid, uuid, uuid) from public;
revoke execute on function find_active_fact_for_identity(uuid, text, uuid, uuid) from public;
revoke execute on function latest_fact_invalidated_for_identity(uuid, text, uuid, uuid) from public;

alter function lookup_user_by_login(text) set search_path = public, pg_temp;

-- ---------------------------------------------------------------------------------------------
-- 4. L4-12: Fact lifecycle and OntologyVersion definition
-- ---------------------------------------------------------------------------------------------

-- 0012's function, plus the "never both" check. The trigger from 0002 dispatches by name.
create or replace function links_block_content_update() returns trigger
language plpgsql as $$
begin
  if new.link_type is distinct from old.link_type
    or new.source_object_id is distinct from old.source_object_id
    or new.target_object_id is distinct from old.target_object_id
    or new.properties is distinct from old.properties
    or new.valid_from is distinct from old.valid_from
    or new.valid_until is distinct from old.valid_until
    or new.activity_id is distinct from old.activity_id
    or new.asserted_by is distinct from old.asserted_by
    or new.recorded_at is distinct from old.recorded_at
  then
    raise exception 'links: content columns are immutable once recorded (I4) — use supersede/invalidate instead';
  end if;

  if (old.superseded_at is not null or old.invalidated_at is not null)
    and (
      new.superseded_at is distinct from old.superseded_at
      or new.invalidated_at is distinct from old.invalidated_at
    )
  then
    raise exception
      'links: superseded_at/invalidated_at are immutable once a Fact is superseded or invalidated (I4)';
  end if;

  if old.superseded_at is null and old.invalidated_at is null
    and new.superseded_at is not null and new.invalidated_at is not null
  then
    raise exception 'links: a Fact is superseded or invalidated, never both (I4)';
  end if;

  if new.epistemic_status is distinct from old.epistemic_status then
    if old.epistemic_status = 'contradicted' then
      raise exception 'links: epistemic_status is terminal once contradicted (I4)';
    elsif old.epistemic_status = 'verified' and new.epistemic_status <> 'contradicted' then
      raise exception 'links: a verified Fact may only be promoted to contradicted (I4)';
    elsif old.epistemic_status not in ('verified', 'contradicted')
      and new.epistemic_status not in ('verified', 'contradicted') then
      raise exception
        'links: epistemic_status may only be promoted to verified or contradicted, never changed sideways (I4)';
    end if;
  end if;

  return new;
end;
$$;

-- 0011's function, with the definition lock extended to `deprecated`. The trigger from 0002
-- dispatches by name.
create or replace function ontology_versions_block_published_definition_update() returns trigger
language plpgsql as $$
begin
  if old.status in ('published', 'deprecated') and new.definition is distinct from old.definition then
    raise exception 'ontology_versions: definition is immutable once published (I12)';
  end if;

  if old.status = 'published' then
    if new.status is distinct from old.status and new.status <> 'deprecated' then
      raise exception
        'ontology_versions: a published row may only transition to deprecated (I12)';
    end if;
  elsif old.status = 'deprecated' then
    if new.status is distinct from old.status then
      raise exception 'ontology_versions: a deprecated row is terminal (I12)';
    end if;
  end if;

  return new;
end;
$$;
