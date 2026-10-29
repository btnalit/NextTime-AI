-- module: core, version: 0047
--
-- 0047_operation_version_guard (legacy 482). An Operation version the workspace published is what
-- every approval of it reads, and nothing changes it except the two governed transitions the
-- kernel has for it. An Operation has no table of its own (core 0034): it is an `objects` row
-- (`object_type = 'Operation'`) keyed by `identity_key` `{gatekeeperId, name, version}`, with its
-- definition, governance fields, lifecycle `status` and bookkeeping in `properties`.
--
-- Where approval reads come from: `mode`, `blast_radius`, `auto_approvable`, `await_decision`,
-- `reads`, `writes` and the MCP hints are the workspace's governance of the call
-- (`governance/gatekeepers/governance-fields.ts`). They are not the gate's: the onboarding wizard
-- reclassifies a gate's own description before the owner publishes it, so the workspace's value
-- legitimately differs from what the gate announces, and the gate's definition digest
-- (`@nexttime/gatekeeper-base` `operationDefinitionDigest`) leaves them out on purpose. What the
-- gate executes (name, binding, params, result mapping, the ssh blast radius) is in that digest,
-- and a gate refuses a call whose digest differs from its own. Legacy 482 found the other half
-- unguarded: any write to the row could change the governance an approval reads, and nothing but
-- the kernel's own code paths stood in the way (legacy 478 was such a path). This migration puts
-- the rule in the database instead.
--
-- 1. `objects_operation_version_guard` (BEFORE UPDATE):
--      - `object_type` never changes: an Operation row stays one, and no other row becomes one;
--      - `status` moves only along the Operation lifecycle (`@nexttime/shared` `OPERATION_EDGES`):
--        draft → published | discarded, published → deprecated; nothing leaves deprecated or
--        discarded, and nothing goes back to draft;
--      - once a version left draft, its `identity_key` never changes (except that a row from before
--        S3.12 may gain the `version` its key lacks: core 0016's backfill, which
--        `governance/gatekeepers/manifest.test.ts` re-issues against such a row), and its
--        `properties` never change except `status`, `description` (documentation:
--        `update_operation_description`, in place) and the governance fields (rule 2).
--    A draft is still the proposer's to rewrite, whole, and its publish may stamp bookkeeping in
--    the statement that flips it.
-- 2. `objects_operation_governance_audited` (constraint trigger, deferred to commit): a governance
--    field of a version that left draft changes only together with the
--    `operation.governance_refreshed` AuditRecord that states it, written in the same transaction
--    for the same Operation, whose `payload.after` carries the new value of every field that
--    changed. `refreshOperationGovernance` (`governance/gatekeepers/manifest.ts`) writes that record
--    right after each in-place write, so the check waits for the commit. "Same transaction" is
--    `created_at = now()`: the record's default timestamp is the transaction's start (the kernel
--    writes audit rows under savepoints too, so the inserting xid would not identify it). The
--    database proves the change is audited, truthfully; who may make it stays the capability's
--    check (`refresh_operation_governance` is owner-only).
--
-- No product path changes behaviour: publish, deprecate, discard, a draft's rewrite, a description
-- update and an in-place governance refresh all pass. Approvals are unchanged, and so is every
-- gate's definition digest. Both triggers hold every role, the login role included; inserts are
-- not checked (every product path inserts a draft). A later migration that has to rewrite versions
-- that left draft says so and disables the trigger around its own statement.
--
-- Reversibility (release.md §6): the previous release changes an Operation row only through the
-- same paths, and its `refresh_operation_governance` handler writes the same AuditRecord after the
-- in-place write, in the same transaction — so a code-only rollback keeps working on this schema.
-- Its own unit tests that call `refreshOperationGovernance` directly, without the handler, change
-- governance with no record and fail here by design; they are declared in
-- `migrations/reversibility-deltas.json`. Dropping both triggers and their functions undoes the
-- schema change.
--
-- Cross-process bootstrap lock: the core module's key (core/0001).
select pg_advisory_xact_lock(7241000101);

create or replace function objects_operation_version_guard() returns trigger
language plpgsql as $$
declare
  old_status text := old.properties ->> 'status';
  new_status text := new.properties ->> 'status';
  -- What may change on a version that left draft: its lifecycle, its documentation, and the
  -- governance fields (rule 2 holds those to their AuditRecord).
  mutable_keys constant text[] := array[
    'status', 'description',
    'mode', 'blast_radius', 'auto_approvable', 'await_decision', 'reads', 'writes',
    'read_only_hint', 'destructive_hint', 'idempotent_hint'
  ];
begin
  if new.object_type is distinct from old.object_type then
    raise exception 'objects: an Operation row stays one, and no other row becomes one (% -> %)',
      old.object_type, new.object_type;
  end if;
  if old_status is distinct from new_status and not (
       (old_status = 'draft' and new_status in ('published', 'discarded'))
       or (old_status = 'published' and new_status = 'deprecated')
     ) then
    raise exception 'objects: Operation % cannot move from % to %',
      old.identity_key, coalesce(old_status, 'no status'), coalesce(new_status, 'no status');
  end if;
  if old_status in ('published', 'deprecated', 'discarded')
     and new.identity_key is distinct from old.identity_key
     -- core 0016's backfill: a row from before S3.12 gains the `version` its key lacked.
     and not (old.identity_key is not null
              and not (old.identity_key ? 'version')
              and (new.identity_key - 'version') = old.identity_key) then
    raise exception 'objects: Operation % is % and keeps its identity', old.identity_key, old_status;
  end if;
  if old_status in ('published', 'deprecated', 'discarded')
     and (new.properties - mutable_keys) is distinct from (old.properties - mutable_keys) then
    raise exception 'objects: Operation % is % and its definition never changes; a changed definition is a new version',
      old.identity_key, old_status;
  end if;
  return new;
end;
$$;

create or replace trigger objects_operation_version_guard
  before update on objects
  for each row
  when (old.object_type = 'Operation' or new.object_type = 'Operation')
  execute function objects_operation_version_guard();

create or replace function objects_operation_governance_audited() returns trigger
language plpgsql as $$
declare
  changed_wire text[] := '{}';
  changed_stored text[] := '{}';
  field record;
begin
  -- Each governance field as the AuditRecord's `payload.after` names it and as the row stores it
  -- (`governance-fields.ts`'s `GOVERNANCE_FIELD_KEYS`; a hint the gate does not declare is stored
  -- as no key and stated as JSON null).
  for field in
    select * from (values
      ('mode', 'mode'),
      ('blastRadius', 'blast_radius'),
      ('autoApprovable', 'auto_approvable'),
      ('awaitDecision', 'await_decision'),
      ('reads', 'reads'),
      ('writes', 'writes'),
      ('readOnlyHint', 'read_only_hint'),
      ('destructiveHint', 'destructive_hint'),
      ('idempotentHint', 'idempotent_hint')
    ) as f(wire, stored)
  loop
    if (new.properties -> field.stored) is distinct from (old.properties -> field.stored) then
      changed_wire := changed_wire || field.wire;
      changed_stored := changed_stored || field.stored;
    end if;
  end loop;
  if cardinality(changed_stored) = 0 then
    return null;
  end if;
  if not exists (
    select 1
    from audit_records a
    where a.workspace_id = new.workspace_id
      and a.resource_id = new.id
      and a.action = 'operation.governance_refreshed'
      and a.created_at = now()
      and not exists (
        select 1
        from unnest(changed_wire, changed_stored) as c(wire, stored)
        where not (
          (a.payload -> 'after') ? c.wire
          and nullif(a.payload -> 'after' -> c.wire, 'null'::jsonb)
            is not distinct from (new.properties -> c.stored)
        )
      )
  ) then
    raise exception 'objects: Operation % is % and its governance (%) changes only with the operation.governance_refreshed audit record stating the new values',
      old.identity_key, old.properties ->> 'status', array_to_string(changed_stored, ', ');
  end if;
  return null;
end;
$$;

drop trigger if exists objects_operation_governance_audited on objects;

create constraint trigger objects_operation_governance_audited
  after update on objects
  deferrable initially deferred
  for each row
  when (
    old.object_type = 'Operation'
    and old.properties ->> 'status' in ('published', 'deprecated', 'discarded')
  )
  execute function objects_operation_governance_audited();
