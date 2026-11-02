-- module: governance, version: 0034
--
-- 0034_admin_proposal_platform_segments (S11 AA3c-1: docs/goal-orchestration-and-admin-agent-plan-
-- 2026-10-16.md §3.1–§3.3, §5.4, I-A4 / I-A5 / I-A7 / I-A8; the AA3 default plan F6 / F8 / F12 and
-- the AA3c plan F-c1–F-c7). An admin proposal (0032) may hold one platform segment beside its
-- workspace segments: new gate-host instances (`gate_instance`, the whitelist) that a platform
-- administrator previews, applies and rejects on the platform plane
-- (`application/change-plan/platform-segments.ts`), and whose apply is recorded on the platform
-- as a platform change segment — the platform's counterpart of a workspace's `change_segments` —
-- rolled back from there.
--
-- What changes on `admin_proposal_segments`:
--   * `authority` takes `platform`: no target workspace (0032's `admin_proposal_segments_target`
--     already says so), at most one per proposal (`admin_proposal_segments_one_platform`), items
--     of the platform kinds only — `gate_instance` — and a workspace segment never one of those
--     (`admin_proposal_segments_item_kinds`; packages/shared `ADMIN_PROPOSAL_PLATFORM_ITEM_KIND_VALUES`
--     and the workspace `AdminProposalItemIntentWireSchema` kinds).
--   * A platform segment is decided by a platform user, not a workspace's Principal: who applied or
--     rejected it is `decided_by_user`, who rolled it back `rolled_back_by_user`, and what its
--     apply recorded `applied_platform_segment_id` (a `platform_change_segments` row). A workspace
--     segment keeps `decided_by` / `rolled_back_by` / `applied_segment_id` and never sets the new
--     three; a platform segment never sets the old three (`admin_proposal_segments_decision`).
--   * `withdrawn_origin` takes `platform_segment`: a workspace segment withdrawn because the
--     proposal's platform segment — which every workspace segment of the proposal depends on — was
--     rejected or rolled back, in the same platform-plane transaction, by its administrator.
--
-- Relations (new):
--   * PlatformChangeSegment `records` the AdminProposalSegment of authority `platform` it applied
--     (`admin_proposal_segment_id`, one record per segment) and `proposed_by` the platform user
--     whose admin agent proposed it; `applied_by` / `rolled_back_by` platform users. Like 0033's
--     admin-proposal columns on `change_segments`, the source has no foreign key: the proposal lives
--     in its trial workspace and goes when that is purged, while the record stays.
--   * PlatformChangeItem `belongs_to` its PlatformChangeSegment, `created` the gate instance
--     `gate_id` — no foreign key either: an instance no workspace enabled can be deleted
--     (`delete_gate_instance`), and the record keeps what it created.
--   * Never: a record of a workspace segment; a record not written by the applying transaction; a
--     record changed after it was written except applied → rolled_back; an item written later.
--
-- Guards:
--   * `admin_proposal_segments_guard` (0032's, replaced): a platform segment is applied, rejected
--     and rolled back on the platform plane only, never in a workspace; a workspace segment, as
--     before, in its target workspace only. Withdrawn with origin `platform_segment` only on the
--     platform plane, for a workspace segment, while its proposal's platform segment is rejected
--     or rolled back — any other platform-plane withdrawal is `human`, as before.
--   * `admin_proposal_segments_record_guard` (0033's, replaced): for a platform segment, who
--     applied, rejected or rolled it back is the transaction's acting administrator
--     (`app.user_id`, adapters/db/platform-context.ts); `applied_platform_segment_id` is the platform
--     change segment that records this segment, and the segment is rolled back only once that
--     record is. Workspace segments: unchanged.
--   * `platform_change_segments_guard`: written on the platform plane only, by its acting
--     administrator, created `applied` while its source segment is a platform segment still
--     `proposed` (the applying transaction moves it to `applied` right after), and its source and
--     proposer are that segment's and its proposal's. Only applied → rolled_back afterwards, by the
--     acting administrator; never deleted.
--   * `platform_change_items_guard`: written by the transaction that wrote its record, never
--     changed or deleted; an `authority_widening` item names the administrator who confirmed it —
--     the one applying it (I-A4).
--   * RLS: both new tables are the platform plane's only (`app_platform()`), forced.
--
-- A target workspace reads its proposal's platform segment through
-- `admin_proposal_platform_segment(proposal_id)` (`security definer`, core 0042's rule: it answers
-- only for the transaction's own workspace, and only when that workspace is the target of one of the
-- proposal's workspace segments). A policy cannot say that: it would read `admin_proposal_segments`
-- from inside `admin_proposal_segments`' own policy. The segment holds gate definitions only, which
-- every workspace can already read of the instances themselves (`gate_instances`).
--
-- Reversibility: a release before this one never reads `authority = 'platform'` (its reads filter
-- nothing on it, but it never writes one) and never writes the new columns; its own paths keep
-- every new check (they write workspace segments and `human` / `agent` origins only). Rolling back
-- the code alone corrupts nothing while no platform segment exists; once one does, the old code
-- lists it with a null target and cannot decide it — apply or reject it on this release first
-- (or withdraw the proposal), then roll back the code. To take the migration out (only with no
-- platform segment and no `platform_segment` origin left): drop the two new tables, the function
-- `admin_proposal_platform_segment`, the index `admin_proposal_segments_one_platform`, the checks
-- `admin_proposal_segments_item_kinds` and the new `admin_proposal_segments_decision` /
-- `admin_proposal_segments_rolled_back` (restore 0032's), restore the `authority` check to
-- `('workspace')` and the `withdrawn_origin` check to `('human', 'agent')`, re-run 0032's
-- `admin_proposal_segments_guard` and 0033's `admin_proposal_segments_record_guard` bodies, drop
-- the three columns, then `delete from schema_migrations where module = 'governance' and version =
-- 34`.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).

select pg_advisory_xact_lock(7241000201);

-- ---------------------------------------------------------------------------------------------
-- admin_proposal_segments: the platform authority
-- ---------------------------------------------------------------------------------------------

alter table admin_proposal_segments drop constraint if exists admin_proposal_segments_authority_check;
alter table admin_proposal_segments add constraint admin_proposal_segments_authority_check
  check (authority in ('workspace', 'platform'));

alter table admin_proposal_segments drop constraint if exists admin_proposal_segments_withdrawn_origin_check;
alter table admin_proposal_segments add constraint admin_proposal_segments_withdrawn_origin_check
  check (withdrawn_origin in ('human', 'agent', 'platform_segment'));

alter table admin_proposal_segments add column if not exists decided_by_user uuid references users (id);
alter table admin_proposal_segments add column if not exists rolled_back_by_user uuid references users (id);
alter table admin_proposal_segments add column if not exists applied_platform_segment_id uuid;

create unique index if not exists admin_proposal_segments_one_platform
  on admin_proposal_segments (proposal_id)
  where authority = 'platform';

-- The kinds each authority's segment may hold (see the header), counted the positive way: every
-- item is an object whose `kind` is a string naming one of them. (A negative filter would let an
-- item through whose `kind` is not a string — lax mode makes that comparison unknown, and the
-- filter selects nothing — or an array holding the name, which lax mode unwraps; review of #921.)
-- `strict`, so an item that is itself an array is one item, not unwrapped into the objects it holds
-- (lax `$[*] ? (…)` counts `[[{"kind":"gate_instance"},{"kind":"x"}]]` as one passing item); an item
-- without a `kind` makes the filter an error, which counts as unknown, so it is not counted either.
alter table admin_proposal_segments drop constraint if exists admin_proposal_segments_item_kinds;
alter table admin_proposal_segments add constraint admin_proposal_segments_item_kinds check (
  case authority
    when 'platform' then
      jsonb_array_length(items) <= 10
      and jsonb_array_length(jsonb_path_query_array(items,
        'strict $[*] ? (@.kind.type() == "string" && @.kind == "gate_instance")'))
        = jsonb_array_length(items)
    else
      jsonb_array_length(jsonb_path_query_array(items,
        'strict $[*] ? (@.kind.type() == "string" && (@.kind == "skill_version" || @.kind == "worker_definition_version" || @.kind == "ontology_version" || @.kind == "operation_version"))'))
        = jsonb_array_length(items)
  end
);

-- Each status with exactly the decision fields it has: a workspace segment's deciders are its
-- target's Principals, a platform segment's platform users (see the header).
alter table admin_proposal_segments drop constraint if exists admin_proposal_segments_decision;
alter table admin_proposal_segments add constraint admin_proposal_segments_decision check (
  case authority
    when 'platform' then
      decided_by is null and rolled_back_by is null and applied_segment_id is null
    else
      decided_by_user is null and rolled_back_by_user is null and applied_platform_segment_id is null
  end
  and case status
    when 'proposed' then
      decided_by is null and decided_by_user is null and decided_at is null
      and withdrawn_by_user is null and withdrawn_origin is null and reason is null
      and applied_segment_id is null and applied_platform_segment_id is null
    when 'applied' then
      (decided_by is not null or decided_by_user is not null) and decided_at is not null
      and withdrawn_by_user is null and withdrawn_origin is null and reason is null
      and (applied_segment_id is not null or applied_platform_segment_id is not null)
    when 'rolled_back' then
      (decided_by is not null or decided_by_user is not null) and decided_at is not null
      and withdrawn_by_user is null and withdrawn_origin is null and reason is null
      and (applied_segment_id is not null or applied_platform_segment_id is not null)
    when 'rejected' then
      (decided_by is not null or decided_by_user is not null) and decided_at is not null
      and withdrawn_by_user is null and withdrawn_origin is null and reason is not null
      and applied_segment_id is null and applied_platform_segment_id is null
    when 'withdrawn' then
      decided_by is null and decided_by_user is null and decided_at is not null
      and withdrawn_by_user is not null and withdrawn_origin is not null
      and applied_segment_id is null and applied_platform_segment_id is null
  end
  -- Only a workspace segment is withdrawn with its platform segment.
  and (withdrawn_origin is distinct from 'platform_segment' or authority = 'workspace')
);

alter table admin_proposal_segments drop constraint if exists admin_proposal_segments_rolled_back;
alter table admin_proposal_segments add constraint admin_proposal_segments_rolled_back check (
  (status = 'rolled_back') = (rolled_back_at is not null)
  and (rolled_back_by is not null or rolled_back_by_user is not null) = (rolled_back_at is not null)
);

-- ---------------------------------------------------------------------------------------------
-- platform_change_segments / platform_change_items: what a platform segment's apply recorded
-- ---------------------------------------------------------------------------------------------

create table if not exists platform_change_segments (
  id uuid primary key default gen_random_uuid(),
  -- The source: the proposal and its platform segment (no foreign keys, see the header).
  admin_proposal_id uuid not null,
  admin_proposal_segment_id uuid not null unique,
  source_name text not null
    check (source_name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(source_name) <= 64),
  -- The platform segment's `content_digest`.
  source_digest text not null check (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- I-A7: the platform user whose admin agent proposed it, by the name they had then.
  proposed_by_user uuid not null references users (id),
  proposer_display_name text not null check (length(proposer_display_name) between 1 and 200),
  -- I-A8: the dry run the administrator reviewed.
  reviewed_digest text not null check (reviewed_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text not null default 'applied' check (status in ('applied', 'rolled_back')),
  applied_by_user uuid not null references users (id),
  applied_at timestamptz not null default now(),
  rolled_back_by_user uuid references users (id),
  rolled_back_at timestamptz,
  constraint platform_change_segments_rolled_back check (
    (status = 'rolled_back') = (rolled_back_at is not null)
    and (rolled_back_by_user is not null) = (rolled_back_at is not null)
  )
);

create index if not exists platform_change_segments_time on platform_change_segments (applied_at desc);
create index if not exists platform_change_segments_proposal on platform_change_segments (admin_proposal_id);

create table if not exists platform_change_items (
  change_segment_id uuid not null references platform_change_segments (id),
  ordinal int not null check (ordinal >= 1),
  kind text not null check (kind in ('gate_instance')),
  classification text not null check (classification in ('not_widening', 'authority_widening')),
  -- The widening reasons the dry run gave (packages/shared `ChangeWideningReasonWireSchema`).
  widening jsonb not null check (jsonb_typeof(widening) = 'array'),
  -- I-A4: the administrator who confirmed an authority-widening item — the one applying it.
  confirmed_by_user uuid references users (id),
  -- The instance it created, as created: what a rollback compares before it disables it.
  gate_id text not null check (gate_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  display_name text not null check (length(display_name) between 1 and 120),
  connector text not null check (connector ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Applying it created the connector (none had that name).
  connector_created boolean not null,
  -- The hosted definition written (`gate_instances.definition`).
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  primary key (change_segment_id, ordinal),
  constraint platform_change_items_widening check (
    (classification = 'not_widening') = (jsonb_array_length(widening) = 0)
  ),
  constraint platform_change_items_confirmed check (
    (classification = 'authority_widening') = (confirmed_by_user is not null)
  )
);

create index if not exists platform_change_items_gate on platform_change_items (gate_id);

alter table platform_change_segments enable row level security;
alter table platform_change_segments force row level security;
drop policy if exists platform_change_segments_platform on platform_change_segments;
create policy platform_change_segments_platform on platform_change_segments
  for all
  using (app_platform())
  with check (app_platform());
grant select, insert, update on platform_change_segments to nexttime_app;

alter table platform_change_items enable row level security;
alter table platform_change_items force row level security;
drop policy if exists platform_change_items_platform on platform_change_items;
create policy platform_change_items_platform on platform_change_items
  for all
  using (app_platform())
  with check (app_platform());
grant select, insert on platform_change_items to nexttime_app;

create or replace function platform_change_segments_guard() returns trigger
language plpgsql as $$
declare
  acting_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  proposed record;
  changed text;
begin
  if tg_op = 'DELETE' then
    raise exception 'platform_change_segments: a platform change segment is never removed';
  end if;
  if not app_platform() then
    raise exception 'platform_change_segments: written on the platform plane only';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'applied' then
      raise exception 'platform_change_segments: a record is created applied, not %', new.status;
    end if;
    if new.applied_by_user is distinct from acting_user then
      raise exception 'platform_change_segments: applied by the acting administrator of this transaction';
    end if;
    select s.authority, s.status, s.proposal_id, s.content_digest,
           p.source_name, p.proposed_by_user, p.proposer_display_name
      into proposed
      from admin_proposal_segments s
      join admin_proposals p on p.workspace_id = s.workspace_id and p.id = s.proposal_id
     where s.id = new.admin_proposal_segment_id;
    if not found or proposed.authority is distinct from 'platform' then
      raise exception 'platform_change_segments: a record records a platform segment (% is not one)',
        new.admin_proposal_segment_id;
    end if;
    if proposed.status <> 'proposed' then
      raise exception 'platform_change_segments: a platform segment is applied while it is proposed, not %',
        proposed.status;
    end if;
    if proposed.proposal_id is distinct from new.admin_proposal_id
       or proposed.content_digest is distinct from new.source_digest
       or proposed.source_name is distinct from new.source_name
       or proposed.proposed_by_user is distinct from new.proposed_by_user
       or proposed.proposer_display_name is distinct from new.proposer_display_name then
      raise exception 'platform_change_segments: a record''s source and proposer are its platform segment''s proposal, content digest and proposer';
    end if;
    new.applied_at := now();
    new.rolled_back_by_user := null;
    new.rolled_back_at := null;
    return new;
  end if;

  changed := change_changed_columns(to_jsonb(new), to_jsonb(old),
    array['status', 'rolled_back_by_user', 'rolled_back_at']);
  if changed is not null then
    raise exception 'platform_change_segments: what a record records never changes (%)', changed;
  end if;
  if new.status is not distinct from old.status then
    if new.rolled_back_by_user is distinct from old.rolled_back_by_user
       or new.rolled_back_at is distinct from old.rolled_back_at then
      raise exception 'platform_change_segments: rolled_back_by_user / rolled_back_at change only with the rollback';
    end if;
    return new;
  end if;
  if not (old.status = 'applied' and new.status = 'rolled_back') then
    raise exception 'platform_change_segments: illegal transition % -> %', old.status, new.status;
  end if;
  if new.rolled_back_by_user is distinct from acting_user then
    raise exception 'platform_change_segments: rolled back by the acting administrator of this transaction';
  end if;
  new.rolled_back_at := now();
  return new;
end;
$$;

create or replace trigger platform_change_segments_guard
  before insert or update or delete on platform_change_segments
  for each row execute function platform_change_segments_guard();

create or replace function platform_change_items_guard() returns trigger
language plpgsql as $$
declare
  acting_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception 'platform_change_items: an item never changes once recorded';
  end if;
  if not app_platform() then
    raise exception 'platform_change_items: written on the platform plane only';
  end if;
  -- `applied_at` is the applying transaction's `now()` (the guard above sets it): an item cannot be
  -- added to a record written earlier.
  if not exists (
    select 1 from platform_change_segments c
     where c.id = new.change_segment_id and c.status = 'applied' and c.applied_at = now()
  ) then
    raise exception 'platform_change_items: items are written by the transaction that writes their record';
  end if;
  if new.confirmed_by_user is not null and new.confirmed_by_user is distinct from acting_user then
    raise exception 'platform_change_items: confirmed by the acting administrator of this transaction';
  end if;
  return new;
end;
$$;

create or replace trigger platform_change_items_guard
  before insert or update or delete on platform_change_items
  for each row execute function platform_change_items_guard();

-- ---------------------------------------------------------------------------------------------
-- admin_proposal_segments_guard (0032's, with the platform authority)
-- ---------------------------------------------------------------------------------------------

create or replace function admin_proposal_segments_guard() returns trigger
language plpgsql as $$
declare
  proposal_created timestamptz;
  target_purpose text;
  changed text;
  platform_status text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'admin_proposal_segments: a segment is created proposed, not %', new.status;
    end if;
    select c.created_at into proposal_created
      from admin_proposals c
     where c.workspace_id = new.workspace_id and c.id = new.proposal_id;
    if not found then
      raise exception 'admin_proposal_segments: proposal % does not exist in this workspace', new.proposal_id;
    end if;
    -- `now()` is the transaction's start time, the `created_at` of a proposal this transaction
    -- proposed: a segment cannot be added to a proposal made earlier.
    if proposal_created <> now() then
      raise exception 'admin_proposal_segments: segments are written by the transaction that makes their proposal';
    end if;
    -- §3.2: never addressed to a trial workspace (the kernel refuses it first, with a reason).
    if new.target_workspace_id is not null then
      select w.purpose into target_purpose from workspaces w where w.id = new.target_workspace_id;
      if target_purpose = 'admin_trial' then
        raise exception 'admin_proposal_segments: a segment is never addressed to a trial workspace (self-reference)'
          using errcode = 'check_violation';
      end if;
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- The one delete: `on delete cascade` from purging the target workspace, whose row is gone by
    -- the time the cascade reaches here. (Purging the trial workspace deletes its segments under
    -- `session_replication_role = replica`, where this trigger does not fire.)
    if old.target_workspace_id is not null
       and not exists (select 1 from workspaces w where w.id = old.target_workspace_id) then
      return old;
    end if;
    raise exception 'admin_proposal_segments: a proposed segment is never removed';
  end if;

  changed := change_changed_columns(to_jsonb(new), to_jsonb(old), array[
    'status', 'decided_by', 'decided_by_user', 'decided_at', 'withdrawn_by_user',
    'withdrawn_origin', 'reason', 'applied_segment_id', 'applied_platform_segment_id',
    'rolled_back_by', 'rolled_back_by_user', 'rolled_back_at', 'updated_at']);
  if changed is not null then
    raise exception 'admin_proposal_segments: what a segment proposes, and to whom, never changes (%)',
      changed;
  end if;

  if old.status in ('rejected', 'withdrawn', 'rolled_back') then
    raise exception 'admin_proposal_segments: a % segment is final', old.status;
  end if;
  if new.status is not distinct from old.status then
    changed := change_changed_columns(to_jsonb(new), to_jsonb(old), array['updated_at']);
    if changed is not null then
      raise exception 'admin_proposal_segments: % changes only with a transition', changed;
    end if;
    return new;
  end if;
  if not admin_proposal_segment_transition_allowed(old.status, new.status) then
    raise exception 'admin_proposal_segments: illegal transition % -> %', old.status, new.status;
  end if;

  -- Who decides which edge: the platform plane decides a platform segment; the target workspace a
  -- workspace segment; the trial workspace (the administrator's agent) or the platform plane
  -- withdraws either.
  if new.status in ('applied', 'rejected', 'rolled_back') then
    if old.authority = 'platform' then
      if not app_platform() then
        raise exception 'admin_proposal_segments: a platform segment is % on the platform plane', new.status;
      end if;
    elsif app_platform() or app_workspace() is distinct from old.target_workspace_id then
      raise exception 'admin_proposal_segments: a workspace segment is % in its target workspace', new.status;
    end if;
  elsif new.status = 'withdrawn' then
    if not (app_platform() or app_workspace() is not distinct from old.workspace_id) then
      raise exception 'admin_proposal_segments: a segment is withdrawn by its proposer or on the platform plane';
    end if;
  end if;

  -- What a workspace decision names is the target workspace's own (0032's foreign-key note); a
  -- platform segment's deciders are checked by the record guard (0033's, replaced below).
  if new.decided_by is distinct from old.decided_by and not exists (
    select 1 from principals p
     where p.workspace_id = old.target_workspace_id and p.id = new.decided_by and p.kind = 'human'
  ) then
    raise exception 'admin_proposal_segments: decided_by is a person of the target workspace';
  end if;
  if new.rolled_back_by is distinct from old.rolled_back_by and not exists (
    select 1 from principals p
     where p.workspace_id = old.target_workspace_id and p.id = new.rolled_back_by and p.kind = 'human'
  ) then
    raise exception 'admin_proposal_segments: rolled_back_by is a person of the target workspace';
  end if;
  if new.applied_segment_id is distinct from old.applied_segment_id and not exists (
    select 1 from change_segments c
     where c.workspace_id = old.target_workspace_id and c.id = new.applied_segment_id
  ) then
    raise exception 'admin_proposal_segments: applied_segment_id is a change segment of the target workspace';
  end if;
  -- Who withdrew it is the transaction's own platform user: the platform plane's acting
  -- administrator (`app.user_id`), or the user of the trial workspace's Principal; and the channel
  -- is where the transaction runs — on the platform plane, `platform_segment` when the caller says
  -- so and the proposal's platform segment is rejected or rolled back (see the header).
  if new.status = 'withdrawn' then
    if app_platform() then
      if new.withdrawn_by_user is distinct from nullif(current_setting('app.user_id', true), '')::uuid then
        raise exception 'admin_proposal_segments: withdrawn on the platform plane by its acting administrator';
      end if;
      if new.withdrawn_origin is not distinct from 'platform_segment' then
        select s.status into platform_status
          from admin_proposal_segments s
         where s.proposal_id = old.proposal_id and s.authority = 'platform';
        if old.authority <> 'workspace' or platform_status is null
           or platform_status not in ('rejected', 'rolled_back') then
          raise exception 'admin_proposal_segments: a workspace segment is withdrawn with its platform segment once that is rejected or rolled back';
        end if;
      else
        new.withdrawn_origin := 'human';
      end if;
    else
      if not exists (
        select 1 from principals p
         where p.workspace_id = old.workspace_id and p.id = app_principal()
           and p.user_id = new.withdrawn_by_user
      ) then
        raise exception 'admin_proposal_segments: withdrawn in the trial workspace by its own user';
      end if;
      new.withdrawn_origin := 'agent';
    end if;
  end if;

  -- Each decision at the deciding transaction's time; an apply's decision stays its own.
  if new.status in ('applied', 'rejected', 'withdrawn') then
    new.decided_at := now();
  elsif new.decided_at is distinct from old.decided_at
        or new.decided_by is distinct from old.decided_by
        or new.decided_by_user is distinct from old.decided_by_user then
    raise exception 'admin_proposal_segments: rolling back keeps who applied it and when';
  end if;
  if new.status = 'rolled_back' then
    new.rolled_back_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_proposal_segments_record_guard (0033's, with the platform authority)
-- ---------------------------------------------------------------------------------------------

create or replace function admin_proposal_segments_record_guard() returns trigger
language plpgsql as $$
declare
  acting_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if new.status is not distinct from old.status then
    new.updated_at := old.updated_at;
    return new;
  end if;

  if old.authority = 'platform' then
    if new.status in ('applied', 'rejected') and new.decided_by_user is distinct from acting_user then
      raise exception 'admin_proposal_segments: a platform segment is % by the acting administrator of this transaction',
        new.status;
    end if;
    if new.status = 'rolled_back' and new.rolled_back_by_user is distinct from acting_user then
      raise exception 'admin_proposal_segments: a platform segment is rolled back by the acting administrator of this transaction';
    end if;
    if new.applied_platform_segment_id is distinct from old.applied_platform_segment_id and not exists (
      select 1 from platform_change_segments c
       where c.id = new.applied_platform_segment_id and c.admin_proposal_segment_id = old.id
    ) then
      raise exception 'admin_proposal_segments: applied_platform_segment_id is the platform change segment that records this segment';
    end if;
    if new.status = 'rolled_back' and not exists (
      select 1 from platform_change_segments c
       where c.id = old.applied_platform_segment_id and c.status = 'rolled_back'
    ) then
      raise exception 'admin_proposal_segments: a platform segment is rolled back with the platform change segment that records it';
    end if;
    return new;
  end if;

  if new.status in ('applied', 'rejected') and new.decided_by is distinct from app_principal() then
    raise exception 'admin_proposal_segments: a segment is % by the person of this transaction', new.status;
  end if;
  if new.status = 'rolled_back' and new.rolled_back_by is distinct from app_principal() then
    raise exception 'admin_proposal_segments: a segment is rolled back by the person of this transaction';
  end if;
  if new.applied_segment_id is distinct from old.applied_segment_id and not exists (
    select 1 from change_segments c
     where c.workspace_id = old.target_workspace_id and c.id = new.applied_segment_id
       and c.admin_proposal_segment_id = old.id
  ) then
    raise exception 'admin_proposal_segments: applied_segment_id is the change segment that records this segment';
  end if;
  if new.status = 'rolled_back' and old.status is distinct from 'rolled_back' and not exists (
    select 1 from change_segments c
     where c.workspace_id = old.target_workspace_id and c.id = old.applied_segment_id
       and c.status = 'rolled_back'
  ) then
    raise exception 'admin_proposal_segments: a segment is rolled back with the change segment that records it';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- A target workspace reads its proposal's platform segment (see the header)
-- ---------------------------------------------------------------------------------------------

create or replace function admin_proposal_platform_segment(p_proposal_id uuid)
returns table (id uuid, status text, items jsonb, content_digest text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.id, s.status, s.items, s.content_digest
    from admin_proposal_segments s
   where s.proposal_id = p_proposal_id
     and s.authority = 'platform'
     and exists (
       select 1 from admin_proposal_segments t
        where t.proposal_id = p_proposal_id
          and t.authority = 'workspace'
          and t.target_workspace_id = app_workspace()
     )
$$;
revoke all on function admin_proposal_platform_segment(uuid) from public;
grant execute on function admin_proposal_platform_segment(uuid) to nexttime_app;
