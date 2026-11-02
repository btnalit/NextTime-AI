import { describe, expect, it } from 'vitest';
import {
  ADMIN_AGENT_REFUSAL_REASONS,
  type AdminAgentAuthorityFacts,
  adminAgentEnabled,
  adminAgentRefusalOf,
} from './identity.js';

/**
 * `ADMIN_AGENT_ENABLED` (S11 AA1, plan §5.7 "停止开关放在环境变量"): the kernel reads it once at
 * start (index.ts), so a value that is neither on nor off must stop it there rather than leave the
 * admin agent silently off — or on.
 */
describe('adminAgentEnabled', () => {
  it('is off when unset or empty', () => {
    expect(adminAgentEnabled(undefined)).toBe(false);
    expect(adminAgentEnabled('')).toBe(false);
    expect(adminAgentEnabled('   ')).toBe(false);
  });

  it('reads 1/true as on and 0/false as off, in any case and with surrounding blanks', () => {
    for (const raw of ['1', 'true', 'TRUE', ' True '])
      expect(adminAgentEnabled(raw), raw).toBe(true);
    for (const raw of ['0', 'false', 'FALSE', ' False ']) {
      expect(adminAgentEnabled(raw), raw).toBe(false);
    }
  });

  it('throws on anything else, naming the variable', () => {
    for (const raw of ['yes', 'on', 'off', '2', 'enabled', 'tru e']) {
      expect(() => adminAgentEnabled(raw), raw).toThrow(/ADMIN_AGENT_ENABLED/);
    }
  });
});

/**
 * `adminAgentRefusalOf` (I-A3, I-A6): the first reason in list order, on facts already read. S11
 * AA3a puts `not_trial_workspace` after the workspace's own state and before the user's platform
 * role — a disabled workspace says so first, and a trial workspace still needs an administrator.
 */
describe('adminAgentRefusalOf', () => {
  const allowed: AdminAgentAuthorityFacts = {
    principalKind: 'human',
    principalRole: 'owner',
    principalDisabled: false,
    workspaceStatus: 'active',
    workspacePurpose: 'admin_trial',
    userId: 'user-1',
    login: 'aa3a-unit-admin',
    platformRole: 'admin',
    userStatus: 'active',
  };

  it('admits an enabled administrator in an active trial workspace', () => {
    expect(adminAgentRefusalOf(allowed, true)).toBeNull();
  });

  it('refuses every workspace that is not a trial workspace (I-A6, legacy 585)', () => {
    for (const workspacePurpose of ['standard', 'ephemeral']) {
      expect(adminAgentRefusalOf({ ...allowed, workspacePurpose }, true), workspacePurpose).toBe(
        'not_trial_workspace',
      );
    }
  });

  it('orders not_trial_workspace after workspace_disabled and before not_platform_admin', () => {
    const order = ADMIN_AGENT_REFUSAL_REASONS as readonly string[];
    expect(order.indexOf('workspace_disabled')).toBeLessThan(order.indexOf('not_trial_workspace'));
    expect(order.indexOf('not_trial_workspace')).toBeLessThan(order.indexOf('not_platform_admin'));

    expect(
      adminAgentRefusalOf(
        { ...allowed, workspaceStatus: 'disabled', workspacePurpose: 'standard' },
        true,
      ),
    ).toBe('workspace_disabled');
    expect(
      adminAgentRefusalOf({ ...allowed, workspacePurpose: 'standard', platformRole: 'user' }, true),
    ).toBe('not_trial_workspace');
    expect(adminAgentRefusalOf({ ...allowed, platformRole: 'user' }, true)).toBe(
      'not_platform_admin',
    );
  });
});
