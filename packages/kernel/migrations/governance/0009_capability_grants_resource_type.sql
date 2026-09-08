-- module: governance, version: 0009
--
-- docs/wire-contract-conventions.md §1 vocabulary table / §2 "标识" (2026-09-08 decision):
-- `capability_grants.capability` is renamed `resource_type` and a first-class `resource_id uuid`
-- column is added — the vocabulary's own ruling: "Grant 不再借用「capability」这个词——capability
-- 只指注册表里的能力名". Before this migration, `capability` doubled as two different things:
--
--   - a resource-type marker (today only `'gatekeeper'`, `GATEKEEPER_GRANT_CAPABILITY` in
--     governance/capability/grants.ts) whose target resource id was folded into the opaque
--     `scope ->> 'resourceScope'` json field (`connect_gatekeeper` / `grant_capability
--     {capability:'gatekeeper', scope:{resourceScope:<gatekeeperId>}}`, the writer this migration's
--     backfill reads);
--   - a bare I14 action_kind string (e.g. `'container.restart'`) for an approval-queue grant with
--     no single resource instance at all (`hasActiveGrant`'s `capability = action_kind` match,
--     `set_auto_approved_action_kind`'s `hasAnyActiveGrant` check) — these rows have no gatekeeper
--     id to promote, so `resource_id` stays null for them; matching still narrows on the renamed
--     `resource_type` column exactly as it did on `capability` before this migration (no behavior
--     change for this case, see grants.ts's own updated doc comments).
--
-- `resource_id` is `uuid` (not `text`) because every real resource id this table has ever stored —
-- a Gatekeeper's `objects.id` — is a uuid; an action_kind-scoped row (never a real resource
-- instance) simply leaves it null, which the nullable column allows.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module.
select pg_advisory_xact_lock(7241000201);

alter table capability_grants add column if not exists resource_id uuid;

-- Backfill: for every existing row whose `scope ->> 'resourceScope'` is a well-formed uuid (in
-- practice, every `capability = 'gatekeeper'` row `connect_gatekeeper`/`grant_capability` ever
-- wrote — governance/capability/grants.ts's `grantCapability`, `scope: {resourceScope:
-- <gatekeeperId>}`), promote it to the new first-class column and strip it out of `scope` (the
-- vocabulary's own "scope 只留真正的范围限定" — nothing else has ever been stored in this table's
-- `scope` besides that one key, so every migrated row ends up with `scope = '{}'`). A row whose
-- `resourceScope` is absent, or present but not a uuid (defensive — no writer has ever produced
-- that), is left with `resource_id = null` and its `scope` untouched.
update capability_grants
set resource_id = (scope ->> 'resourceScope')::uuid,
    scope = scope - 'resourceScope'
where scope ->> 'resourceScope' is not null
  and scope ->> 'resourceScope' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

alter table capability_grants rename column capability to resource_type;

-- RLS is column-agnostic (`workspace_id = app_workspace()`, migrations/governance/0002_policy.sql)
-- and needs no change; re-asserted here only so a fresh bootstrap and an upgraded database end up
-- with the identical, named policy either way (same belt-and-suspenders convention every prior
-- ALTER-only migration in this module already follows, e.g. 0007's own header comment).
drop policy if exists capability_grants_workspace_isolation on capability_grants;

create policy capability_grants_workspace_isolation on capability_grants
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());
