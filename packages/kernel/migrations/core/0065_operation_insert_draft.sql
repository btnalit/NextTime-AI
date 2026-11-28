-- module: core, version: 0065
--
-- 0065_operation_insert_draft (legacy 484). An Operation row is only ever inserted as a draft.
-- Every product path does that already (`registerOperationDraftObject`, the import and the
-- proposal channels alike); publishing, deprecating and discarding are later updates that core
-- 0047's `objects_operation_version_guard` holds to the lifecycle. What the database did not check
-- is the insert itself: core 0047 left it out ("a row inserted already past draft is the same
-- unproven publish"). The mistake this catches is a write meant for an existing row landing on no
-- row: `setOperationStatusObject` (`substrate/ontology/meta-objects.ts`) upserts `{status}` by
-- identity, so a publish, deprecate or discard for an identity that does not exist would insert an
-- incomplete Operation already past draft, with no definition and a lifecycle nobody walked.
--
-- `objects_operation_insert_draft` (AFTER INSERT): a new Operation row's `status` is draft. No
-- `status`, or a JSON null, is a draft, as every reader takes it (`manifest.ts`'s
-- `status ?? 'draft'`, core 0047's coalesce); anything else is refused, and so the insert with it.
-- The check is AFTER, not BEFORE: the graph store writes objects with
-- `insert ... on conflict (identity) do update` (`substrate/graph/queries.ts`'s
-- `buildUpsertObjectQuery`), and a BEFORE INSERT trigger fires on the proposed row even when the
-- statement ends up updating the existing one — it would refuse `setOperationStatusObject`'s publish of a draft that exists,
-- the very path that must pass. An AFTER INSERT trigger fires only for a row that was inserted;
-- the update path is core 0047's (#765 review #493 P3-1).
--
-- Like core 0047 this does not prove who publishes: a draft's flip is still an edge for any writer,
-- and `publish_operation` decides who may take it. It holds every role, the login role included.
--
-- Reversibility (release.md §6): the previous release inserts Operation rows only as drafts, its
-- product paths and its test fixtures alike (legacy 484 step 1, #1287, which went out in a release
-- before this one: `manifest.test.ts`, `find-means`, `operation-draft-visibility` insert a draft
-- and flip it), so a code-only rollback keeps working on this schema. Dropping the trigger and its
-- function undoes the schema change.
--
-- Cross-process bootstrap lock: the core module's key (core/0001).
select pg_advisory_xact_lock(7241000101);

create or replace function objects_operation_insert_draft() returns trigger
language plpgsql as $$
begin
  -- `->>` of a JSON null is NULL, and no `status` is NULL too: both are a draft.
  if coalesce(new.properties ->> 'status', 'draft') <> 'draft' then
    raise exception 'objects: Operation % is inserted as a draft, not %; it leaves draft only by an update of the row that exists',
      new.identity_key, new.properties ->> 'status';
  end if;
  return null;
end;
$$;

create or replace trigger objects_operation_insert_draft
  after insert on objects
  for each row
  when (new.object_type = 'Operation')
  execute function objects_operation_insert_draft();
