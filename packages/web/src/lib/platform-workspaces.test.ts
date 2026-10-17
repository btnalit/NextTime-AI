import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PurgeUserSkipReasonWireSchema, PurgeWorkspaceReasonWireSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  WORKSPACE_PURGE_RETENTION_DAYS,
  isExpiredEphemeral,
  isLabelledPurgeCountKey,
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
    expect(purgeCountLabel('goalRuns', zhT)).toBe('目标运行');
    expect(purgeCountLabel('planRevisions', zhT)).toBe('计划版本');
    expect(purgeCountLabel('stepRuns', zhT)).toBe('步骤运行');
    expect(purgeCountLabel('stepRuns', enT)).toBe('Step runs');
    expect(purgeCountLabel('actionRequestReconcileChecks', zhT)).toBe('平台核对记录');
    expect(purgeCountLabel('brandNewTable', zhT)).toBe('Brand new table');
    expect(purgeCountLabel('', zhT)).toBe('');
  });

  // Legacy 337 (UX acceptance of #607): these three read as their English fallback in Chinese.
  it.each([
    ['agentPolicies', '工作区策略', 'Agent policies'],
    ['ontologyVersions', '本体版本', 'Ontology versions'],
    ['workerDefinitions', 'Worker 定义', 'Worker definitions'],
  ])('purgeCountLabel names %s in Chinese, not by its English fallback', (key, zh, fallback) => {
    expect(purgeCountLabel(key, zhT)).toBe(zh);
    expect(purgeCountLabel(key, zhT)).not.toBe(fallback);
  });

  // Legacy 337: the wire types `counts` as a string record, so this is what holds the label map
  // to the schema — every table the kernel's purge discovers (a `workspace_id` column,
  // `discoverWorkspaceScopedSchema`), read from the migrations that create it.
  it('every workspace-scoped table in the kernel migrations has a purge count label', () => {
    const tables = workspaceScopedTables();
    // The parser reads what the purge preview shows today, S11 GO1's tables included.
    expect(tables).toEqual(expect.arrayContaining(['goal_runs', 'plan_revisions', 'step_runs']));
    const unlabelled = tables
      .map((table) => table.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase()))
      .filter((key) => !isLabelledPurgeCountKey(key));
    expect(unlabelled).toEqual([]);
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

const MIGRATIONS = fileURLToPath(new URL('../../../kernel/migrations/', import.meta.url));

/** The tables the kernel's migrations leave with a `workspace_id` column: created with one, given
 *  one later, minus any dropped or renamed since. Read in path order — module directory, then
 *  version — the order the migrator runs them in (`adapters/db/migrate.ts`). */
function workspaceScopedTables(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.sql')) files.push(path);
    }
  };
  walk(MIGRATIONS);
  const tables = new Set<string>();
  for (const file of files.sort()) {
    const sql = readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
    for (const [, name, body] of sql.matchAll(
      /create table (?:if not exists )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi,
    )) {
      if (name && body && /(^|[\s,(])workspace_id\s/i.test(body)) tables.add(name);
    }
    for (const [, name] of sql.matchAll(
      /alter table (?:if exists )?(?:only )?(?:public\.)?(\w+)\s+add column (?:if not exists )?workspace_id\b/gi,
    )) {
      if (name) tables.add(name);
    }
    for (const [, name] of sql.matchAll(/drop table (?:if exists )?(?:public\.)?(\w+)/gi)) {
      if (name) tables.delete(name);
    }
    for (const [, from, to] of sql.matchAll(
      /alter table (?:if exists )?(?:public\.)?(\w+)\s+rename to (\w+)/gi,
    )) {
      if (from && to && tables.delete(from)) tables.add(to);
    }
  }
  return [...tables].sort();
}
