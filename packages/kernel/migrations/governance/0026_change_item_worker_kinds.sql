-- module: governance, version: 0026
--
-- 0026_change_item_worker_kinds (S11 P1-D: docs/goal-orchestration-and-admin-agent-plan-
-- 2026-10-16.md §5.4 "ChangeItem 只能是对现有发布 / 配置能力的调用意图"; Pack Contract v1,
-- docs/s10-evolution-plan-2026-10-04.md §6.2). Two more ChangeItem kinds: publish the next version
-- of a Skill family (`skill_version`, the intent of `publish_skill`) and of a `worker`
-- WorkerDefinition family (`worker_definition_version`, the intent of
-- `publish_worker_definition`), so a pack's Skills and Workers install, upgrade and roll back
-- through the same core as its ontology families. Their `target` / `before` / `after` shapes are
-- `application/change-plan/family-item.ts`'s.
--
-- Only the kind CHECK changes (0025 named it inline: `change_items_kind_check`); values from
-- packages/shared enums.ts `CHANGE_ITEM_KIND_VALUES`. No earlier release reads `change_items`
-- (0025 is new in the same release), so widening the check costs no reversibility.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table change_items drop constraint if exists change_items_kind_check;
alter table change_items add constraint change_items_kind_check
  check (kind in ('ontology_version', 'skill_version', 'worker_definition_version'));
