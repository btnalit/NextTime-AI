-- module: core, version: 0037
--
-- A gate's re-announced manifest is confirmed before it takes effect (R-18, review 2026-10-02,
-- maintainer decision D-18 together with D-02). Until now every announce from a matching identity
-- replaced `gate_instances.operations`, the manifest `enable_gate_instance` imports and
-- `refresh_operation_governance` aligns to — so whatever a gate announced reached workspaces
-- without anyone looking at it. Now, once the administrator has decided on an instance
-- (`enabled` / `disabled`), an announcement that changes its Operation set or a reviewed field is
-- held in `pending_operations` (with `pending_announced_at`) and `operations` stays until a
-- platform administrator confirms that exact version (`confirm_gate_manifest`, by digest). A
-- re-announce of the manifest in effect (a gate restart) clears it again, so the normal case
-- never leaves anything pending.
--
-- Both columns are nullable with no default: every existing row reads "nothing pending", which is
-- exactly true. `nexttime_app` already holds select / insert / update on `gate_instances` (0023),
-- and the table's RLS policies (`gate_instances_read_all`, `gate_instances_platform_admin`) are
-- per-row, so they cover the new columns unchanged.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

alter table gate_instances add column if not exists pending_operations jsonb;
alter table gate_instances add column if not exists pending_announced_at timestamptz;
