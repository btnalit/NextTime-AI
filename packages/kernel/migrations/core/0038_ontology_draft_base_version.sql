-- module: core, version: 0038
--
-- An ontology draft records the published version it was proposed against (R-60, review
-- 2026-10-02). Until now `publish_ontology_version` published any draft of the caller's, however
-- old: of two drafts made from the same published version, the second to publish either had no
-- effect (a lower version number than the family's head, so `loadPublishedLinkTypes` never reads
-- it) or silently dropped every type the first one had added. `base_version` is the family's
-- highest `published` version when the draft was proposed (`proposeOntologyChange`), null when the
-- family had nothing published yet; publish refuses a draft whose family head is no longer that
-- version (`OntologyBaseMovedError`, 409 `ontology_base_moved`) and the proposer proposes again
-- from the new head. R-61 reads the same column so the console diffs a draft against its own base
-- rather than against the caller's merged type namespace.
--
-- Backfill (existing drafts only): the family's highest version that was already published when
-- the draft was created (`published_at <= created_at`) and is below the draft's own version — the
-- same value `proposeOntologyChange` would have stored. Published / deprecated rows stay null: a
-- base is only ever checked on a draft, and loader-published rows (bootstrap seed, domain packs,
-- modules) have no draft phase.
--
-- The check keeps a base strictly below its own row's version (it is always an earlier row of the
-- same family); the backfill satisfies it by construction, and code that does not know the column
-- writes null.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

alter table ontology_versions add column if not exists base_version int;

update ontology_versions d
   set base_version = (
     select max(p.version)
       from ontology_versions p
      where p.workspace_id = d.workspace_id
        and p.id = d.id
        and p.status <> 'draft'
        and p.published_at <= d.created_at
        and p.version < d.version
   )
 where d.status = 'draft'
   and d.base_version is null;

alter table ontology_versions drop constraint if exists ontology_versions_base_before_version;
alter table ontology_versions
  add constraint ontology_versions_base_before_version
  check (base_version is null or (base_version >= 1 and base_version < version));
