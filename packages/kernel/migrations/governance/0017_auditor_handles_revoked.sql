-- module: governance, version: 0017
--
-- 0017_auditor_handles_revoked (review 2026-10-02 R-35 / decision D-07).
--
-- `auditor` becomes strictly read-only: an explicit allowlist of side-effect-free reads plus the
-- audit and provenance tools, and its own conversation with its entry agent — no Gatekeeper, no
-- `invoke_worker`, no graph writes (kernel `governance/capability/roles.ts`
-- `roleMayUseCapability`). A Handle's capability list is fixed when it is minted, though, and an
-- auditor's entry Handle minted by the previous release still lists every `minRole: 'member'`
-- capability (`invoke_worker`, `assert_fact`, `observe_operation`, ...) until it expires (24 h for
-- an entry Handle). The gate paths re-check the role on every call, but the other capabilities
-- trust the Handle's own scope (`authorizeCapabilityCall` is pure; the role narrowing happens at
-- issuance). So every unexpired, unrevoked Handle acting on behalf of an auditor is revoked here;
-- the entry agent mints a fresh one, under the new ceiling, on its next Turn. One audit record per
-- auditor whose Handles were revoked, saying it was this migration.
--
-- Reversibility (release.md §6): no schema change. The previous release re-mints a revoked entry
-- Handle the same way on the next Turn.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
select
  h.workspace_id,
  h.on_behalf_of,
  'principal.auditor_handles_revoked',
  'principal',
  h.on_behalf_of,
  jsonb_build_object(
    'by', 'migration governance/0017_auditor_handles_revoked',
    'reason', 'auditor is read-only (R-35 / D-07); Handles minted under the previous ceiling are revoked and re-minted on the next Turn',
    'revokedHandleCount', count(*)
  )
from capability_handles h
join principals p on p.workspace_id = h.workspace_id and p.id = h.on_behalf_of
where p.role = 'auditor'
  and h.revoked_at is null
  and h.expires_at > now()
group by h.workspace_id, h.on_behalf_of;

update capability_handles h
   set revoked_at = now()
  from principals p
 where p.workspace_id = h.workspace_id
   and p.id = h.on_behalf_of
   and p.role = 'auditor'
   and h.revoked_at is null
   and h.expires_at > now();
