-- module: worker, version: 0007
--
-- 0007_eval_suites (S10 E3-1a: docs/s10-evolution-plan-2026-10-04.md §3.1 EvalSuite, §3.3 I-E4,
-- §5.5, §5.6 用例集详情). An evaluation suite's shell: the frozen set a Skill draft is evaluated
-- against (E3-2), before it holds any case (E3-1b adds `eval_cases`). Owned by
-- `application/eval`; read and written through human-channel capabilities only and never put in
-- the graph (I-E4 "评测对人透明、对 agent 封闭": `search` / `explain` read the graph, so nothing
-- here is an Object, a Fact or an Observation).
--
--   * `eval_suites` — the suite. It pins one published worker-kind WorkerDefinition version (the
--     template evaluated runs start from, §5.5 "基线"): a repin moves to another published version
--     of the same WorkerDefinition, never to another one (another template is another suite). It
--     carries a `canary` (a random string a person sees and an agent never does; E3-2/3 look for
--     it in drafts and transcripts) and a `version`: 1 when created, one more for every change
--     after (repin, a fixture gate added, synced or removed — later, a case added or retired). An
--     evaluation run records the version it used. The name, description and canary never change.
--   * `eval_suite_changes` — one row per suite version, append-only: who made it, when, what
--     (`kind`, `detail`) and why (`reason`, required for a removal). The suite's history.
--   * `eval_fixture_gates` — the stand-ins of real gates the suite's cases are answered through
--     (§5.5 夹具门, E3 fork 5 = a: the kernel answers every call from the case's fixture, no gate is
--     ever called). Each row freezes, when added, the gate's name and its published Operations as
--     list_allowed_operations shows them (`snapshot`, digested in `snapshot_digest`), so an
--     evaluated Worker sees the tool names and params it would see in production. Rows are never
--     edited: syncing a gate whose definition changed retires its row and adds a new one that
--     `supersedes` it; removing one retires it. The suite at version v holds the rows added at or
--     before v and not retired at v; at most one live row per gate.
--
-- Module: these tables reference `worker_definitions` (and E3-2's runs reference `tasks` and
-- `skills`), and `discoverMigrations` runs modules in directory order (… task < worker), so they
-- belong to the last module, `worker`. Nothing earlier references them.
--
-- Guards (what the database refuses whoever writes):
--   * a suite pins only a published worker-kind version, and its version moves by exactly one per
--     update; everything else on the row is fixed — its WorkerDefinition included;
--   * every suite version has exactly one change row (checked at commit), written at that version;
--     change rows are never updated or deleted;
--   * a fixture gate row names a Gatekeeper object, is written at its suite's current version, and
--     only ever has `retired_in_version` set, once, to its suite's current version — and only
--     while that version's change is not recorded yet (a gate added or retired at a recorded
--     version would change what that version held after the fact; the kernel steps the version,
--     writes the gate, then records the change, all in one transaction).
-- No DELETE grant on any of them: cases and suites are retired, never removed (§5.5 回归棘轮). The
-- workspace purge cascade (application/platform/purge-workspace.ts) runs as the owning role with
-- triggers off and finds these tables by their `workspace_id` like any other.
--
-- Reversible: new tables nothing earlier reads or writes; the previous release runs on this schema
-- unchanged.
--
-- Advisory lock: same module key as 0001–0006.
select pg_advisory_xact_lock(7241000501);

-- ---------------------------------------------------------------------------------------------
-- eval_suites
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_suites (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  name text not null,
  description text not null default '',
  worker_definition_id uuid not null,
  worker_definition_version int not null,
  canary text not null,
  version int not null default 1,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint eval_suites_name check (char_length(btrim(name)) between 1 and 120),
  constraint eval_suites_description check (char_length(description) <= 2000),
  constraint eval_suites_canary check (canary ~ '^NTEVAL-[0-9a-f]{32}$'),
  constraint eval_suites_version check (version >= 1),
  foreign key (workspace_id, created_by) references principals (workspace_id, id),
  foreign key (workspace_id, worker_definition_id, worker_definition_version)
    references worker_definitions (workspace_id, id, version)
);

-- One name per suite in a workspace, as people tell them apart (case and surrounding blanks
-- ignored).
create unique index if not exists eval_suites_name_unique
  on eval_suites (workspace_id, lower(btrim(name)));

create unique index if not exists eval_suites_canary_unique on eval_suites (canary);

alter table eval_suites enable row level security;
drop policy if exists eval_suites_workspace_isolation on eval_suites;
create policy eval_suites_workspace_isolation on eval_suites
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on eval_suites to nexttime_app;

create or replace function eval_suites_guard() returns trigger
language plpgsql as $$
declare
  pinned_kind text;
  pinned_status text;
begin
  if tg_op = 'INSERT' then
    if new.version <> 1 then
      raise exception 'eval_suites: a suite starts at version 1';
    end if;
  else
    if new.workspace_id is distinct from old.workspace_id
      or new.id is distinct from old.id
      or new.name is distinct from old.name
      or new.description is distinct from old.description
      or new.canary is distinct from old.canary
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or new.worker_definition_id is distinct from old.worker_definition_id then
      raise exception 'eval_suites: only the pinned version and the suite version change after a suite is created';
    end if;
    if new.version <> old.version + 1 then
      raise exception 'eval_suites: every change moves the suite version by exactly one (from % to %)', old.version, new.version;
    end if;
    if new.worker_definition_version = old.worker_definition_version then
      return new;
    end if;
  end if;

  select kind, status into pinned_kind, pinned_status
    from worker_definitions
   where workspace_id = new.workspace_id
     and id = new.worker_definition_id
     and version = new.worker_definition_version;
  if pinned_kind is distinct from 'worker' or pinned_status is distinct from 'published' then
    raise exception 'eval_suites: a suite pins a published worker-kind WorkerDefinition version';
  end if;
  return new;
end;
$$;

create or replace trigger eval_suites_guard
  before insert or update on eval_suites
  for each row execute function eval_suites_guard();

-- ---------------------------------------------------------------------------------------------
-- eval_suite_changes
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_suite_changes (
  workspace_id uuid not null,
  suite_id uuid not null,
  version int not null,
  kind text not null,
  actor_id uuid not null,
  reason text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, suite_id, version),
  constraint eval_suite_changes_kind check (
    kind in ('created', 'repinned', 'fixture_gate_added', 'fixture_gate_synced', 'fixture_gate_removed')
  ),
  constraint eval_suite_changes_version check (version >= 1),
  constraint eval_suite_changes_created check ((kind = 'created') = (version = 1)),
  constraint eval_suite_changes_reason check (reason is null or char_length(btrim(reason)) between 1 and 500),
  constraint eval_suite_changes_removal_reason check (kind <> 'fixture_gate_removed' or reason is not null),
  constraint eval_suite_changes_detail check (jsonb_typeof(detail) = 'object'),
  foreign key (workspace_id, suite_id) references eval_suites (workspace_id, id),
  foreign key (workspace_id, actor_id) references principals (workspace_id, id)
);

alter table eval_suite_changes enable row level security;
drop policy if exists eval_suite_changes_workspace_isolation on eval_suite_changes;
create policy eval_suite_changes_workspace_isolation on eval_suite_changes
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert on eval_suite_changes to nexttime_app;

create or replace function eval_suite_changes_guard() returns trigger
language plpgsql as $$
declare
  current_version int;
begin
  if tg_op <> 'INSERT' then
    raise exception 'eval_suite_changes: a suite''s history is append-only';
  end if;
  select version into current_version
    from eval_suites
   where workspace_id = new.workspace_id and id = new.suite_id;
  if current_version is distinct from new.version then
    raise exception 'eval_suite_changes: a change is recorded at its suite''s current version (%), not %', current_version, new.version;
  end if;
  return new;
end;
$$;

create or replace trigger eval_suite_changes_guard
  before insert or update or delete on eval_suite_changes
  for each row execute function eval_suite_changes_guard();

-- Every suite version has its change row by the time the transaction that made it commits.
create or replace function eval_suites_version_recorded() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from eval_suite_changes
     where workspace_id = new.workspace_id and suite_id = new.id and version = new.version
  ) then
    raise exception 'eval_suites: suite % reached version % without a change recorded for it', new.id, new.version;
  end if;
  return null;
end;
$$;

drop trigger if exists eval_suites_version_recorded on eval_suites;
create constraint trigger eval_suites_version_recorded
  after insert or update on eval_suites
  deferrable initially deferred
  for each row execute function eval_suites_version_recorded();

-- ---------------------------------------------------------------------------------------------
-- eval_fixture_gates
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_fixture_gates (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  suite_id uuid not null,
  gatekeeper_id uuid not null,
  snapshot jsonb not null,
  snapshot_digest text not null,
  added_in_version int not null,
  retired_in_version int,
  supersedes uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint eval_fixture_gates_snapshot check (
    jsonb_typeof(snapshot) = 'object' and jsonb_typeof(snapshot -> 'operations') = 'array'
  ),
  constraint eval_fixture_gates_digest check (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  constraint eval_fixture_gates_versions check (
    added_in_version >= 1 and (retired_in_version is null or retired_in_version > added_in_version)
  ),
  foreign key (workspace_id, suite_id) references eval_suites (workspace_id, id),
  foreign key (workspace_id, gatekeeper_id) references objects (workspace_id, id),
  foreign key (workspace_id, supersedes) references eval_fixture_gates (workspace_id, id),
  foreign key (workspace_id, created_by) references principals (workspace_id, id)
);

create unique index if not exists eval_fixture_gates_one_live
  on eval_fixture_gates (workspace_id, suite_id, gatekeeper_id)
  where retired_in_version is null;

create index if not exists eval_fixture_gates_suite
  on eval_fixture_gates (workspace_id, suite_id, added_in_version);

alter table eval_fixture_gates enable row level security;
drop policy if exists eval_fixture_gates_workspace_isolation on eval_fixture_gates;
create policy eval_fixture_gates_workspace_isolation on eval_fixture_gates
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on eval_fixture_gates to nexttime_app;

create or replace function eval_fixture_gates_guard() returns trigger
language plpgsql as $$
declare
  current_version int;
  gate_type text;
  replaced record;
begin
  if tg_op = 'DELETE' then
    raise exception 'eval_fixture_gates: a fixture gate is retired, never deleted';
  end if;

  select version into current_version
    from eval_suites
   where workspace_id = new.workspace_id and id = new.suite_id;

  if tg_op = 'INSERT' then
    if new.added_in_version is distinct from current_version or new.retired_in_version is not null then
      raise exception 'eval_fixture_gates: a fixture gate is added at its suite''s current version (%)', current_version;
    end if;
    select object_type into gate_type
      from objects
     where workspace_id = new.workspace_id and id = new.gatekeeper_id;
    if gate_type is distinct from 'Gatekeeper' then
      raise exception 'eval_fixture_gates: % is not a Gatekeeper', new.gatekeeper_id;
    end if;
    if new.supersedes is not null then
      select suite_id, gatekeeper_id, retired_in_version into replaced
        from eval_fixture_gates
       where workspace_id = new.workspace_id and id = new.supersedes;
      if replaced.suite_id is distinct from new.suite_id
        or replaced.gatekeeper_id is distinct from new.gatekeeper_id
        or replaced.retired_in_version is distinct from new.added_in_version then
        raise exception 'eval_fixture_gates: a synced fixture gate replaces the row of the same gate retired at the same suite version';
      end if;
    end if;
    -- Once the version's change is recorded, what that version holds is settled.
    if exists (
      select 1 from eval_suite_changes
       where workspace_id = new.workspace_id and suite_id = new.suite_id and version = current_version
    ) then
      raise exception 'eval_fixture_gates: suite version % is already recorded; a fixture gate changes only in a new suite version', current_version;
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
    or new.id is distinct from old.id
    or new.suite_id is distinct from old.suite_id
    or new.gatekeeper_id is distinct from old.gatekeeper_id
    or new.snapshot is distinct from old.snapshot
    or new.snapshot_digest is distinct from old.snapshot_digest
    or new.added_in_version is distinct from old.added_in_version
    or new.supersedes is distinct from old.supersedes
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'eval_fixture_gates: a fixture gate row never changes; sync adds a new one';
  end if;
  if old.retired_in_version is not null then
    raise exception 'eval_fixture_gates: a retired fixture gate stays retired';
  end if;
  if new.retired_in_version is distinct from current_version then
    raise exception 'eval_fixture_gates: a fixture gate is retired at its suite''s current version (%)', current_version;
  end if;
  if exists (
    select 1 from eval_suite_changes
     where workspace_id = new.workspace_id and suite_id = new.suite_id and version = current_version
  ) then
    raise exception 'eval_fixture_gates: suite version % is already recorded; a fixture gate changes only in a new suite version', current_version;
  end if;
  return new;
end;
$$;

create or replace trigger eval_fixture_gates_guard
  before insert or update or delete on eval_fixture_gates
  for each row execute function eval_fixture_gates_guard();
