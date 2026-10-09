-- module: governance, version: 0018
--
-- 0018_container_held_handles_revoked (Handle root fix: container-held Handles, source binding).
--
-- From this release on, the Handle of an entry agent (session kind `entry`) or a WorkerRun
-- (`worker_run`) is container-held: it never enters the agent container, carries the claim
-- `hld: "container"`, and is accepted only through the source binding worker-supervisor keeps for
-- the container's address (@nexttime/shared handle-binding.ts); presented as a bearer token it is
-- refused (kernel application/gateway/handle-auth.ts, llm-proxy). Every such Handle minted by the
-- previous release, though, sat in its container's environment — readable by the model's own
-- shell — and is a plain bearer token: up to 24 h left for an entry Handle, a WorkerRun's run
-- limit for a Worker's. The kernel already refuses them as bearers (it reads the issuing session's
-- kind, not only the claim); llm-proxy only has the token, so they are revoked here, which it picks
-- up through its revocation sync. The entry agent mints a fresh, container-held Handle on its next
-- Turn (its in-memory cache is gone after the kernel restart anyway). A Worker that was still
-- running across the upgrade loses its Handle and fails; drain Workers before the window. One
-- audit record per Principal whose Handles were revoked, saying it was this migration.
--
-- Reversibility (release.md §6): no schema change, only `revoked_at` (allowed by 0015's monotonic
-- revocation trigger). The previous release re-mints a revoked entry Handle on the next Turn
-- (`ensureEntryHandle` checks the cached jti's revocation), so rolling back the code needs nothing
-- else; the revoked Handles stay revoked.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
select
  h.workspace_id,
  h.on_behalf_of,
  'principal.container_handles_revoked',
  'principal',
  h.on_behalf_of,
  jsonb_build_object(
    'by', 'migration governance/0018_container_held_handles_revoked',
    'reason', 'entry and WorkerRun Handles are container-held from this release on; Handles minted earlier sat in the agent container''s environment as bearer tokens and are revoked',
    'revokedHandleCount', count(*)
  )
from capability_handles h
join sessions s on s.workspace_id = h.workspace_id and s.id = h.session_id
where s.kind in ('entry', 'worker_run')
  and h.revoked_at is null
  and h.expires_at > now()
group by h.workspace_id, h.on_behalf_of;

update capability_handles h
   set revoked_at = now()
  from sessions s
 where s.workspace_id = h.workspace_id
   and s.id = h.session_id
   and s.kind in ('entry', 'worker_run')
   and h.revoked_at is null
   and h.expires_at > now();
