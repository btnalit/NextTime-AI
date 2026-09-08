-- module: core, version: 0014
--
-- Agent-kind principals for WorkerDefinitions (design decision replacing PR #84's interim
-- `CallerPrincipal.viaAgent` downgrade flag — docs/development-tasks.md S2.9 implementation note,
-- docs/code-review-2026-09-04.md §7 "WorkerRun / WorkerDefinition 的 agent 类 principal"). Facts
-- written from a Worker's result contract (`application/task/result.ts`'s `postWorkerResult`) are
-- now `asserted_by` a real `kind='agent'` principal that identifies the WorkerDefinition that ran,
-- instead of `asserted_by` the human `on_behalf_of` principal weakened post hoc by a caller-side
-- flag. The human is kept as provenance on the Activity (`metadata.onBehalfOf`, no new column —
-- see `application/task/result.ts`), not dropped.
--
-- Granularity: **one agent principal per (workspace, WorkerDefinition)**, created lazily and
-- idempotently the first time that definition is spawned in a workspace
-- (`application/task/agent-principal.ts`'s `ensureWorkerAgentPrincipal`) — never per version and
-- never per run. The version already lives on the Task (`tasks.worker_definition_version`,
-- migrations/task/0001_tasks.sql) and the run is already the Activity/WorkerRun
-- (`worker_runs.attempt`, migrations/task/0003_task_worker_run_lineage.sql); a principal keyed to
-- either of those would explode `principals` for zero provenance benefit — "which agent asserted
-- this" only ever needs to resolve to "this WorkerDefinition", not "this specific run of it".
--
-- **This column identifies a WorkerDefinition, never authorizes anything.** An agent principal
-- created here is a provenance subject only — it is never `on_behalf_of` anything, never
-- authenticates (`api_key_hash` stays null), and is never checked against a Grant/role. A Worker's
-- actual authority is the attenuated Handle its WorkerRun already holds (minted from the human
-- caller's own scope, `application/task/handle-mint.ts`) — `role: 'member'` below is therefore
-- inert, kept only because `principals.role` is `not null`, exactly as
-- `governance/gatekeepers/service-principal.ts`'s own shared service principal already does for
-- the same reason.
--
-- **No FK to `worker_definitions`.** Two independent reasons, both worth recording so a future
-- reader doesn't "fix" this into a broken migration: (1) module directory ordering
-- (`packages/kernel/src/adapters/db/migrate.ts`'s `discoverMigrations` sorts lexicographically —
-- core < governance < linkage < llm-usage < task < worker) runs every `core` file, this one
-- included, before `worker_definitions` exists at all — the exact same constraint
-- `migrations/task/0001_tasks.sql` already documents at length for `tasks.worker_definition_id`.
-- (2) Even if ordering allowed it, `worker_definitions`' own primary key is `(workspace_id, id,
-- version)` (migrations/worker/0001_worker_definitions.sql) — `id` alone is not unique per
-- workspace (it repeats across versions by design), so a plain FK to `(workspace_id,
-- worker_definition_id)` could never be expressed even from a later module. The referential check
-- ("does this WorkerDefinition id exist") is therefore an application-level concern, same
-- convention `tasks.worker_definition_id` already established.
--
-- Cross-process bootstrap lock: same `core`-module key as every other file in this module (locks
-- are per-module, not per-file).
select pg_advisory_xact_lock(7241000101);

alter table principals add column if not exists worker_definition_id uuid;

-- One agent principal per (workspace, WorkerDefinition) — the identity `ensureWorkerAgentPrincipal`
-- upserts against via `on conflict (workspace_id, worker_definition_id) where worker_definition_id
-- is not null` (the `on conflict` inference target must repeat this index's exact predicate).
-- Partial (not a plain unique constraint) because every principal that is *not* a WorkerDefinition
-- agent — every human/service principal, and any future agent principal not tied to a
-- WorkerDefinition — must remain free to have `worker_definition_id null` without colliding with
-- one another.
create unique index if not exists principals_worker_definition_id_key
  on principals (workspace_id, worker_definition_id)
  where worker_definition_id is not null;

-- A WorkerDefinition-tied principal is always agent-kind — this column exists specifically to give
-- a Worker's result contract an `asserted_by` identity, and `deriveEpistemicStatus`
-- (substrate/graph/store.ts) only produces `inferred` for `kind='agent'` (§5.6). Guarded the same
-- "check pg_constraint first" way every other additive constraint in this codebase is (e.g.
-- migrations/task/0003_task_worker_run_lineage.sql), since `alter table ... add constraint` has no
-- `if not exists` form of its own.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'principals_worker_definition_id_requires_agent'
  ) then
    alter table principals
      add constraint principals_worker_definition_id_requires_agent
      check (worker_definition_id is null or kind = 'agent');
  end if;
end
$$;
