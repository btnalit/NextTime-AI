-- module: governance, version: 0033
--
-- 0033_change_segments_from_admin_proposals (S11 AA3b-2: docs/goal-orchestration-and-admin-agent-
-- plan-2026-10-16.md §3.1–§3.3, §5.4, I-A4 / I-A7 / I-A8; the AA3 default plan F5 / F7). The second
-- source of a change segment (§5.4 "一个核心，两种来源"): besides a pack, a segment of an admin
-- proposal (0032) that the owner of the workspace it is addressed to applied there
-- (`application/change-plan/admin-proposal-segments.ts`).
--
-- What such a segment records, and why:
--   * `source_kind = 'admin_proposal'`; `source_name` the proposal's `source_name`,
--     `source_version` the proposal's id, `source_digest` the proposal segment's `content_digest`
--     — the same three a pack source has (its name, its version, the digest of the content the
--     items were built from).
--   * `proposed_by` is null: nobody of this workspace proposed it. Who did is kept here, not only on
--     the proposal, because the proposal lives in its trial workspace and goes when that is purged
--     (0032's header) while this record stays: `admin_proposal_id` / `admin_proposal_segment_id`
--     (the proposal and its segment) and `proposed_by_user` / `proposer_display_name` (the platform
--     user whose admin agent proposed it, by the name they had then). No foreign keys: they name
--     rows of another workspace (or none, once purged) — provenance, not a relation to follow.
--   * `applied_by` is the owner, as for a pack; I-A7's "drafted by an agent" is on each version the
--     segment published (`origin = 'agent'`, core 0051 / worker 0013), not here.
--   * for any other source, the four columns are null and `proposed_by` is not (as before).
--
-- Guards:
--   * `change_segments_admin_proposal_guard` (insert): an `admin_proposal` segment records a proposal
--     segment that exists, is addressed to this workspace and is still `proposed` — in the applying
--     transaction, which moves it to `applied` right after — and its source and proposer are that
--     segment's and its proposal's, so the record cannot claim another proposal, digest or
--     proposer. The update guard of 0025 already keeps every one of these columns as written
--     (`change_changed_columns` allows only status, verification and rollback columns to change).
--   * `admin_proposal_segments_record_guard` (update of a proposal segment): its
--     `applied_segment_id` is the change segment that records it (`admin_proposal_segment_id` = this
--     segment), and it is `rolled_back` only once that change segment is — rolling back the record
--     is what rolls back the proposal segment (the kernel does both in one transaction,
--     `rollBackWorkspaceSegment`). Who applied, rejected or rolled it back is the transaction's own
--     Principal (`app_principal()`; 0032 checks only that it is a person of the target), so no
--     write path can name another person as the decider (#916 review #488 P3-a). An update that
--     changes no status keeps `updated_at` as it was (#488 P3-b: 0032 lets such an update through
--     and would keep whatever it wrote there).
--   * `admin_proposals_proposer_guard` (insert of a proposal): `proposed_by` is the transaction's
--     own Principal, as 0032 already ties the withdrawer to the transaction (#488 P3-a).
--   * one record per proposal segment (`change_segments_admin_proposal_segment`).
--
-- Reversibility: columns, checks and guards only; a release before this one never writes `admin_proposal`
-- and still inserts packs as it did (all four null, `proposed_by` set), so rolling back the code
-- alone is safe — it reads an `admin_proposal` record's source as if it were a pack's, and its null
-- `proposed_by` as a missing proposer; its apply-free paths (propose, withdraw) already write the
-- transaction's own Principal and leave `updated_at` alone. To take the migration out (only with
-- no `admin_proposal` row left): drop the three triggers and their functions and the index, `alter table change_segments drop
-- constraint change_segments_proposer`, restore `change_segments_source_kind_check` to `source_kind
-- in ('pack')`, `alter column proposed_by set not null`, drop the four columns, then `delete from
-- schema_migrations where module = 'governance' and version = 33`.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table change_segments drop constraint if exists change_segments_source_kind_check;
alter table change_segments add constraint change_segments_source_kind_check
  check (source_kind in ('pack', 'admin_proposal'));

alter table change_segments alter column proposed_by drop not null;

alter table change_segments add column if not exists admin_proposal_id uuid;
alter table change_segments add column if not exists admin_proposal_segment_id uuid;
alter table change_segments add column if not exists proposed_by_user uuid;
alter table change_segments add column if not exists proposer_display_name text
  check (proposer_display_name is null or length(proposer_display_name) between 1 and 200);

alter table change_segments drop constraint if exists change_segments_proposer;
alter table change_segments add constraint change_segments_proposer check (
  case source_kind
    when 'admin_proposal' then
      proposed_by is null
      and admin_proposal_id is not null and admin_proposal_segment_id is not null
      and proposed_by_user is not null and proposer_display_name is not null
      and source_version = admin_proposal_id::text
    else
      proposed_by is not null
      and admin_proposal_id is null and admin_proposal_segment_id is null
      and proposed_by_user is null and proposer_display_name is null
  end
);

-- A proposal segment is applied once (its own status edge says so too; this is the record's side).
create unique index if not exists change_segments_admin_proposal_segment
  on change_segments (workspace_id, admin_proposal_segment_id)
  where admin_proposal_segment_id is not null;

create or replace function change_segments_admin_proposal_guard() returns trigger
language plpgsql as $$
declare
  proposed record;
begin
  if new.source_kind <> 'admin_proposal' then
    return new;
  end if;
  -- Read in the applying transaction, as the target workspace: 0032's policies let it read the
  -- segment addressed to it and that segment's proposal head, nothing else.
  select s.status, s.target_workspace_id, s.proposal_id, s.content_digest,
         p.source_name, p.proposed_by_user, p.proposer_display_name
    into proposed
    from admin_proposal_segments s
    join admin_proposals p on p.workspace_id = s.workspace_id and p.id = s.proposal_id
   where s.id = new.admin_proposal_segment_id;
  if not found or proposed.target_workspace_id is distinct from new.workspace_id then
    raise exception 'change_segments: an admin_proposal segment records a proposal segment addressed to this workspace (% is not)',
      new.admin_proposal_segment_id;
  end if;
  if proposed.status <> 'proposed' then
    raise exception 'change_segments: a proposal segment is applied while it is proposed, not %',
      proposed.status;
  end if;
  if proposed.proposal_id is distinct from new.admin_proposal_id
     or proposed.content_digest is distinct from new.source_digest
     or proposed.source_name is distinct from new.source_name
     or proposed.proposed_by_user is distinct from new.proposed_by_user
     or proposed.proposer_display_name is distinct from new.proposer_display_name then
    raise exception 'change_segments: an admin_proposal segment''s source and proposer are its proposal segment''s proposal, content digest and proposer';
  end if;
  return new;
end;
$$;

create or replace trigger change_segments_admin_proposal_guard
  before insert on change_segments
  for each row execute function change_segments_admin_proposal_guard();

create or replace function admin_proposal_segments_record_guard() returns trigger
language plpgsql as $$
begin
  if new.status is not distinct from old.status then
    new.updated_at := old.updated_at;
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

create or replace trigger admin_proposal_segments_record_guard
  before update on admin_proposal_segments
  for each row execute function admin_proposal_segments_record_guard();

create or replace function admin_proposals_proposer_guard() returns trigger
language plpgsql as $$
begin
  if new.proposed_by is distinct from app_principal() then
    raise exception 'admin_proposals: the proposer is the person of this transaction';
  end if;
  return new;
end;
$$;

create or replace trigger admin_proposals_proposer_guard
  before insert on admin_proposals
  for each row execute function admin_proposals_proposer_guard();
