import { PurgeUserSkipReasonWireSchema, PurgeWorkspaceReasonWireSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  PURGE_USER_SKIP_REASON_LABELS,
  PURGE_WORKSPACE_REASON_LABELS,
  WORKSPACE_PURGE_RETENTION_DAYS,
  deriveWorkspaceOptions,
  isExpiredEphemeral,
  isResidueWorkspace,
  purgeCountLabel,
  purgeRetention,
  readResiduePreset,
  residueWorkspacesHref,
} from './platform-workspaces.js';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('platform-workspaces', () => {
  it('deriveWorkspaceOptions unions memberships and adds the default workspace', () => {
    const options = deriveWorkspaceOptions(
      [
        {
          id: 'u-1',
          login: 'a',
          displayName: 'A',
          platformRole: 'user',
          status: 'active',
          hasPassword: true,
          mustChangePassword: false,
          dailyCallLimit: null,
          monthlyTokenBudget: null,
          lastLoginAt: null,
          createdAt: '2026-09-01T00:00:00.000Z',
          memberships: [
            {
              workspaceId: 'ws-2',
              workspaceName: 'Beta',
              workspaceStatus: 'active',
              principalId: 'p-1',
              role: 'member',
              disabled: false,
            },
          ],
        },
      ],
      'ws-1',
    );
    expect(options).toEqual([
      { id: 'ws-2', name: 'Beta' },
      { id: 'ws-1', name: 'ws-1' },
    ]);
  });

  it('purgeRetention: null disabledAt (pre-0030) and an elapsed clock are purgeable now', () => {
    expect(purgeRetention(null, NOW)).toEqual({ purgeableAt: null, daysRemaining: 0 });
    expect(purgeRetention(new Date(NOW - 8 * DAY).toISOString(), NOW)).toEqual({
      purgeableAt: null,
      daysRemaining: 0,
    });
    expect(purgeRetention(new Date(NOW - 7 * DAY).toISOString(), NOW).daysRemaining).toBe(0);
    expect(purgeRetention('not a date', NOW)).toEqual({ purgeableAt: null, daysRemaining: 0 });
  });

  it('purgeRetention: a fresh disable counts the days up to the 7-day mark', () => {
    const disabledAt = new Date(NOW - 2.5 * DAY).toISOString();
    const retention = purgeRetention(disabledAt, NOW);
    expect(retention.purgeableAt).toBe(NOW - 2.5 * DAY + WORKSPACE_PURGE_RETENTION_DAYS * DAY);
    // 4.5 days left → rounded up to 5.
    expect(retention.daysRemaining).toBe(5);
    expect(purgeRetention(new Date(NOW).toISOString(), NOW).daysRemaining).toBe(7);
  });

  it('isExpiredEphemeral / isResidueWorkspace', () => {
    const active = { status: 'active', purpose: 'standard', expiresAt: null } as const;
    const disabled = { ...active, status: 'disabled' } as const;
    const liveEphemeral = {
      status: 'active',
      purpose: 'ephemeral',
      expiresAt: new Date(NOW + DAY).toISOString(),
    } as const;
    const expiredEphemeral = { ...liveEphemeral, expiresAt: new Date(NOW - DAY).toISOString() };

    expect(isExpiredEphemeral(active, NOW)).toBe(false);
    expect(isExpiredEphemeral(liveEphemeral, NOW)).toBe(false);
    expect(isExpiredEphemeral(expiredEphemeral, NOW)).toBe(true);
    // A standard workspace never "expires", whatever a stray expiresAt says.
    expect(
      isExpiredEphemeral({ ...active, expiresAt: new Date(NOW - DAY).toISOString() }, NOW),
    ).toBe(false);

    expect(isResidueWorkspace(active, NOW)).toBe(false);
    expect(isResidueWorkspace(liveEphemeral, NOW)).toBe(false);
    expect(isResidueWorkspace(disabled, NOW)).toBe(true);
    expect(isResidueWorkspace(expiredEphemeral, NOW)).toBe(true);
  });

  it('the residue preset round-trips through the hash query', () => {
    expect(residueWorkspacesHref()).toBe('#/platform/workspaces?residue=1');
    expect(readResiduePreset(residueWorkspacesHref())).toBe(true);
    expect(readResiduePreset('#/platform/workspaces')).toBe(false);
    expect(readResiduePreset('#/platform/workspaces?residue=0')).toBe(false);
    expect(readResiduePreset('#/platform/workspaces?other=1&residue=1')).toBe(true);
    expect(readResiduePreset('')).toBe(false);
  });

  it('purgeCountLabel knows the cascade tables and humanizes anything else', () => {
    expect(purgeCountLabel('capabilityHandles')).toBe('Handle');
    expect(purgeCountLabel('auditRecords')).toContain('Audit records');
    expect(purgeCountLabel('ontologyVersions')).toBe('Ontology versions');
    expect(purgeCountLabel('')).toBe('');
  });

  it('every wire reason has bilingual copy', () => {
    for (const reason of PurgeWorkspaceReasonWireSchema.options) {
      expect(PURGE_WORKSPACE_REASON_LABELS[reason].length).toBeGreaterThan(0);
    }
    for (const reason of PurgeUserSkipReasonWireSchema.options) {
      expect(PURGE_USER_SKIP_REASON_LABELS[reason].length).toBeGreaterThan(0);
    }
  });
});
