-- module: worker, version: 0008
--
-- 0008_eval_cases (S10 E3-1b: docs/s10-evolution-plan-2026-10-04.md §3.1 EvalSuite, §3.3 I-E4,
-- §5.5 回归棘轮 / 封闭, §5.6 用例集详情). An evaluation suite's cases (`@nexttime/shared`
-- eval-case.ts says what one holds). Owned by `application/eval`; read and written through
-- human-channel capabilities only and never put in the graph (I-E4), like the rest of 0007.
--
--   * `eval_cases` — one row per case as written. A row never changes but for being retired: an
--     edit retires the row and adds one that `supersedes` it, with the same partition, split,
--     mechanism and origin (fixed when a case is written, E3-1 fork 6); a retirement retires it.
--     Each is a new suite version with its change recorded (`case_added`, `case_edited`,
--     `case_retired`), a reason required for an edit and a retirement — an edit takes the old row
--     out too, so a regression case is never narrowed without one (§5.5 回归棘轮). The suite at
--     version v holds the rows added at or before v and not retired at v, as for fixture gates.
--     `content_digest` is the kernel's `sha256:` over the row's content and fixed fields.
--   * `eval_suite_changes` takes the three new kinds.
--
-- Guards (what the database refuses whoever writes):
--   * a case row is written at its suite's current version, while that version's change is not
--     recorded yet; one that supersedes another replaces a row of the same suite retired at the
--     same version, keeps its partition, split, mechanism and origin, and no row is superseded
--     twice;
--   * a case row only ever has `retired_in_version` and `retire_reason` set, once, together, to its
--     suite's current version — again only while that version's change is not recorded;
--   * a mechanism case names its mechanism and no other case does; `origin` is `human` (E3-1).
-- No DELETE grant: a case is retired, never removed. The workspace purge cascade
-- (application/platform/purge-workspace.ts) runs as the owning role with triggers off and finds
-- this table by its `workspace_id` like any other.
--
-- Reversible: a new table nothing earlier reads or writes, and two check constraints that now take
-- three more kinds the previous release never writes; a release without evaluation suites runs on
-- this schema unchanged. One limit: a release with 0007 but not this migration does not know the
-- three kinds, so rolled back to one after a case was written, its `get_eval_suite` fails on that
-- suite's history. No such release exists — 0007 and 0008 both come after v0.49.0, the last one —
-- so the two must ship in the same release (release.md says so).
--
-- Advisory lock: same module key as 0001–0007.
select pg_advisory_xact_lock(7241000501);

-- ---------------------------------------------------------------------------------------------
-- eval_suite_changes: three more kinds
-- ---------------------------------------------------------------------------------------------

alter table eval_suite_changes drop constraint if exists eval_suite_changes_kind;
alter table eval_suite_changes add constraint eval_suite_changes_kind check (
  kind in (
    'created', 'repinned', 'fixture_gate_added', 'fixture_gate_synced', 'fixture_gate_removed',
    'case_added', 'case_edited', 'case_retired'
  )
);

alter table eval_suite_changes drop constraint if exists eval_suite_changes_removal_reason;
alter table eval_suite_changes add constraint eval_suite_changes_removal_reason check (
  kind not in ('fixture_gate_removed', 'case_edited', 'case_retired') or reason is not null
);

-- ---------------------------------------------------------------------------------------------
-- eval_cases
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_cases (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  suite_id uuid not null,
  title text not null,
  partition text not null,
  split text not null,
  mechanism text,
  origin text not null default 'human',
  input jsonb not null,
  fixtures jsonb not null,
  assertions jsonb not null,
  content_digest text not null,
  added_in_version int not null,
  retired_in_version int,
  retire_reason text,
  supersedes uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint eval_cases_title check (char_length(btrim(title)) between 1 and 120),
  constraint eval_cases_partition check (partition in ('regression', 'mechanism', 'full')),
  constraint eval_cases_split check (split in ('dev', 'holdout')),
  constraint eval_cases_mechanism check (
    (partition = 'mechanism') = (mechanism is not null)
    and (mechanism is null or char_length(btrim(mechanism)) between 1 and 120)
  ),
  constraint eval_cases_origin check (origin in ('human')),
  constraint eval_cases_content check (
    jsonb_typeof(input) <> 'null'
    and jsonb_typeof(fixtures) = 'array'
    and jsonb_typeof(assertions) = 'array'
    and jsonb_array_length(assertions) >= 1
  ),
  constraint eval_cases_digest check (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  constraint eval_cases_versions check (
    added_in_version >= 1 and (retired_in_version is null or retired_in_version > added_in_version)
  ),
  constraint eval_cases_retirement check (
    (retired_in_version is null) = (retire_reason is null)
    and (retire_reason is null or char_length(btrim(retire_reason)) between 1 and 500)
  ),
  foreign key (workspace_id, suite_id) references eval_suites (workspace_id, id),
  foreign key (workspace_id, supersedes) references eval_cases (workspace_id, id),
  foreign key (workspace_id, created_by) references principals (workspace_id, id)
);

create index if not exists eval_cases_suite
  on eval_cases (workspace_id, suite_id, added_in_version);

-- An edit replaces one row; no row is replaced twice.
create unique index if not exists eval_cases_superseded_once
  on eval_cases (workspace_id, supersedes)
  where supersedes is not null;

alter table eval_cases enable row level security;
drop policy if exists eval_cases_workspace_isolation on eval_cases;
create policy eval_cases_workspace_isolation on eval_cases
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on eval_cases to nexttime_app;

create or replace function eval_cases_guard() returns trigger
language plpgsql as $$
declare
  current_version int;
  replaced record;
begin
  if tg_op = 'DELETE' then
    raise exception 'eval_cases: a case is retired, never deleted';
  end if;

  select version into current_version
    from eval_suites
   where workspace_id = new.workspace_id and id = new.suite_id;

  if tg_op = 'INSERT' then
    if new.added_in_version is distinct from current_version
      or new.retired_in_version is not null or new.retire_reason is not null then
      raise exception 'eval_cases: a case is added at its suite''s current version (%)', current_version;
    end if;
    if new.supersedes is not null then
      select suite_id, retired_in_version, partition, split, mechanism, origin into replaced
        from eval_cases
       where workspace_id = new.workspace_id and id = new.supersedes;
      if replaced.suite_id is distinct from new.suite_id
        or replaced.retired_in_version is distinct from new.added_in_version then
        raise exception 'eval_cases: an edited case replaces a case of the same suite retired at the same suite version';
      end if;
      if replaced.partition is distinct from new.partition
        or replaced.split is distinct from new.split
        or replaced.mechanism is distinct from new.mechanism
        or replaced.origin is distinct from new.origin then
        raise exception 'eval_cases: an edit keeps the case''s partition, split, mechanism and origin';
      end if;
    end if;
    -- Once the version's change is recorded, what that version holds is settled.
    if exists (
      select 1 from eval_suite_changes
       where workspace_id = new.workspace_id and suite_id = new.suite_id and version = current_version
    ) then
      raise exception 'eval_cases: suite version % is already recorded; a case changes only in a new suite version', current_version;
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
    or new.id is distinct from old.id
    or new.suite_id is distinct from old.suite_id
    or new.title is distinct from old.title
    or new.partition is distinct from old.partition
    or new.split is distinct from old.split
    or new.mechanism is distinct from old.mechanism
    or new.origin is distinct from old.origin
    or new.input is distinct from old.input
    or new.fixtures is distinct from old.fixtures
    or new.assertions is distinct from old.assertions
    or new.content_digest is distinct from old.content_digest
    or new.added_in_version is distinct from old.added_in_version
    or new.supersedes is distinct from old.supersedes
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'eval_cases: a case row never changes; an edit adds a new one';
  end if;
  if old.retired_in_version is not null then
    raise exception 'eval_cases: a retired case stays retired';
  end if;
  if new.retired_in_version is distinct from current_version then
    raise exception 'eval_cases: a case is retired at its suite''s current version (%)', current_version;
  end if;
  if exists (
    select 1 from eval_suite_changes
     where workspace_id = new.workspace_id and suite_id = new.suite_id and version = current_version
  ) then
    raise exception 'eval_cases: suite version % is already recorded; a case changes only in a new suite version', current_version;
  end if;
  return new;
end;
$$;

create or replace trigger eval_cases_guard
  before insert or update or delete on eval_cases
  for each row execute function eval_cases_guard();
