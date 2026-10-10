-- module: governance, version: 0019
--
-- 0019_action_request_operation_digest (legacy K: approve X, run Y).
--
-- A gate runs the definition in its own manifest. The kernel approves its own copy, the
-- workspace's Operation. Nothing tied the two together, so a gate whose manifest changed after the
-- Operation was published ran something other than what was approved. Every call now carries the
-- digest of the definition the kernel approved, and the gate refuses a call whose digest is not
-- that of the definition it runs (@nexttime/gatekeeper-base operation-digest.ts).
--
-- An `execute` call is approved when its ActionRequest is made, and may run much later (a human
-- approves it, the drainer applies it, the reaper replays it). `operation_digest` records the
-- definition the request was made against, taken from the published Operation (or, for an
-- unpublished one, I17, from its current draft) in the same transaction as the insert. The
-- executor sends it, never a digest read at execution time: a revision published in between is
-- not what was approved. An unpublished Operation with no draft records `none`: nothing was
-- approved against a definition, and the executor refuses the row rather than run whatever is
-- published by then.
--
-- Nullable, not backfilled: a row written before this migration (or by the previous release
-- after a rollback) was never tied to a definition. The executor then uses the Operation published
-- at execution time, which is what that row would have run before, now checked by the gate; with
-- nothing published it refuses the row, readably, without calling the gate. A replay of such a
-- row sends no digest, and the gate answers only from its idempotency store.
--
-- Reversibility (release.md §6): one nullable column. The previous release never names it, so its
-- inserts leave it null and its reads (explicit column lists) do not see it.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table action_requests add column if not exists operation_digest text
  constraint action_requests_operation_digest_shape
  check (operation_digest is null or operation_digest = 'none'
         or operation_digest ~ '^sha256:[0-9a-f]{64}$');
