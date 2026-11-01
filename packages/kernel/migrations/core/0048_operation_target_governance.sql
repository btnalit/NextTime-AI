-- module: core, version: 0048
--
-- 0048_operation_target_governance (S11 GO12: docs/goal-orchestration-and-admin-agent-plan-
-- 2026-10-16.md §4.10; the shared plan s11-w2/go12-default-plan.md). An Operation may now declare
-- the one instance a call acts on (`target`, `@nexttime/shared` `OperationTargetSchema`); the
-- queue orders a request only behind earlier requests on that instance and those on the whole
-- Gatekeeper (governance 0030). Like `reads` / `writes`, `target` is the workspace's governance of
-- the call, not part of what the gate executes: the gate's definition digest leaves it out, and an
-- owner aligns a published version to a gate that now declares it in place
-- (`refresh_operation_governance`), with the `operation.governance_refreshed` AuditRecord.
--
-- core 0047 holds a published version's properties to its lifecycle, its description and the
-- governance fields it lists; `target` was not among them, so the database refused that in-place
-- write as a definition change. This migration re-creates 0047's two functions with `target`
-- added, and nothing else changed:
--
--   1. `objects_operation_version_guard`: `target` joins the keys a version that left draft may
--      change (the governance fields, held by rule 2);
--   2. `objects_operation_governance_audited`: a change of `target` goes through only with the
--      AuditRecord whose `payload.after.target` states the new value as the wire states it —
--      `{"objectType": …, "params": [...]}` for the stored `{"object_type": …, "params": [...]}`,
--      JSON null (or no key) for none (`governance-fields.ts` `operationGovernanceFieldsOf`).
--
-- Both triggers stay as 0047 made them; only their functions change.
--
-- Rolling back (docs/runbooks/release.md §6). Code without this migration never writes `target`
-- on a published version, so code alone may roll back at any time. To drop the schema too: run
-- the two `create or replace function` statements of core/0047_operation_version_guard.sql again,
-- then `delete from schema_migrations where module = 'core' and version = 48`. A published version
-- that already carries `target` keeps it (0047 refuses only a change of it).
--
-- Cross-process bootstrap lock: the core module's key (core/0001).
select pg_advisory_xact_lock(7241000101);

create or replace function objects_operation_version_guard() returns trigger
language plpgsql as $$
declare
  -- No status is draft (rule 1): a NULL here would leave every comparison below unknown.
  old_status text := coalesce(old.properties ->> 'status', 'draft');
  new_status text := coalesce(new.properties ->> 'status', 'draft');
  -- What may change on a version that left draft: its lifecycle, its documentation, and the
  -- governance fields (rule 2 holds those to their AuditRecord).
  mutable_keys constant text[] := array[
    'status', 'description',
    'mode', 'blast_radius', 'auto_approvable', 'await_decision', 'reads', 'writes',
    'read_only_hint', 'destructive_hint', 'idempotent_hint', 'target'
  ];
begin
  if new.object_type is distinct from old.object_type then
    raise exception 'objects: an Operation row stays one, and no other row becomes one (% -> %)',
      old.object_type, new.object_type;
  end if;
  if old_status <> new_status and not (
       (old_status = 'draft' and new_status in ('published', 'discarded'))
       or (old_status = 'published' and new_status = 'deprecated')
     ) then
    raise exception 'objects: Operation % cannot move from % to %',
      old.identity_key, old_status, new_status;
  end if;
  if old_status <> 'draft'
     and (new.workspace_id is distinct from old.workspace_id
          or new.id is distinct from old.id
          or (new.identity_key is distinct from old.identity_key
              -- core 0016's backfill: a row from before S3.12 gains the `version` its key lacked.
              and not coalesce(
                old.identity_key is not null
                and not (old.identity_key ? 'version')
                and (new.identity_key - 'version') = old.identity_key,
                false))) then
    raise exception 'objects: Operation % is % and keeps its identity', old.identity_key, old_status;
  end if;
  if old_status <> 'draft'
     and (new.properties - mutable_keys) is distinct from (old.properties - mutable_keys) then
    raise exception 'objects: Operation % is % and its definition never changes; a changed definition is a new version',
      old.identity_key, old_status;
  end if;
  return new;
end;
$$;

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
      ('idempotentHint', 'idempotent_hint'),
      ('target', 'target')
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
      -- An object, so `?` asks for a key (on an array it would match an element) and a field it
      -- does not state is absent, not unknown: an unknown here would count as stated.
      and jsonb_typeof(a.payload -> 'after') = 'object'
      and not exists (
        select 1
        from unnest(changed_wire, changed_stored) as c(wire, stored)
        where not coalesce(
          (a.payload -> 'after') ? c.wire
          and nullif(a.payload -> 'after' -> c.wire, 'null'::jsonb)
            is not distinct from (
              -- core 0048: `target` is stored as the manifest writes it (`{object_type, params}`)
              -- and stated as the wire writes it (`{objectType, params}`); a stored value of any
              -- other shape is compared as it is.
              case
                when c.stored <> 'target' then new.properties -> c.stored
                when jsonb_typeof(new.properties -> 'target') = 'object' then jsonb_build_object(
                  'objectType', new.properties -> 'target' -> 'object_type',
                  'params', new.properties -> 'target' -> 'params')
                else new.properties -> 'target'
              end),
          false
        )
      )
  ) then
    raise exception 'objects: Operation % is % and its governance (%) changes only with the operation.governance_refreshed audit record stating the new values',
      old.identity_key, old.properties ->> 'status', array_to_string(changed_stored, ', ');
  end if;
  return null;
end;
$$;
