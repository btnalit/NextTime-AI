-- module: core, version: 0017
--
-- S3.2 冲突检测 (docs/development-tasks.md S3.2, design doc §5.4 I5, §5.5 Conflict state machine,
-- §5.6 "两个死角的规则：私有 Fact 与工作区 Fact 冲突时，Conflict 只对私有一方可见"). `conflicts`
-- (migrations/core/0002_substrate.sql) already has `conflict_type`/`status`/`link_a_id`/
-- `link_b_id`/`resolution` — this migration adds the two columns S3.2's write path needs
-- (`activity_id` for I3-style traceability, `resolved_by` for the human who resolved it) and
-- replaces the workspace-only RLS policy that table's own 0002 comment already flagged as a S3.2
-- gap ("Full private-participant visibility ... is conflict-detection logic that does not exist
-- yet (S3.2 冲突检测); RLS here is workspace-only for S1.1").
--
-- `conflicts` has never had a writer (grep confirms zero INSERT/UPDATE against it anywhere in
-- `packages/kernel/src` before this task) — safe to add `activity_id` as `NOT NULL` directly, no
-- backfill needed.
select pg_advisory_xact_lock(7241000101);

-- activity_id: which Activity's Fact assertion triggered this Conflict being opened
-- (`substrate/epistemic/conflicts.ts`'s `openConflict` always supplies the *new* Fact's own
-- `activity_id` — the one whose assertion discovered the disagreement) — mirrors `links.activity_id`
-- (I3: every Fact traces to the Activity that produced it) one level up, for the same reason:
-- `explain`/`causal_chain` need a Conflict to be traceable to *something*, and the triggering
-- Activity is the only provenance a Conflict has beyond the two Facts it references.
alter table conflicts add column if not exists activity_id uuid;
alter table conflicts add column if not exists resolved_by uuid;

update conflicts c set activity_id = l.activity_id
  from links l
  where l.workspace_id = c.workspace_id and l.id = c.link_b_id and c.activity_id is null;

alter table conflicts alter column activity_id set not null;

alter table conflicts
  add constraint conflicts_activity_id_fkey
  foreign key (workspace_id, activity_id) references activities (workspace_id, id);

alter table conflicts
  add constraint conflicts_resolved_by_fkey
  foreign key (workspace_id, resolved_by) references principals (workspace_id, id);

-- Mirrors `links`' own "verified ⇒ verified_by" CHECK (0002_substrate.sql) one level up: a
-- Conflict that has left `open` must carry who resolved it and when — `resolve_conflict`
-- (application/gateway/epistemic-handlers.ts) always sets all three (`status`/`resolved_by`/
-- `resolved_at`) in the same UPDATE, so this is never a partial-write state.
alter table conflicts
  add constraint conflicts_resolved_fields_check
  check (status = 'open' or (resolved_by is not null and resolved_at is not null));

-- Visibility (§5.6, design doc's own "两个死角" rule; this is the S3.2 gap 0002's own comment
-- flagged): a Conflict is visible to the caller only if *both* Facts it references are — reusing
-- `link_visible_to_caller` (migrations/core/0013_link_visibility_security_definer.sql) once per
-- side, via a second `security definer` function for the same reason 0013 needed one: a plain SQL
-- join here would need to read `links`/`observations`/`sources` rows the querying role
-- (`nexttime_app`) has no RLS visibility into on its own.
--
-- `coalesce(..., false)`: defensive only — `link_a_id`/`link_b_id` are `not null` with real FKs to
-- `links`, so the two-row `from links la, links lb` join below always finds exactly one row each in
-- practice; `coalesce` just makes "can't resolve the linked Facts" fail closed (hidden) rather than
-- erroring, matching this function's "boolean only, never row data" contract.
create or replace function conflict_visible_to_caller(
  p_workspace_id uuid, p_link_a_id uuid, p_link_b_id uuid
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select link_visible_to_caller(p_workspace_id, la.activity_id)
         and link_visible_to_caller(p_workspace_id, lb.activity_id)
      from links la, links lb
      where la.workspace_id = p_workspace_id and la.id = p_link_a_id
        and lb.workspace_id = p_workspace_id and lb.id = p_link_b_id
    ),
    false
  )
$$;

grant execute on function conflict_visible_to_caller(uuid, uuid, uuid) to nexttime_app;

drop policy if exists conflicts_workspace_isolation on conflicts;
drop policy if exists conflicts_visibility on conflicts;

-- Deliberately asymmetric `using`/`with check` (unlike `links_visibility`, which uses the same
-- predicate both ways) — see PR body "假设" for the full reasoning: the *reader* of a Conflict row
-- (`list_conflicts`, and `resolve_conflict`/`verify_fact`'s own row lookups) should only ever see
-- rows where they can see both sides, hence `using` below. But the *writer* — `openConflict`,
-- called from inside `SqlGraphStore.assertFact` at the moment the second, conflicting Fact is
-- asserted — is very often a *different* principal than the owner of the *other* (pre-existing)
-- Fact's private Source (that is the whole point of "异源不一致 → Conflict", I5): the acting
-- principal at INSERT time frequently cannot see the row they are about to create under the
-- `using` predicate. A single symmetric policy would make exactly the "private Fact 与 workspace
-- Fact 冲突" case §5.6 calls out fail to even open a Conflict row. `with check` is therefore just
-- `workspace_id = app_workspace()` (I1) — creation is unrestricted within the caller's own
-- workspace; `link_a_id`/`link_b_id`'s composite FKs to `links` already make a cross-workspace or
-- non-existent Fact reference impossible regardless.
create policy conflicts_visibility on conflicts
  for all
  using (
    workspace_id = app_workspace()
    and conflict_visible_to_caller(workspace_id, link_a_id, link_b_id)
  )
  with check (workspace_id = app_workspace());
