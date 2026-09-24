import { PRINCIPAL_KIND_VALUES, WORKER_DEFINITION_KIND_VALUES } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { AUDIT_RESOURCE_TYPES } from './audit.js';
import type { Translate } from './i18n.js';
import {
  AUDIT_RESOURCE_TYPE_LABELS,
  PRINCIPAL_KIND_LABELS,
  WORKER_DEFINITION_KIND_LABELS,
  auditResourceTypeLabel,
  connectorModeLabel,
  label,
  principalKindLabel,
  roleLabel,
  workerDefinitionKindLabel,
} from './labels.js';

/** Fixed zh/en pickers — every helper here is a pure function (not a component) that takes `t`
 *  from its caller, so tests supply their own rather than rendering under a `LangProvider`. */
const zhT: Translate = (zh) => zh;
const enT: Translate = (_zh, en) => en;

describe('lib/labels', () => {
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
});
