import { PurgeUserSkipReasonWireSchema, PurgeWorkspaceReasonWireSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  WORKSPACE_PURGE_RETENTION_DAYS,
  isExpiredEphemeral,
  isResidueWorkspace,
  purgeCountLabel,
  purgeRetention,
  purgeUserSkipReasonLabel,
  purgeWorkspaceReasonLabel,
  readResiduePreset,
  residueWorkspacesHref,
} from './platform-workspaces.js';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** These helpers are pure (not components) and take `t` from their caller — a fixed zh/en picker
 *  each, so a test can assert on either half without a `LangProvider`. */
const zhT: Translate = (zh) => zh;
const enT: Translate = (_zh, en) => en;

describe('platform-workspaces', () => {
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
    expect(purgeCountLabel('capabilityHandles', zhT)).toBe('Handle');
    expect(purgeCountLabel('auditRecords', enT)).toContain('Audit records');
    expect(purgeCountLabel('ontologyVersions', zhT)).toBe('Ontology versions');
    expect(purgeCountLabel('', zhT)).toBe('');
  });

  it('every wire reason has bilingual copy', () => {
    for (const reason of PurgeWorkspaceReasonWireSchema.options) {
      expect(purgeWorkspaceReasonLabel(reason, zhT).length).toBeGreaterThan(0);
      expect(purgeWorkspaceReasonLabel(reason, enT).length).toBeGreaterThan(0);
    }
    for (const reason of PurgeUserSkipReasonWireSchema.options) {
      expect(purgeUserSkipReasonLabel(reason, zhT).length).toBeGreaterThan(0);
      expect(purgeUserSkipReasonLabel(reason, enT).length).toBeGreaterThan(0);
    }
  });
});
