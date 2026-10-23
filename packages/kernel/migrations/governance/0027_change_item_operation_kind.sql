-- module: governance, version: 0027
--
-- 0027_change_item_operation_kind (S11 P1-E: docs/goal-orchestration-and-admin-agent-plan-
-- 2026-10-16.md §5.4 "ChangeItem 只能是对现有发布 / 配置能力的调用意图"). One more ChangeItem kind:
-- publish a revision of a published Operation that changes how calls of it are governed — its
-- description, blast radius, auto-approval, await-decision, reads and writes — never what the gate
-- runs (`operation_version`, the intent of `publish_operation` on a revision). Its `target` /
-- `before` / `after` shapes are `application/change-plan/operation-item.ts`'s.
--
-- Only the kind CHECK changes (0025 named it inline: `change_items_kind_check`); values from
-- packages/shared enums.ts `CHANGE_ITEM_KIND_VALUES`. No released version reads `change_items`
-- (0025 is new in the same release), so widening the check costs no reversibility. A segment's
-- verification is recorded in the columns 0025 already has (`verification`, `verified_at`).
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table change_items drop constraint if exists change_items_kind_check;
alter table change_items add constraint change_items_kind_check
  check (kind in ('ontology_version', 'skill_version', 'worker_definition_version',
                  'operation_version'));
