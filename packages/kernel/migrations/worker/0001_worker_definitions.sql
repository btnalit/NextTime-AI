-- module: worker, version: 0001
--
-- worker_definitions (design doc §5.1.4, §5.4 I12, §5.5, §9.2 increment sketch;
-- docs/development-tasks.md S2.1, S2.6). WorkerDefinition — the "executable file" pinned by a
-- Task at invocation time (`invoke_worker(definitionId, version, ...)`,
-- packages/shared/src/capabilities.ts task group). Shape and identity convention are taken
-- directly from §9.2's own sketch, which this migration implements verbatim rather than
-- reinterpreting:
--
--   create table worker_definitions (
--     workspace_id uuid not null, id uuid not null, version int not null,
--     kind text not null check (kind in ('entry','worker')),
--     status text not null check (status in ('draft','published','deprecated')),
--     definition jsonb not null,
--     proposed_by uuid not null, published_by uuid,
--     primary key (workspace_id, id, version)
--   );
--
-- Identity/versioning convention (docs/development-tasks.md S2.1 dispatch: "unique key on
-- (workspace_id, name, version) or the equivalent the design implies"): the equivalent the design
-- implies is exactly this — `id` is a stable surrogate identifier reused across versions (like
-- `ontology_versions.id`, core/0002_substrate.sql: "a stable ontology identifier"), addressed as
-- `id@version` (`invoke_worker`, `publish_worker_definition`, `deprecate_worker_definition` all
-- take `{definitionId, version}`, never a separate human-readable name column). No `name` column
-- is added: neither §9.2's sketch nor any capability paramsSchema in packages/shared/src/
-- capabilities.ts references one, and `definition jsonb` is already the place a human-facing name
-- would live if the WorkerDefinition content itself carries one (S2.6, out of scope here).
--
-- I12 (§5.4 "已发布 OntologyVersion / WorkerDefinition 不可改"; §5.5 "draft → published →
-- deprecated"): unlike `ontology_versions`' immutability trigger (core/0002_substrate.sql), which
-- only blocks `definition` from changing post-publish because `status` itself must remain
-- updatable for the *unconstrained* published → deprecated move, this table's trigger also
-- constrains what a published row's `status` may become — "the single transition published →
-- deprecated (and whatever the doc allows)" (docs/development-tasks.md S2.1 dispatch) — since
-- §5.5 names exactly one further transition for a published WorkerDefinition and packages/shared/
-- src/transitions.ts's shared `PUBLISHABLE_TRANSITIONS` table (reused by WorkerDefinition,
-- OntologyVersion, Skill, Procedure alike) agrees: `{from: 'published', event: 'deprecate',
-- to: 'deprecated'}` is the only edge out of `published`. A `deprecated` row is that table's
-- terminal state (no outgoing edge at all) and is exactly as content-immutable as `published` —
-- `tasks` permanently pins a `(worker_definition_id, version)` pair regardless of which of the
-- two post-draft statuses that version currently sits in, so both must stay resolvable to the
-- content a Task actually ran. The trigger below therefore: (1) blocks `definition`/`kind`
-- changes whenever `old.status` is `published` *or* `deprecated`; (2) allows `published`'s single
-- `→ deprecated` move and blocks every other status change from `published`; (3) blocks every
-- status change at all once `old.status = 'deprecated'` (including back to `draft`/`published`).
--
-- Runner ordering (docs/development-tasks.md S2.1 note, mirroring governance/0001's and
-- llm-usage/0001's own notes): packages/kernel/src/adapters/db/migrate.ts's `discoverMigrations`
-- sorts module directories lexicographically (core < governance < llm-usage < task < worker), so
-- `principals` (core module) already exists by the time this file's foreign keys below are
-- created. `worker` is the *last* module to run — nothing later in this migration tree can be
-- assumed to exist, and nothing here needs to reference anything outside `principals`.
--
-- Cross-process bootstrap lock: the same empirically-required fix documented at length in
-- core/0001_identity.sql's header comment applies here too — `pg_advisory_xact_lock`
-- (transaction-scoped, released automatically at this file's own COMMIT/ROLLBACK) as the very
-- first statement. The key below (7241000501) is a new, arbitrary bigint distinct from every
-- other module's key so far (core: 7241000101, governance: 7241000201, llm-usage: 7241000301,
-- task: 7241000401) — advisory lock keys only need to be unique within one Postgres cluster.
select pg_advisory_xact_lock(7241000501);

create table if not exists worker_definitions (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  version int not null,
  kind text not null check (kind in ('entry', 'worker')),
  status text not null default 'draft' check (status in ('draft', 'published', 'deprecated')),
  definition jsonb not null,
  proposed_by uuid not null,
  published_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (workspace_id, id, version),
  foreign key (workspace_id, proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, published_by) references principals (workspace_id, id)
);

alter table worker_definitions enable row level security;

drop policy if exists worker_definitions_workspace_isolation on worker_definitions;

-- Workspace-only (mirrors ontology_versions exactly, core/0002_substrate.sql — same table shape,
-- same lifecycle, same reasoning): I16's draft-privacy rule ("Handle 通道写入非 draft 状态或修改
-- 他人草稿一律拒绝") is a gateway-layer channel/state check (S2.6), not a row-visibility rule — the
-- established precedent for this exact pattern already left it out of RLS for ontology_versions,
-- and this migration follows that precedent rather than inventing a different one for its sibling
-- table.
create policy worker_definitions_workspace_isolation on worker_definitions
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant (mirrors ontology_versions exactly): a WorkerDefinition version is superseded by
-- publishing a new version or deprecating this one, never removed — Task rows permanently pin a
-- `(worker_definition_id, version)` pair (§5.5 "Task 固定引用启动时版本") that must remain
-- resolvable for as long as the Task's own audit trail does.
grant select, insert, update on worker_definitions to nexttime_app;

-- Coordinator review amendment (PR #33, 2026-09): a `deprecated` row must be exactly as
-- immutable as a `published` one, not fully editable again — `tasks.worker_definition_id` /
-- `.worker_definition_version` (migrations/task/0001_tasks.sql) permanently pin a
-- `(id, version)` pair for as long as that Task's own audit trail must remain resolvable (§5.5
-- "Task 固定引用启动时版本"), regardless of whether the pinned version is currently `published`
-- or has since been `deprecated`. The content check below therefore covers both statuses; the
-- status-transition check is split per starting status because the two allowed shapes differ:
-- `published` has exactly one legal exit (→ `deprecated`, `PUBLISHABLE_TRANSITIONS`'s only edge
-- out of `published`); `deprecated` has none (it is the terminal state of that same table — no
-- edge exists out of `deprecated` at all).
create or replace function worker_definitions_block_published_mutation() returns trigger
language plpgsql as $$
begin
  if old.status in ('published', 'deprecated') then
    if new.definition is distinct from old.definition or new.kind is distinct from old.kind then
      raise exception 'worker_definitions: content is immutable once published (I12)';
    end if;
  end if;

  if old.status = 'published' then
    if new.status is distinct from old.status and new.status <> 'deprecated' then
      raise exception
        'worker_definitions: a published row may only transition to deprecated (I12)';
    end if;
  elsif old.status = 'deprecated' then
    if new.status is distinct from old.status then
      raise exception 'worker_definitions: a deprecated row is terminal (I12)';
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger worker_definitions_immutable_published
  before update on worker_definitions
  for each row execute function worker_definitions_block_published_mutation();
