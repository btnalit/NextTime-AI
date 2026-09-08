-- module: core, version: 0016
--
-- Operation identity backfill for the S3.12 revision-versioning fix (fix/operation-revision-via-
-- propose): `governance/gatekeepers/manifest.ts`'s Operation identity gained a third field,
-- `version` — `{gatekeeperId, name, version}`, following the same `{id, version}` convention
-- `WorkerDefinition`/`Skill`/`Procedure` already use (`substrate/ontology/meta-objects.ts`) —
-- instead of the old two-field `{gatekeeperId, name}`. Every Operation `objects` row written
-- before that change has an `identity_key` with no `version` key at all.
--
-- Why this matters (compatibility gap caught in review before merge): the new code reads an
-- Operation's "current" row by extracting `identity_key ->> 'gatekeeperId'` / `->> 'name'`
-- (`governance/gatekeepers/manifest.ts`'s `getOperation`/`getPublishedOperation`), which still
-- finds a legacy two-field row just fine — reads are unaffected. But every *write* on that row's
-- identity (`substrate/ontology/meta-objects.ts`'s `registerOperationDraftObject`/
-- `setOperationStatusObject`) constructs the exact `{gatekeeperId, name, version}` JSON value the
-- `objects_identity_key_uidx` partial unique index (migrations/core/0006_object_identity.sql)
-- conflicts/upserts against. A legacy row's real `identity_key` — `{gatekeeperId, name}`, no
-- `version` — never matches that constructed value, at any version number. Concretely: publishing
-- a revision draft against a legacy published Operation would try to deprecate the legacy row via
-- `setOperationStatusObject({gatekeeperId, name, version: 1}, 'deprecated')`; since no row has
-- that *exact* identity_key, this silently **inserts a new, incomplete row** (`{status:
-- 'deprecated'}` only — none of the Operation's own fields) instead of updating the legacy one,
-- leaving the legacy row still `published` — two `published` rows would then exist for the same
-- identity, and `find_operations`/`list_allowed_operations`/gate tool resolution (`getPublishedOperation`,
-- all `status = 'published'` filters) would have two candidates to choose from instead of one.
--
-- The fix: give every legacy Operation row the `version` it always implicitly had (there was only
-- ever one version possible before this PR, so `1` is exact, not a guess) — `identity_key ->
-- 'version'` is added in place, every other column (including the row's `id`, so `draftOf`/
-- `supersedes` references keep working) is untouched.
--
-- Collision safety (reviewer ask: "if two legacy rows would collide, log/raise rather than
-- silently merge"): `objects_identity_key_uidx` is a real Postgres unique index over
-- `(workspace_id, object_type, identity_key)`. A plain `update` that produced two rows with the
-- same post-update `identity_key` would fail that constraint and abort this migration's
-- transaction with a `unique_violation` — there is no path through a bare `update` that could
-- silently merge two rows the way an `ON CONFLICT DO UPDATE` could. In practice this cannot
-- actually fire from pre-existing data alone: the *same* index, with the two-field identity, was
-- already enforcing "at most one row per `(workspace_id, 'Operation', {gatekeeperId, name})`"
-- before this PR, so at most one legacy row exists per identity to begin with. The one real way to
-- reach a genuine collision is deploying the new kernel code (which can already write
-- three-field-identity Operation rows) *before* running this migration, and using it against a
-- legacy identity in between — standard practice (this repo's own migration runner is a separate
-- CLI step, `packages/kernel/src/cli/migrate.ts` / `pnpm migrate`, never run implicitly at kernel
-- startup) is to run pending migrations before the new version starts serving traffic, exactly as
-- every earlier migration in this module already assumes.
--
-- Cross-process bootstrap lock: same core-module advisory lock key as every other file in this
-- module (see 0001_identity.sql's own comment for the full rationale).
select pg_advisory_xact_lock(7241000101);

update objects
set identity_key = identity_key || jsonb_build_object('version', 1)
where object_type = 'Operation'
  and identity_key is not null
  and not (identity_key ? 'version');
