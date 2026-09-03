-- module: governance, version: 0004
--
-- Adds `action_requests.params` (design doc §5.1.4 Gatekeeper protocol `apply`; docs/development-
-- tasks.md S2.4). S2.1's original `action_requests` table (0003_action_requests.sql) has no
-- column for the Operation call's own arguments — only `action_kind`/`resource_scope`/
-- `gatekeeper_id` identify *which* governed action this is, not the literal `params` a Worker
-- passed to `request_action`. S2.4's execution path (`ActionExecutor`, `application/gateway/
-- action-executor.ts`) needs those params again at `apply` time, which can happen well after — and
-- in a different transaction than — the original `request_action` call (auto-approval executes
-- inline; a `pending_approval` row is applied later, by a human's `approve` triggering the
-- drainer, or by the periodic drain tick). Rather than reconstruct `params` from `action_kind`
-- (impossible — `action_kind` is deliberately just the Operation's own `name`, §5.1.4 "门是通用传输
-- 种类的一个实例" — no gate-name prefix, see governance/gatekeepers/manifest.ts's own doc comment),
-- this migration adds a dedicated column and stores the exact call arguments at `request_action`
-- time.
--
-- A new file, not an edit to 0003 (that migration is already applied on `main` — S2.1/S2.2/S2.3
-- landed before this task started): `jsonb not null default '{}'::jsonb` so the `alter table` is
-- safe against any already-existing rows (there are none yet in a fresh S2 workspace, but the
-- default keeps this migration idempotent-safe regardless).
--
-- Cross-process bootstrap lock: see core/0001_identity.sql's comment for the full rationale — the
-- same governance-module advisory lock key as every other file in this module.
select pg_advisory_xact_lock(7241000201);

alter table action_requests add column if not exists params jsonb not null default '{}'::jsonb;
