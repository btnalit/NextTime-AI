-- module: worker, version: 0006
--
-- 0006_draft_rejections (legacy 491; E2-0b's `reject_draft`, #772). Rejecting a pending Skill /
-- Procedure draft deletes its row (worker/0003: no fourth `PublishableStatus`, decision of #772),
-- and until now only the call's AuditRecord kept why — which the draft's proposer cannot read
-- (`audit_query` is the auditor's). The rejection is a domain event its proposer is owed, so it
-- gets a record of its own:
--
--   * `draft_rejections` — one row per rejection, written by `rejectDraft`
--     (`application/worker/draft-lifecycle.ts`) in the transaction that deletes the draft. What
--     was rejected (kind, family id, version, the draft's name), whose it was (`proposed_by` —
--     for a draft an agent proposed, the person its Handle acted for, as on the draft itself),
--     who rejected it and why (`reason`, the same secret-redacted copy the AuditRecord keeps), and
--     the digest of the content rejected. Read by `list_draft_rejections`, which returns the
--     caller's own only. Append-only: a rejection that happened is never edited or withdrawn.
--   * no foreign key to `skills` / `procedures`: the rejected row is gone. The two principal
--     keys stand — principals are disabled, never deleted.
--
-- Backfill: the rejections made before this migration, from their AuditRecords (`reject_draft`
-- with the handler's `rejectedDraft` payload). Those never recorded the draft's name, so `name`
-- is NULL there. Re-running inserts nothing twice.
--
-- Reversible: a new table nothing earlier reads or writes; the previous release runs on this
-- schema unchanged (its rejections then simply leave no row here).
--
-- Advisory lock: same module key as 0001–0005.
select pg_advisory_xact_lock(7241000501);

create table if not exists draft_rejections (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  kind text not null,
  family_id uuid not null,
  version int not null,
  name text,
  proposed_by uuid not null,
  rejected_by uuid not null,
  reason text not null,
  draft_digest text not null,
  rejected_at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint draft_rejections_kind check (kind in ('skill', 'procedure')),
  constraint draft_rejections_version check (version > 0),
  constraint draft_rejections_reason check (char_length(reason) > 0),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, rejected_by) references principals (workspace_id, id)
);

-- `list_draft_rejections`: a proposer's own, newest first.
create index if not exists draft_rejections_proposer_idx
  on draft_rejections (workspace_id, proposed_by, rejected_at desc);

alter table draft_rejections enable row level security;

drop policy if exists draft_rejections_workspace_isolation on draft_rejections;

-- Workspace-only, like `turn_procedure_claims` (0004): the read narrows to the caller's own.
create policy draft_rejections_workspace_isolation on draft_rejections
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Append-only.
grant select, insert on draft_rejections to nexttime_app;

insert into draft_rejections
  (workspace_id, kind, family_id, version, name, proposed_by, rejected_by, reason, draft_digest,
   rejected_at)
select a.workspace_id, a.resource_type, a.resource_id,
       (a.payload -> 'params' ->> 'version')::int, null,
       (a.payload -> 'rejectedDraft' ->> 'proposedBy')::uuid, a.actor_principal_id,
       a.payload -> 'params' ->> 'reason', a.payload -> 'params' ->> 'draftDigest', a.created_at
  from audit_records a
 where a.action = 'reject_draft'
   and a.workspace_id is not null
   and a.resource_type in ('skill', 'procedure')
   and a.resource_id is not null
   and a.actor_principal_id is not null
   and a.payload -> 'rejectedDraft' ->> 'proposedBy' is not null
   and coalesce(a.payload -> 'params' ->> 'reason', '') <> ''
   and a.payload -> 'params' ->> 'draftDigest' is not null
   and a.payload -> 'params' ->> 'version' ~ '^[1-9][0-9]*$'
   and not exists (
     select 1 from draft_rejections r
      where r.workspace_id = a.workspace_id and r.family_id = a.resource_id
        and r.version = (a.payload -> 'params' ->> 'version')::int
        and r.rejected_at = a.created_at
   );
