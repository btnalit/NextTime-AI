-- module: worker, version: 0002
--
-- skills / procedures (design doc §5.1.4 Skill/Procedure, §5.4 I12/I16, §5.5 draft -> published ->
-- deprecated; §9.2 "skills / procedures 作为平台元本体存于 objects / links，状态与版本在 properties" —
-- superseded here for these two specifically, per this task's own dispatch ("rows in a new
-- migrations/worker/0002_skills_procedures.sql (skills(...), procedures(...))"): like
-- `worker_definitions` (0001, same module) Skill and Procedure get their own relational lifecycle
-- table with first-class, queryable `name`/`description`/`markdown`|`steps` columns, not a single
-- opaque `definition jsonb` blob the way `worker_definitions` uses — and, like `Operation`
-- (governance/gatekeepers/manifest.ts), still get a publish-time graph projection into `objects`/
-- `links` (`substrate/ontology/meta-objects.ts`) so `find_procedures`/`WorkerDefinition --uses-->
-- Skill` have something to traverse. docs/development-tasks.md S2.14.
--
-- Versioning/identity convention: identical to `worker_definitions` (0001's own header comment) —
-- `id` is a stable surrogate reused across versions, addressed as `id@version`
-- (`publish_skill`/`deprecate_skill`/`publish_procedure`/`deprecate_procedure` all take
-- `{skillId|procedureId}` alone, resolving to the latest — see `application/worker/skills.ts`'s/
-- `procedures.ts`'s own doc comments for why publish/deprecate address the row by `id` without a
-- separate `version` param, unlike `worker_definitions`' `{definitionId, version}` pair).
--
-- Same immutability trigger rule as worker_definitions (0001's own header comment has the full
-- reasoning: a `published` row's content is frozen — only `published -> deprecated` may still
-- change `status`; a `deprecated` row is fully terminal) — reused verbatim below for both tables.
--
-- I16 read-privacy ("Handle 通道只能写对提议者私有的草稿" — and, per this task's own dispatch, reads of
-- a draft by another principal must behave as not-found): deliberately **not** enforced via RLS the
-- way `sources`' `visibility`/`owner_principal_id` policy is (core/0002_substrate.sql) — a Skill's
-- `proposed_by` is typically the *agent/Worker* principal that called `propose_skill` on the human
-- user's behalf (design doc §5.1.4 "Worker 结束时可 propose_skill"), not the human who will later
-- publish it; an RLS policy keyed on `proposed_by = app_principal()` would hide every draft from
-- the very human meant to review and publish it, breaking the human-can-publish-any-draft model
-- `worker_definitions` already established (I16's actual gate is the `channel:'human'` capability
-- registration, not row ownership — see `application/worker/definitions.ts`'s own doc comment).
-- RLS below therefore mirrors `worker_definitions` exactly: plain workspace isolation, nothing
-- more. Draft read-privacy for `list_skills`/`list_procedures` is enforced in the *service*
-- (`application/worker/skills.ts`'s `listSkills` — "published, or my own draft" — mirroring
-- `sources_visibility`'s predicate shape without RLS's row-hiding side effect on writes).
--
-- Runner ordering / advisory lock: this file runs immediately after 0001_worker_definitions.sql
-- within the same `worker` module (lexicographic order within one module directory) —
-- `principals` already exists. Reuses the SAME advisory-lock key as 0001 (7241000501): locks are
-- per-module, not per-file (task/0002_quotas.sql's own header comment documents the identical
-- precedent).
select pg_advisory_xact_lock(7241000501);

create table if not exists skills (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  version int not null default 1,
  status text not null default 'draft' check (status in ('draft', 'published', 'deprecated')),
  name text not null,
  description text not null,
  markdown text not null,
  applicable jsonb not null default '{}'::jsonb,
  proposed_by uuid not null,
  published_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (workspace_id, id, version),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, published_by) references principals (workspace_id, id)
);

alter table skills enable row level security;

drop policy if exists skills_workspace_isolation on skills;

-- Workspace-only — see this file's own header comment for why I16 read-privacy is not folded into
-- this policy.
create policy skills_workspace_isolation on skills
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant (mirrors worker_definitions exactly): a Skill version is superseded by
-- publishing a new version or deprecating this one, never removed — a WorkerDefinition's `uses`
-- list and any already-mounted container reference a Skill by identity that must stay resolvable.
grant select, insert, update on skills to nexttime_app;

create or replace function skills_block_published_mutation() returns trigger
language plpgsql as $$
begin
  if old.status in ('published', 'deprecated') then
    if new.name is distinct from old.name
       or new.description is distinct from old.description
       or new.markdown is distinct from old.markdown
       or new.applicable is distinct from old.applicable then
      raise exception 'skills: content is immutable once published (I12)';
    end if;
  end if;

  if old.status = 'published' then
    if new.status is distinct from old.status and new.status <> 'deprecated' then
      raise exception 'skills: a published row may only transition to deprecated (I12)';
    end if;
  elsif old.status = 'deprecated' then
    if new.status is distinct from old.status then
      raise exception 'skills: a deprecated row is terminal (I12)';
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger skills_immutable_published
  before update on skills
  for each row execute function skills_block_published_mutation();

create table if not exists procedures (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  version int not null default 1,
  status text not null default 'draft' check (status in ('draft', 'published', 'deprecated')),
  name text not null,
  description text not null,
  steps jsonb not null default '[]'::jsonb,
  proposed_by uuid not null,
  published_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (workspace_id, id, version),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, published_by) references principals (workspace_id, id)
);

alter table procedures enable row level security;

drop policy if exists procedures_workspace_isolation on procedures;

create policy procedures_workspace_isolation on procedures
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on procedures to nexttime_app;

create or replace function procedures_block_published_mutation() returns trigger
language plpgsql as $$
begin
  if old.status in ('published', 'deprecated') then
    if new.name is distinct from old.name
       or new.description is distinct from old.description
       or new.steps is distinct from old.steps then
      raise exception 'procedures: content is immutable once published (I12)';
    end if;
  end if;

  if old.status = 'published' then
    if new.status is distinct from old.status and new.status <> 'deprecated' then
      raise exception 'procedures: a published row may only transition to deprecated (I12)';
    end if;
  elsif old.status = 'deprecated' then
    if new.status is distinct from old.status then
      raise exception 'procedures: a deprecated row is terminal (I12)';
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger procedures_immutable_published
  before update on procedures
  for each row execute function procedures_block_published_mutation();
