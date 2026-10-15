import { CAPABILITY_REGISTRY } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { AUDIT_LIFECYCLE_ACTIONS } from './audit.js';
import { ACTION_COPY, actionHint, actionLabel } from './capability-labels.js';
import type { Translate } from './i18n.js';

/** Fixed zh/en pickers — the helpers take `t` from their caller, so tests supply their own. */
const zhT: Translate = (zh) => zh;
const enT: Translate = (_zh, en) => en;

const CJK_RE = /[㐀-鿿]/;
const CAPABILITY_NAMES = CAPABILITY_REGISTRY.map((capability) => capability.name);

/** The non-capability audit actions the kernel writes (handlers, CLI and migrations) — every one
 *  must have copy, the same as the registry and the lifecycle list. */
const OTHER_AUDIT_ACTIONS = [
  'operation.description_updated',
  'operation.governance_refreshed',
  'draft.expired',
  'agent_profile.lists_reset_to_follow_grants',
  'policy.auto_approve_rescoped',
  'agent_policy.auto_approve_low_default_applied',
  'principal.auditor_handles_revoked',
  'principal.container_handles_revoked',
  'workspace.created',
  'user.identity_claimed',
  'principal.user_rebound',
  'connector.entry_handles_revoked',
  'gate_instance.manifest_confirmed',
  'platform.llm_admin_token_issued',
  'platform.llm_provider_created',
  'platform.llm_provider_updated',
  'platform.llm_provider_deleted',
  'platform.llm_provider_tested',
  'platform.llm_provider_secret_set',
  'platform.llm_provider_secret_cleared',
  'platform.llm_provider_models_listed',
  'platform.llm_provider_models_probed',
  'platform.user_purged',
  'platform.workspace_purged',
  'cli.observations_compacted',
  'cli.workspace_created',
  'cli.principal_added',
  'cli.service_handle_issued',
  'cli.platform_admin_created',
  'cli.password_set',
] as const;

describe('lib/capability-labels', () => {
  it('has copy for every registry capability', () => {
    const missing = CAPABILITY_NAMES.filter((name) => !Object.hasOwn(ACTION_COPY, name));
    expect(missing).toEqual([]);
  });

  it('has copy for every lifecycle audit action', () => {
    const missing = AUDIT_LIFECYCLE_ACTIONS.filter((action) => !Object.hasOwn(ACTION_COPY, action));
    expect(missing).toEqual([]);
  });

  it('has copy for the other audit actions the kernel writes', () => {
    const missing = OTHER_AUDIT_ACTIONS.filter((action) => !Object.hasOwn(ACTION_COPY, action));
    expect(missing).toEqual([]);
  });

  it('every zh label is short, Chinese and free of raw identifiers', () => {
    for (const [name, copy] of Object.entries(ACTION_COPY)) {
      expect(copy.zh, name).not.toContain('_');
      expect(copy.zh.length, name).toBeLessThanOrEqual(12);
      expect(CJK_RE.test(copy.zh), name).toBe(true);
      expect(CJK_RE.test(copy.zhHint), name).toBe(true);
      expect(copy.zhHint, name).not.toContain('_');
    }
  });

  it('every entry has an English label and hint', () => {
    for (const [name, copy] of Object.entries(ACTION_COPY)) {
      expect(copy.en.trim(), name).not.toBe('');
      expect(copy.en, name).not.toContain('_');
      expect(CJK_RE.test(copy.en), name).toBe(false);
      expect(copy.enHint.trim(), name).not.toBe('');
      expect(CJK_RE.test(copy.enHint), name).toBe(false);
    }
  });

  it('no two capabilities share a zh label', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const name of CAPABILITY_NAMES) {
      const zh = ACTION_COPY[name]?.zh;
      if (zh === undefined) continue;
      const other = seen.get(zh);
      if (other !== undefined) clashes.push(`${other} / ${name}: ${zh}`);
      seen.set(zh, name);
    }
    expect(clashes).toEqual([]);
  });

  it('no two entries at all share a zh or an en label', () => {
    const zh = Object.values(ACTION_COPY).map((copy) => copy.zh);
    const en = Object.values(ACTION_COPY).map((copy) => copy.en);
    expect(new Set(zh).size).toBe(zh.length);
    expect(new Set(en).size).toBe(en.length);
  });

  it('actionLabel picks the active language', () => {
    expect(actionLabel('list_platform_models', zhT)).toBe('列出平台模型');
    expect(actionLabel('list_platform_models', enT)).toBe('List platform models');
    expect(actionLabel('action_request.approve', zhT)).toBe('动作请求已批准');
  });

  it('actionLabel falls back to the raw name for an unknown action', () => {
    expect(actionLabel('no_such_capability', zhT)).toBe('no_such_capability');
    expect(actionLabel('no_such_capability', enT)).toBe('no_such_capability');
    expect(actionLabel('__proto__', zhT)).toBe('__proto__');
    expect(actionLabel('constructor', zhT)).toBe('constructor');
  });

  it('actionHint returns the description, or null for an unknown action', () => {
    expect(actionHint('approve', zhT)).toBe(ACTION_COPY.approve?.zhHint);
    expect(actionHint('approve', enT)).toBe(ACTION_COPY.approve?.enHint);
    expect(actionHint('no_such_capability', zhT)).toBeNull();
    expect(actionHint('toString', zhT)).toBeNull();
  });
});
