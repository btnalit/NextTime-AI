import {
  CONFLICT_TYPE_VALUES,
  DECISION_STATUS_VALUES,
  EPISTEMIC_STATUS_VALUES,
  PRINCIPAL_KIND_VALUES,
  TASK_FAILURE_REASON_VALUES,
  TURN_STATUS_VALUES,
  WORKER_DEFINITION_KIND_VALUES,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { AUDIT_RESOURCE_TYPES, PLATFORM_AUDIT_RESOURCE_TYPES } from './audit.js';
import type { Translate } from './i18n.js';
import {
  ACTIVITY_KIND_LABELS,
  ACTIVITY_STATUS_LABELS,
  AUDIT_RESOURCE_TYPE_LABELS,
  CONFLICT_TYPE_LABELS,
  CONTAINER_STATE_LABELS,
  CONTAINER_STATE_VALUES,
  DECISION_STATUS_LABELS,
  EPISTEMIC_STATUS_LABELS,
  PLATFORM_AUDIT_RESOURCE_TYPE_LABELS,
  PRINCIPAL_KIND_LABELS,
  SOURCE_KIND_LABELS,
  SOURCE_VISIBILITY_LABELS,
  SOURCE_VISIBILITY_VALUES,
  TASK_FAILURE_REASON_LABELS,
  WORKER_DEFINITION_KIND_LABELS,
  activityKindLabel,
  activityStatusLabel,
  auditResourceTypeLabel,
  conflictTypeLabel,
  connectorModeLabel,
  containerStateLabel,
  decisionStatusLabel,
  epistemicStatusLabel,
  label,
  principalKindLabel,
  roleLabel,
  sourceKindLabel,
  sourceVisibilityLabel,
  taskFailureReasonText,
  workerDefinitionKindLabel,
} from './labels.js';

/** Fixed zh/en pickers — every helper here is a pure function (not a component) that takes `t`
 *  from its caller, so tests supply their own rather than rendering under a `LangProvider`. */
const zhT: Translate = (zh) => zh;
const enT: Translate = (_zh, en) => en;

describe('lib/labels', () => {
  it('inherited names (__proto__, constructor) fall back to the raw text, never a prototype member', () => {
    expect(auditResourceTypeLabel('__proto__', zhT)).toBe('__proto__');
    expect(auditResourceTypeLabel('constructor', zhT)).toBe('constructor');
    expect(workerDefinitionKindLabel('constructor' as never, zhT)).toBe('constructor');
  });

  it('legacy 324: every Task failure reason the kernel writes reads as a label and a sentence; an unknown one never shows its raw value', () => {
    for (const reason of TASK_FAILURE_REASON_VALUES) {
      const zh = taskFailureReasonText(reason, zhT);
      expect(zh.short).toBe(TASK_FAILURE_REASON_LABELS[reason].short.zh);
      expect(zh.detail.length).toBeGreaterThan(0);
      expect(zh.short).not.toContain(reason);
      expect(taskFailureReasonText(reason, enT).short).toBe(
        TASK_FAILURE_REASON_LABELS[reason].short.en,
      );
    }
    for (const unknown of ['r54_test_terminal', '__proto__', 'constructor']) {
      const text = taskFailureReasonText(unknown, zhT);
      expect(text.short).toBe('其他原因');
      expect(text.detail).not.toContain(unknown);
    }
  });

  it('label() picks the active language', () => {
    const entry = { zh: '中文', en: 'English' };
    expect(label(entry, zhT)).toBe('中文');
    expect(label(entry, enT)).toBe('English');
  });

  it('every PrincipalKind has a bilingual label (exhaustive — a new kind fails tsc first)', () => {
    for (const kind of PRINCIPAL_KIND_VALUES) {
      expect(PRINCIPAL_KIND_LABELS[kind].zh.length).toBeGreaterThan(0);
      expect(PRINCIPAL_KIND_LABELS[kind].en.length).toBeGreaterThan(0);
      expect(principalKindLabel(kind, zhT)).toBe(PRINCIPAL_KIND_LABELS[kind].zh);
      expect(principalKindLabel(kind, enT)).toBe(PRINCIPAL_KIND_LABELS[kind].en);
    }
  });

  it('every WorkerDefinitionKind has a bilingual label, including the audit S14 "entry" example', () => {
    for (const kind of WORKER_DEFINITION_KIND_VALUES) {
      expect(WORKER_DEFINITION_KIND_LABELS[kind].zh.length).toBeGreaterThan(0);
      expect(WORKER_DEFINITION_KIND_LABELS[kind].en.length).toBeGreaterThan(0);
      // The raw wire value itself must never be the rendered label (the audit's own complaint).
      expect(workerDefinitionKindLabel(kind, zhT)).not.toBe(kind);
    }
    expect(workerDefinitionKindLabel('entry', zhT)).toBe('入口定义');
    expect(workerDefinitionKindLabel('worker', enT)).toBe('Worker');
  });

  it('every AuditResourceType the audit page offers has a bilingual label', () => {
    for (const type of AUDIT_RESOURCE_TYPES) {
      expect(AUDIT_RESOURCE_TYPE_LABELS[type].zh.length).toBeGreaterThan(0);
      expect(AUDIT_RESOURCE_TYPE_LABELS[type].en.length).toBeGreaterThan(0);
    }
    // The two literal examples the copy-guard baseline recorded for the audit surface.
    expect(auditResourceTypeLabel('agent_profile', zhT)).not.toBe('agent_profile');
    expect(auditResourceTypeLabel('worker_run', zhT)).not.toBe('worker_run');
  });

  it('legacy sweep: every platform-only audit resource type has a label, and the workspace list now has gate_instance / module', () => {
    for (const type of PLATFORM_AUDIT_RESOURCE_TYPES) {
      const entry = PLATFORM_AUDIT_RESOURCE_TYPE_LABELS[type];
      expect(auditResourceTypeLabel(type, zhT)).toBe(entry.zh);
      expect(auditResourceTypeLabel(type, enT)).toBe(entry.en);
      expect(auditResourceTypeLabel(type, zhT)).not.toBe(type);
      // A platform-only type is not also a workspace one (the workspace `<select>` would offer it).
      expect((AUDIT_RESOURCE_TYPES as readonly string[]).includes(type)).toBe(false);
    }
    expect(auditResourceTypeLabel('llm_provider', zhT)).toBe('模型服务商');
    expect(AUDIT_RESOURCE_TYPES).toContain('gate_instance');
    expect(AUDIT_RESOURCE_TYPES).toContain('module');
    expect(auditResourceTypeLabel('gate_instance', zhT)).toBe('门实例');
    expect(auditResourceTypeLabel('module', zhT)).toBe('模块');
    // No two workspace types read the same in the `<select>`.
    const zh = AUDIT_RESOURCE_TYPES.map((type) => AUDIT_RESOURCE_TYPE_LABELS[type].zh);
    expect(new Set(zh).size).toBe(zh.length);
  });

  it('auditResourceTypeLabel falls back to the raw value for an unrecognized type (visible, not hidden)', () => {
    expect(auditResourceTypeLabel('made_up_type', zhT)).toBe('made_up_type');
  });

  it('roleLabel resolves every workspace Role and falls back visibly for an unknown one', () => {
    expect(roleLabel('owner', zhT)).toBe('所有者');
    expect(roleLabel('owner', enT)).toBe('Owner');
    expect(roleLabel('operator', zhT)).toBe('操作员');
    expect(roleLabel('member', zhT)).toBe('成员');
    expect(roleLabel('auditor', zhT)).toBe('审计员');
    expect(roleLabel('builder', zhT)).toBe('构建者');
    expect(roleLabel('made_up_role', zhT)).toBe('made_up_role');
  });

  it('connectorModeLabel resolves the three-state connector mode, including the audit S14 raw-enum examples', () => {
    expect(connectorModeLabel('platform_preset', zhT)).toBe('平台预置');
    expect(connectorModeLabel('self_serve', zhT)).toBe('自助');
    expect(connectorModeLabel('disabled', zhT)).toBe('已禁用');
    expect(connectorModeLabel('platform_preset', zhT)).not.toBe('platform_preset');
    expect(connectorModeLabel('self_serve', zhT)).not.toBe('self_serve');
  });

  // Legacy sweep (console batch, 2026-10-16): each new map covers its enum and never shows raw.
  it('every EpistemicStatus, ConflictType and DecisionStatus reads as a label, never the raw value', () => {
    for (const status of EPISTEMIC_STATUS_VALUES) {
      expect(epistemicStatusLabel(status, zhT)).toBe(EPISTEMIC_STATUS_LABELS[status].zh);
      expect(epistemicStatusLabel(status, enT)).toBe(EPISTEMIC_STATUS_LABELS[status].en);
      expect(epistemicStatusLabel(status, zhT)).not.toBe(status);
    }
    for (const type of CONFLICT_TYPE_VALUES) {
      expect(conflictTypeLabel(type, zhT)).toBe(CONFLICT_TYPE_LABELS[type].zh);
      expect(conflictTypeLabel(type, zhT)).not.toBe(type);
    }
    for (const status of DECISION_STATUS_VALUES) {
      expect(decisionStatusLabel(status, zhT)).toBe(DECISION_STATUS_LABELS[status].zh);
      expect(decisionStatusLabel(status, zhT)).not.toBe(status);
    }
    expect(epistemicStatusLabel('contradicted', zhT)).toBe('被反驳');
    expect(conflictTypeLabel('temporal', zhT)).toBe('时间冲突');
    expect(decisionStatusLabel('superseded', zhT)).toBe('已被取代');
    expect(epistemicStatusLabel('made_up', zhT)).toBe('made_up');
    expect(decisionStatusLabel('__proto__', zhT)).toBe('__proto__');
  });

  it('every Activity status (the Turn status set) and the known Activity / Source kinds read as labels', () => {
    for (const status of TURN_STATUS_VALUES) {
      expect(activityStatusLabel(status, zhT)).toBe(ACTIVITY_STATUS_LABELS[status].zh);
      expect(activityStatusLabel(status, zhT)).not.toBe(status);
    }
    for (const [kind, entry] of Object.entries(ACTIVITY_KIND_LABELS)) {
      expect(activityKindLabel(kind, zhT)).toBe(entry.zh);
      expect(activityKindLabel(kind, zhT)).not.toBe(kind);
    }
    for (const [kind, entry] of Object.entries(SOURCE_KIND_LABELS)) {
      expect(sourceKindLabel(kind, zhT)).toBe(entry.zh);
    }
    for (const visibility of SOURCE_VISIBILITY_VALUES) {
      expect(sourceVisibilityLabel(visibility, zhT)).toBe(SOURCE_VISIBILITY_LABELS[visibility].zh);
      expect(sourceVisibilityLabel(visibility, zhT)).not.toBe(visibility);
    }
    expect(activityKindLabel('agent_turn', zhT)).toBe('入口 agent 回合');
    expect(activityKindLabel('governance.approval_decision', zhT)).toBe('审批决定');
    // A kind this table does not know keeps its raw name.
    expect(activityKindLabel('test.ingest', zhT)).toBe('test.ingest');
    expect(sourceKindLabel('ragflow', zhT)).toBe('ragflow');
    expect(sourceVisibilityLabel('private', zhT)).toBe('仅自己');
  });

  it('every Docker container state reads as a label; an unknown one stays visible', () => {
    for (const state of CONTAINER_STATE_VALUES) {
      expect(containerStateLabel(state, zhT)).toBe(CONTAINER_STATE_LABELS[state].zh);
      expect(containerStateLabel(state, zhT)).not.toBe(state);
    }
    expect(containerStateLabel('exited', zhT)).toBe('已退出');
    expect(containerStateLabel('exited', enT)).toBe('Exited');
    expect(containerStateLabel('weird', zhT)).toBe('weird');
  });
});
