-- module: governance, version: 0024
--
-- 0024_change_segments (S11 P1-A: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1,
-- §3.2, §3.4, §5.4 and I-A4 / I-A7 / I-A8). The persisted record of a ChangePlan's workspace
-- segment: what was applied, from which source, by whom, and each item's before / after. Owned by
-- `application/change-plan`.
--
-- Scope of this first cut (§5.4 "第一版收窄"): workspace segments only. The owner previews a
-- segment — dry run, classification, digest, nothing stored — and applies it in one transaction
-- (`applyWorkspaceSegment`), so a row is created `applied` by that transaction; verification and
-- rollback move it from there (packages/shared transitions.ts `CHANGE_SEGMENT_EDGES`, reproduced
-- as `change_segment_transition_allowed` below and compared pair by pair in
-- application/change-plan/change-schema.integration.test.ts). Segments proposed by someone other
-- than their approver (`submitted` → `validated` → `approved`) and the platform segment are AA3's;
-- a ChangePlan that spans authorities is a row of its own then. Here `plan_id` only groups the
-- segments of one plan — in P1 exactly one.
--
-- Relations (§3.2), real foreign keys with `workspace_id` in them:
--   * ChangeSegment `proposed_by` / `applied_by` / `rolled_back_by` Principal. The proposer's kind
--     (person or agent, I-A7) is the Principal's own `kind`, not copied here.
--   * ChangeItem `belongs_to` ChangeSegment (ordered by `ordinal`); `confirmed_by` Principal for an
--     `authority_widening` item (I-A4).
--   * `Object changed_by ChangeItem` is the item's `target` (what it changed, e.g. an ontology
--     family) with its `before` / `after` — the provenance S10 calls `installed_from`, and what
--     a rollback compares against before writing (§5.3 "先比较再写"). No column is added to the
--     tables of the objects themselves.
--
-- Guards (`change_segments_guard`, `change_items_guard`):
--   * a segment is created `applied`; its source, reviewed digest, proposer and applier never
--     change; it moves along an edge only; `rolled_back` freezes it (`updated_at` aside);
--   * items are written by the transaction that applies their segment — never added to, changed
--     or removed from an applied segment afterwards (the application role has no UPDATE or DELETE
--     on them either). A widening item is confirmed by the person applying the segment: in P1 the
--     owner applying a segment is the one who confirms its widening items, item by item (AA3 may
--     separate the two when a segment is approved before it is applied).
--
-- New tables that no earlier release reads or writes, so the guards cost no reversibility: rolling
-- back the code leaves rows nothing reads.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

-- ---------------------------------------------------------------------------------------------
-- change_segments
-- ---------------------------------------------------------------------------------------------

create table if not exists change_segments (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  plan_id uuid not null,
  -- Where the intent came from (§5.4 "一个核心，两种来源"): P1 has packs only — a module is a pack
  -- with one ontology component (S10 §6.4). `source_digest` names the content the plan was built
  -- from; `reviewed_digest` the dry run the applier saw, recomputed and compared in the applying
  -- transaction (I-A8).
  source_kind text not null check (source_kind in ('pack')),
  source_name text not null check (length(source_name) between 1 and 200),
  source_version text not null check (length(source_version) between 1 and 64),
  source_digest text not null check (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text not null default 'applied'
    check (status in ('applied', 'verified', 'verification_failed', 'rolled_back')),
  reviewed_digest text not null check (reviewed_digest ~ '^sha256:[0-9a-f]{64}$'),
  proposed_by uuid not null,
  applied_by uuid not null,
  applied_at timestamptz not null default now(),
  -- The latest verification run: when, and each item's result.
  verified_at timestamptz,
  verification jsonb check (verification is null or jsonb_typeof(verification) = 'object'),
  rolled_back_by uuid,
  rolled_back_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, applied_by) references principals (workspace_id, id),
  foreign key (workspace_id, rolled_back_by) references principals (workspace_id, id),
  constraint change_segments_verified check (
    status not in ('verified', 'verification_failed')
    or (verified_at is not null and verification is not null)
  ),
  constraint change_segments_rolled_back check (
    (status = 'rolled_back') = (rolled_back_at is not null)
    and (rolled_back_by is null) = (rolled_back_at is null)
  )
);

-- "What did this source last change here" (provenance, the next plan of the same pack).
create index if not exists change_segments_source
  on change_segments (workspace_id, source_kind, source_name, applied_at desc);

create index if not exists change_segments_plan
  on change_segments (workspace_id, plan_id);

alter table change_segments enable row level security;
drop policy if exists change_segments_workspace_isolation on change_segments;
create policy change_segments_workspace_isolation on change_segments
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant: what was applied, and by whom, stays reconstructable (mirrors action_requests).
grant select, insert, update on change_segments to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- change_items
-- ---------------------------------------------------------------------------------------------

create table if not exists change_items (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  segment_id uuid not null,
  ordinal int not null check (ordinal >= 1),
  -- packages/shared enums.ts `CHANGE_ITEM_KIND_VALUES`.
  kind text not null check (kind in ('ontology_version')),
  -- What the item changes, and its state before (null: it did not exist) and after. The shape is
  -- the item kind's (`application/change-plan/ontology-item.ts` for `ontology_version`).
  target jsonb not null check (jsonb_typeof(target) = 'object'),
  before jsonb check (before is null or jsonb_typeof(before) = 'object'),
  after jsonb not null check (jsonb_typeof(after) = 'object'),
  -- I-A4: `authority_widening` unless every changed field is proven not to widen; `widening`
  -- lists why, and is empty exactly for a `not_widening` item.
  classification text not null check (classification in ('not_widening', 'authority_widening')),
  widening jsonb not null default '[]'::jsonb check (jsonb_typeof(widening) = 'array'),
  confirmed_by uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, segment_id, ordinal),
  foreign key (workspace_id, segment_id) references change_segments (workspace_id, id),
  foreign key (workspace_id, confirmed_by) references principals (workspace_id, id),
  constraint change_items_widening check (
    (classification = 'not_widening') = (jsonb_array_length(widening) = 0)
  ),
  constraint change_items_confirmed check (
    (classification = 'authority_widening') = (confirmed_by is not null)
  )
);

create index if not exists change_items_segment
  on change_items (workspace_id, segment_id, ordinal);

alter table change_items enable row level security;
drop policy if exists change_items_workspace_isolation on change_items;
create policy change_items_workspace_isolation on change_items
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert on change_items to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- Transition table (packages/shared transitions.ts `CHANGE_SEGMENT_EDGES`)
-- ---------------------------------------------------------------------------------------------

create or replace function change_segment_transition_allowed(from_status text, to_status text)
returns boolean language sql immutable as $$
  select exists (
    select 1
      from (values
        ('applied', 'verified'),
        ('applied', 'verification_failed'),
        ('verified', 'verification_failed'),
        ('verification_failed', 'verified'),
        ('applied', 'rolled_back'),
        ('verified', 'rolled_back'),
        ('verification_failed', 'rolled_back')
      ) as edge (from_status, to_status)
     where edge.from_status = $1 and edge.to_status = $2
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------

-- The columns of `new_row` outside `allowed` whose value differs in `old_row`, comma-separated, or
-- null when there is none (same helper shape as goal/0001's `goal_changed_columns`).
create or replace function change_changed_columns(new_row jsonb, old_row jsonb, allowed text[])
returns text language sql immutable as $$
  select string_agg(n.key, ', ' order by n.key)
    from jsonb_each(new_row - allowed) as n
   where n.value is distinct from old_row -> n.key
$$;

create or replace function change_segments_guard() returns trigger
language plpgsql as $$
declare
  changed text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'applied' then
      raise exception 'change_segments: a segment is created applied, by the transaction that applies it, not %',
        new.status;
    end if;
    if new.verified_at is not null or new.verification is not null
       or new.rolled_back_by is not null or new.rolled_back_at is not null then
      raise exception 'change_segments: a new segment has not been verified or rolled back yet';
    end if;
    return new;
  end if;

  changed := change_changed_columns(to_jsonb(new), to_jsonb(old), array[
    'status', 'verified_at', 'verification', 'rolled_back_by', 'rolled_back_at', 'updated_at']);
  if changed is not null then
    raise exception 'change_segments: what a segment applied, from which source, reviewed and applied by whom, never changes (%)',
      changed;
  end if;

  if old.status = 'rolled_back' then
    changed := change_changed_columns(to_jsonb(new), to_jsonb(old), array['updated_at']);
    if changed is not null then
      raise exception 'change_segments: a rolled back segment is final; % cannot change', changed;
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
     and not change_segment_transition_allowed(old.status, new.status) then
    raise exception 'change_segments: illegal transition % -> %', old.status, new.status;
  end if;

  -- A verification result is recorded with a verification run, which also stamps its time.
  if new.verification is distinct from old.verification
     and new.verified_at is not distinct from old.verified_at then
    raise exception 'change_segments: a verification result comes with the time of its run';
  end if;

  return new;
end;
$$;

create or replace trigger change_segments_guard
  before insert or update on change_segments
  for each row execute function change_segments_guard();

-- change_items: written only by the transaction that applies (creates) their segment, never
-- changed afterwards; a widening item's confirmer is the person applying the segment.
create or replace function change_items_guard() returns trigger
language plpgsql as $$
declare
  seg_status text;
  seg_created timestamptz;
  seg_applied_by uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception 'change_items: an applied item never changes';
  end if;

  select s.status, s.created_at, s.applied_by into seg_status, seg_created, seg_applied_by
    from change_segments s
   where s.workspace_id = new.workspace_id and s.id = new.segment_id;
  if not found then
    raise exception 'change_items: segment % does not exist', new.segment_id;
  end if;
  -- `now()` is the transaction's start time, the `created_at` default of a segment inserted by this
  -- same transaction: an item cannot be added to a segment applied earlier.
  if seg_status <> 'applied' or seg_created <> now() then
    raise exception 'change_items: items are written by the transaction that applies their segment';
  end if;
  if new.confirmed_by is not null and new.confirmed_by <> seg_applied_by then
    raise exception 'change_items: a widening item is confirmed by the person applying its segment (I-A4)';
  end if;
  return new;
end;
$$;

create or replace trigger change_items_guard
  before insert or update or delete on change_items
  for each row execute function change_items_guard();
