-- module: core, version: 0034
--
-- At most one `published` row per Operation identity (R-08, review 2026-10-02). An Operation has
-- no table of its own: it is an `objects` row (`object_type = 'Operation'`) whose identity is
-- `identity_key ->> 'gatekeeperId'` + `->> 'name'` (plus a `version` per revision, S3.12) and
-- whose lifecycle status is `properties ->> 'status'`. The code always meant "at most one
-- `published` row per identity" (`governance/gatekeepers/manifest.ts`), but nothing enforced it:
-- `importManifest` over a pending revision draft dropped the draft's `draftOf`, the publish that
-- followed (`enable_gate_instance`) left the old version live beside the new one, and
-- `getPublishedOperation` (`limit 1`, no ORDER BY) then returned either classification. The code
-- half of the fix ships alongside: `importManifest` keeps `draftOf`, `publishOperation` retires
-- every live row of the identity before it publishes, and `getPublishedOperation` orders by
-- version.
--
-- 1. Self-heal. Rows already duplicated by that path would make the constraint below fail to
--    build, so every `published` row except the highest version of its identity (ties: most
--    recently updated) is deprecated first, written exactly the way the kernel deprecates a row
--    (`setOperationStatusObject` / `deprecatePublishedOperationObjects`: `properties || {status:
--    'deprecated'}`, `updated_at` bumped). Keeping the highest version is what the fixed code
--    does on publish, and what the fixed `getPublishedOperation` already resolves to. Nothing is
--    deleted: the row, its id and its history stay queryable (`list_operations`). The count is
--    raised as a NOTICE; the PR body's "Host pre-check" query lists the same rows beforehand.
--
-- 2. Constraint. `objects_operation_single_published` is an exclusion constraint with `=` on all
--    three columns — the same rule a partial unique index states — because it must be
--    DEFERRABLE INITIALLY DEFERRED, which a unique index cannot be. Reversibility needs that:
--    the previous release's `publishOperation` flips the revision to `published` *first* and
--    deprecates the superseded row in the next statement, so a statement-level check would
--    break its ordinary revision publish after a code rollback. Checked at commit, that order
--    passes, while a transaction that really leaves two live rows still fails. The current code
--    deprecates first, so it would pass either way.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

do $$
declare
  healed integer;
begin
  with ranked as (
    select workspace_id,
           id,
           row_number() over (
             partition by workspace_id, identity_key ->> 'gatekeeperId', identity_key ->> 'name'
             order by coalesce((properties ->> 'version')::int, 1) desc, updated_at desc, id desc
           ) as rn
    from objects
    where object_type = 'Operation'
      and properties ->> 'status' = 'published'
      and identity_key ->> 'gatekeeperId' is not null
      and identity_key ->> 'name' is not null
  )
  update objects
  set properties = objects.properties || '{"status":"deprecated"}'::jsonb,
      updated_at = now()
  from ranked
  where objects.workspace_id = ranked.workspace_id
    and objects.id = ranked.id
    and ranked.rn > 1;
  get diagnostics healed = row_count;
  raise notice 'core 0034: deprecated % duplicate published Operation row(s), keeping the highest version per identity', healed;
end
$$;

alter table objects drop constraint if exists objects_operation_single_published;

alter table objects
  add constraint objects_operation_single_published
  exclude using btree (
    workspace_id with =,
    (identity_key ->> 'gatekeeperId') with =,
    (identity_key ->> 'name') with =
  )
  where (object_type = 'Operation' and properties ->> 'status' = 'published')
  deferrable initially deferred;
