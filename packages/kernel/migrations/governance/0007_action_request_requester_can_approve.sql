-- module: governance, version: 0007
--
-- Adds `action_requests.requester_can_approve` (authority-tightening fix, review job 652a4abc
-- item 3: "persist requester_can_approve on ActionRequests and reject self-approval in
-- assertApproverScope for high-blast requests"). `governance/policy/engine.ts`'s `evaluate()`
-- already computes a `requesterCanApprove` result on every call (I8/§5.8: defaults `false` for
-- `blast_radius='high'`, `true` otherwise, overridable by the workspace's `policies` row) but the
-- value was discarded the instant `requestAction()` returned — `decide.ts`'s `approve`/`reject`
-- had no way to know whether the *requester* of a pending row was ever allowed to be its own
-- approver, so `approver === on_behalf_of` was never checked at all. This column is the durable
-- record `assertApproverScope` (governance/approval/decide.ts) now reads back to refuse exactly
-- that case.
--
-- Nullable, not backfilled: no historical row (written before this migration) was ever evaluated
-- against this rule, and there is no way to recompute `requesterCanApprove` for one after the fact
-- without re-running policy evaluation against whatever the workspace's `policies` row looked like
-- at request time (which may since have changed) — same "do not fabricate history" reasoning
-- governance/0006's own `executing_at` migration already documents. `decide.ts` treats `null` as
-- permissive (self-approval not blocked), matching this column's absence today; every row
-- `governance/approval/request-action.ts`'s `insertActionRequestRow` writes going forward always
-- sets it explicitly (never leaves it to default).
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table action_requests add column if not exists requester_can_approve boolean;
