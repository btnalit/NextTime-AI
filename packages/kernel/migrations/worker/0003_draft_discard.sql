-- module: worker, version: 0003
--
-- discard_draft (S8 W3 K2, leftover 82, docs/convergence-plan-2026-09-25.md §4 row 82):
-- WorkerDefinition / Skill / Procedure drafts (I16 "提议者私有") had `draft -> published` as their
-- only exit — the maintainer decided drafts also get `draft -> discarded` (manual, the
-- `discard_draft` capability) and `draft -> expired` (periodic kernel sweep,
-- `application/worker/draft-lifecycle.ts`'s `expireDraftsOnce`). Both remove the row outright — a
-- real deletion, not a fourth `PublishableStatus` value: neither table's `status` CHECK gains a
-- `discarded`/`expired` member, and the AuditRecord written in the same transaction as the delete
-- is the durable record that a draft once existed, why it was removed, and by whom (I11).
--
-- Safety (checked against every write path in this codebase, not assumed): 0001/0002 granted
-- `nexttime_app` nothing but SELECT/INSERT/UPDATE on these three tables — no existing path can
-- delete a `published`/`deprecated` row. `tasks.worker_definition_id` /
-- `.worker_definition_version` (migrations/task/0001_tasks.sql) are bare columns with **no FK**
-- (`worker` sorts after `task` — that migration's own header comment) and only ever pin a
-- **published** version (`application/worker/definitions.ts`'s `requirePublishedWorkerDefinition`,
-- the only resolver `invoke_worker`/`propose_procedure`'s step validation ever calls). A `draft`
-- row is therefore never referenced by a Task, never has a graph Object projection
-- (`substrate/ontology`'s `project*Object` is only ever called from each module's own `publish*`),
-- and is never resolved by another WorkerDefinition's `skills`/`steps` (those resolve only against
-- **published** rows, and only at *that other row's own* publish time —
-- `skills.ts`'s `linkPublishedWorkerDefinitionsUsingSkill`, `procedures.ts`'s
-- `resolveStepTargets`). Deleting a `draft` row therefore never orphans anything by construction.
-- The trigger below still enforces "only ever a draft row" at the database layer — the same
-- defense-in-depth convention 0001/0002's own `*_block_published_mutation` triggers already
-- established for UPDATE, extended here to DELETE — rather than trusting the application layer
-- (`discardDraft`'s own `status = 'draft'` check, `expireDraftsOnce`'s own `where status = 'draft'`
-- scan) alone.
--
-- Runner ordering / advisory lock: same module (`worker`), same key as 0001/0002 — locks are
-- per-module, not per-file (0002's own header comment documents the identical precedent).
select pg_advisory_xact_lock(7241000501);

grant delete on worker_definitions to nexttime_app;
grant delete on skills to nexttime_app;
grant delete on procedures to nexttime_app;

create or replace function worker_definitions_block_non_draft_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception
      'worker_definitions: only a draft row may be deleted, not % (I16/I12)', old.status;
  end if;
  return old;
end;
$$;

create or replace trigger worker_definitions_only_draft_delete
  before delete on worker_definitions
  for each row execute function worker_definitions_block_non_draft_delete();

create or replace function skills_block_non_draft_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'skills: only a draft row may be deleted, not % (I16/I12)', old.status;
  end if;
  return old;
end;
$$;

create or replace trigger skills_only_draft_delete
  before delete on skills
  for each row execute function skills_block_non_draft_delete();

create or replace function procedures_block_non_draft_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'procedures: only a draft row may be deleted, not % (I16/I12)', old.status;
  end if;
  return old;
end;
$$;

create or replace trigger procedures_only_draft_delete
  before delete on procedures
  for each row execute function procedures_block_non_draft_delete();
