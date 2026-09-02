-- module: core, version: 0002
--
-- Graph substrate: OntologyVersion, Object, Activity, Source, Observation, Link (=Fact),
-- Evidence, Conflict, Decision (design doc §5.1.2, §5.1.3, §9.2; docs/development-tasks.md
-- S1.1). `activities.chat_id` is created here without a foreign key — `chats` does not exist
-- yet, that constraint is added by 0003_chat.sql once it does.
--
-- All tables here use the `(workspace_id, id)` composite primary key from §9.2 and the matching
-- composite foreign keys wherever one row references another. The composite FK, not just a
-- plain FK on the id column, is what makes I1's "cross-workspace reference" case impossible at
-- the data layer: a row in workspace A can never foreign-key to a row that physically lives in
-- workspace B, because no `(A, <that id>)` tuple exists in the referenced table.

-- ontology_versions (§5.1.2, I12, §5.5): versioned per `id` (a stable ontology identifier), each
-- version `draft -> published -> deprecated` (packages/shared PublishableStatus). Once
-- `published`, `definition` is immutable (I12) — enforced by the trigger below, not by revoking
-- UPDATE, because `status` itself must still be updatable (published -> deprecated).
create table ontology_versions (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  version int not null,
  status text not null check (status in ('draft', 'published', 'deprecated')),
  definition jsonb not null,
  proposed_by uuid not null,
  published_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (workspace_id, id, version),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, published_by) references principals (workspace_id, id)
);

alter table ontology_versions enable row level security;

create policy ontology_versions_workspace_isolation on ontology_versions
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on ontology_versions to nexttime_app;

create function ontology_versions_block_published_definition_update() returns trigger
language plpgsql as $$
begin
  if old.status = 'published' and new.definition is distinct from old.definition then
    raise exception 'ontology_versions: definition is immutable once published (I12)';
  end if;
  return new;
end;
$$;

create trigger ontology_versions_immutable_definition
  before update on ontology_versions
  for each row execute function ontology_versions_block_published_definition_update();

-- objects (§5.1.2): first-class graph nodes. `object_type` names an ObjectType from the current
-- ontology; validating it against a published OntologyVersion (I2) is graph-store write-path
-- logic (S1.2), not a DB constraint.
create table objects (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  object_type text not null,
  identity_key jsonb,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
);

alter table objects enable row level security;

create policy objects_workspace_isolation on objects
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update, delete on objects to nexttime_app;

-- activities (§5.1.3): PROV-O Activity — ingestion runs, extractions, and Turns
-- (`kind = 'agent_turn'`, `chat_id` set, `status in ('running','completed','interrupted',
-- 'failed')` by convention, §9.2 DDL sketch comment). `kind` and `status` are intentionally left
-- unconstrained by a CHECK (assumption — see PR body "假设"): no shared enum in packages/shared
-- covers the full cross-kind status vocabulary (a non-Turn Activity, e.g. an ingestion run,
-- reasonably has a different status set), so a CHECK here would either fabricate values not in
-- packages/shared or wrongly narrow a generic Activity to Turn's own lifecycle. The RLS policy
-- below is workspace-only for now; 0003_chat.sql replaces it once `chats` (and therefore
-- chat-derived visibility, §5.6) exists.
create table activities (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  kind text not null,
  chat_id uuid,
  sequence int,
  status text not null,
  metadata jsonb not null default '{}'::jsonb,
  started_by uuid,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, started_by) references principals (workspace_id, id),
  unique (workspace_id, chat_id, sequence)
);

alter table activities enable row level security;

create policy activities_workspace_isolation on activities
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update, delete on activities to nexttime_app;

-- sources (§5.1.3, §5.6): documents / databases / APIs / people / agent sessions.
-- `owner_principal_id` + `visibility` (`private` default, or `workspace`) is the first
-- visibility-scoped table — `chats` (0003) is the other, and `observations` / `decisions` below
-- derive their own visibility by joining back to whichever source produced them (S1.1 dispatch).
-- `('private','workspace')` mirrors the literal set already used inline in
-- packages/shared/src/capabilities.ts (`visibility: z.enum(['workspace','private'])`); there is
-- no standalone `VISIBILITY_VALUES` export in packages/shared/src/enums.ts to reference instead
-- (assumption — see PR body "假设").
create table sources (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  kind text not null,
  owner_principal_id uuid not null,
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  uri text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, owner_principal_id) references principals (workspace_id, id)
);

alter table sources enable row level security;

create policy sources_visibility on sources
  for all
  using (
    workspace_id = app_workspace()
    and (visibility = 'workspace' or owner_principal_id = app_principal())
  )
  with check (
    workspace_id = app_workspace()
    and (visibility = 'workspace' or owner_principal_id = app_principal())
  );

grant select, insert, update, delete on sources to nexttime_app;

-- observations (§5.1.3): a single observed input, generated by an Activity from a Source, that
-- Facts (`links` below) are built from. Visibility is derived entirely from the Source (S1.1
-- dispatch) — an Observation has no owner/visibility of its own.
create table observations (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  source_id uuid not null,
  activity_id uuid not null,
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, source_id) references sources (workspace_id, id),
  foreign key (workspace_id, activity_id) references activities (workspace_id, id)
);

alter table observations enable row level security;

create policy observations_visibility on observations
  for all
  using (
    workspace_id = app_workspace()
    and exists (
      select 1 from sources s
      where s.workspace_id = observations.workspace_id
        and s.id = observations.source_id
        and (s.visibility = 'workspace' or s.owner_principal_id = app_principal())
    )
  )
  with check (
    workspace_id = app_workspace()
    and exists (
      select 1 from sources s
      where s.workspace_id = observations.workspace_id
        and s.id = observations.source_id
        and (s.visibility = 'workspace' or s.owner_principal_id = app_principal())
    )
  );

grant select, insert, update, delete on observations to nexttime_app;

-- links (=Fact, §5.1.2, §5.3 item 6, §5.4 I3/I4, §5.5, §5.6): the bi-temporal, append-only edge.
-- `valid_from`/`valid_until` are the Fact's own asserted validity interval; `recorded_at` /
-- `superseded_at` / `invalidated_at` / `supersedes_id` are the system-time bookkeeping columns
-- for the `recorded -> superseded | invalidated` lifecycle (packages/shared FactLifecycle);
-- `epistemic_status` / `confidence` are the independent belief-strength axis (§5.6,
-- packages/shared EpistemicStatus). `activity_id` is I3 — every Fact must be traceable to the
-- Activity that produced it. The CHECK below is §5.3 item 6 in its DB-enforceable half
-- ("verified ⇒ verified_by"); the harder half ("... 与 Evidence") needs a cross-table constraint
-- and is left to the application write path (S1.2) — see PR body "假设".
--
-- RLS here is workspace-only, not visibility-derived from a Source (unlike observations/
-- decisions below), per the explicit S1.1 dispatch RLS list, even though design doc §5.1.3's
-- prose ("Fact 与 Decision 继承其 Source 的可见性") reads more broadly — see PR body "假设": a Fact
-- has no direct `source_id` column (it points at an Activity, not a Source), so there is no
-- single-hop join to derive visibility from without first threading it through Activity ->
-- Observation -> Source, which is graph-store logic (S1.2), not a migration-time decision.
create table links (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  link_type text not null,
  source_object_id uuid not null,
  target_object_id uuid not null,
  properties jsonb not null default '{}'::jsonb,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  recorded_at timestamptz not null default now(),
  superseded_at timestamptz,
  invalidated_at timestamptz,
  supersedes_id uuid,
  epistemic_status text not null
    check (epistemic_status in ('observed', 'extracted', 'inferred', 'asserted', 'verified', 'contradicted')),
  confidence double precision,
  activity_id uuid not null,
  asserted_by uuid not null,
  verified_by uuid,
  primary key (workspace_id, id),
  foreign key (workspace_id, source_object_id) references objects (workspace_id, id),
  foreign key (workspace_id, target_object_id) references objects (workspace_id, id),
  foreign key (workspace_id, activity_id) references activities (workspace_id, id),
  foreign key (workspace_id, asserted_by) references principals (workspace_id, id),
  foreign key (workspace_id, verified_by) references principals (workspace_id, id),
  foreign key (workspace_id, supersedes_id) references links (workspace_id, id),
  check (epistemic_status <> 'verified' or verified_by is not null)
);

alter table links enable row level security;

create policy links_workspace_isolation on links
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant: append-only per I4, enforced again (belt and suspenders) by the delete
-- trigger below regardless of role/ownership.
grant select, insert, update on links to nexttime_app;

-- I4 mechanism: block UPDATE of every "content" column once a Fact is recorded. Lifecycle
-- bookkeeping (superseded_at/invalidated_at/supersedes_id) and the epistemic-promotion columns
-- (epistemic_status/confidence/verified_by — packages/shared EpistemicPromotion: `verify` /
-- `contradict` are legitimate follow-on writes to an already-recorded Fact, not a content edit)
-- are deliberately excluded from this list — see PR body "假设".
create function links_block_content_update() returns trigger
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
  return new;
end;
$$;

create trigger links_immutable_content
  before update on links
  for each row execute function links_block_content_update();

-- Append-only (§5.4 I4 "Fact 只追加不覆盖"): no deletion at all, regardless of role or
-- ownership — mirrors the audit_records append-only trigger in 0004_audit.sql.
create function links_block_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'links: rows are append-only and cannot be deleted (I4) — use supersede/invalidate instead';
end;
$$;

create trigger links_immutable_delete
  before delete on links
  for each row execute function links_block_delete();

-- evidence (§5.1.3, §5.3 item 6): supporting material for a Fact's `verified` promotion.
create table evidence (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  link_id uuid not null,
  kind text not null,
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  primary key (workspace_id, id),
  foreign key (workspace_id, link_id) references links (workspace_id, id),
  foreign key (workspace_id, created_by) references principals (workspace_id, id)
);

alter table evidence enable row level security;

create policy evidence_workspace_isolation on evidence
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update, delete on evidence to nexttime_app;

-- conflicts (§5.1.3, §5.5, I5): `open -> resolved | accepted_both | dismissed`
-- (packages/shared ConflictStatus); `conflict_type` uses packages/shared ConflictType
-- (value/type/relationship/temporal/logical). Full private-participant visibility (§5.6: "私有
-- Source 参与的 Conflict 只对私有一方可见") is conflict-detection logic that does not exist yet
-- (S3.2 "冲突检测"); RLS here is workspace-only for S1.1 — see PR body "假设".
create table conflicts (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  conflict_type text not null check (conflict_type in ('value', 'type', 'relationship', 'temporal', 'logical')),
  status text not null default 'open' check (status in ('open', 'resolved', 'accepted_both', 'dismissed')),
  link_a_id uuid not null,
  link_b_id uuid not null,
  description text,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution jsonb,
  primary key (workspace_id, id),
  foreign key (workspace_id, link_a_id) references links (workspace_id, id),
  foreign key (workspace_id, link_b_id) references links (workspace_id, id)
);

alter table conflicts enable row level security;

create policy conflicts_workspace_isolation on conflicts
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update, delete on conflicts to nexttime_app;

-- decisions (§5.1.3, §5.5): `proposed -> approved | rejected -> executed -> verified | failed ->
-- superseded | archived` (packages/shared DecisionStatus). `source_id` is nullable — not every
-- Decision traces back to a single Source — and visibility is derived from it exactly like
-- observations above; a Decision with no Source is workspace-visible (nothing private to hide
-- behind).
create table decisions (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'executed', 'verified', 'failed', 'superseded', 'archived')),
  activity_id uuid not null,
  source_id uuid,
  summary text,
  rationale jsonb,
  decided_by uuid,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, activity_id) references activities (workspace_id, id),
  foreign key (workspace_id, source_id) references sources (workspace_id, id),
  foreign key (workspace_id, decided_by) references principals (workspace_id, id)
);

alter table decisions enable row level security;

create policy decisions_visibility on decisions
  for all
  using (
    workspace_id = app_workspace()
    and (
      source_id is null
      or exists (
        select 1 from sources s
        where s.workspace_id = decisions.workspace_id
          and s.id = decisions.source_id
          and (s.visibility = 'workspace' or s.owner_principal_id = app_principal())
      )
    )
  )
  with check (
    workspace_id = app_workspace()
    and (
      source_id is null
      or exists (
        select 1 from sources s
        where s.workspace_id = decisions.workspace_id
          and s.id = decisions.source_id
          and (s.visibility = 'workspace' or s.owner_principal_id = app_principal())
      )
    )
  );

grant select, insert, update, delete on decisions to nexttime_app;
