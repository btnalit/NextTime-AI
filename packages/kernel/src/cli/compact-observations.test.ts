import { describe, expect, it } from 'vitest';
import type { CompactObservationsResult } from '../application/platform/index.js';
import {
  CompactObservationsUsageError,
  formatCompactionReport,
  parseCompactObservationsArgs,
} from './compact-observations.js';

/**
 * cli/compact-observations.test: the operator CLI's argument guards and report format (no
 * database) — STATUS leftover 103. The deletion rule itself is covered against real Postgres in
 * application/platform/compact-observations.integration.test.ts.
 */

describe('parseCompactObservationsArgs', () => {
  it('defaults to a dry run with the 30-day gate and 10k windows', () => {
    expect(parseCompactObservationsArgs([])).toEqual({
      confirm: false,
      olderThanDays: 30,
      batchSize: 10_000,
    });
    expect(parseCompactObservationsArgs(['--dry-run']).confirm).toBe(false);
  });

  it('--yes executes; every flag takes `--flag value` and `--flag=value`', () => {
    const workspaceId = '11111111-2222-4333-8444-555555555555';
    expect(
      parseCompactObservationsArgs([
        '--yes',
        '--older-than-days',
        '45',
        '--batch-size=500',
        `--workspace=${workspaceId}`,
        '--actor',
        'ops',
      ]),
    ).toEqual({
      confirm: true,
      olderThanDays: 45,
      batchSize: 500,
      workspaceId,
      actorLogin: 'ops',
    });
  });

  it('refuses --yes with --dry-run, unknown arguments, missing values and non-positive numbers', () => {
    const refused = [
      ['--yes', '--dry-run'],
      ['--force'],
      ['--older-than-days'],
      ['--older-than-days', '--yes'],
      ['--older-than-days', '0'],
      ['--older-than-days', '-3'],
      ['--older-than-days', '7.5'],
      ['--batch-size', 'many'],
      ['--workspace', 'not-a-uuid'],
      ['stray'],
      ['yes'],
    ];
    for (const argv of refused) {
      expect(() => parseCompactObservationsArgs(argv)).toThrow(CompactObservationsUsageError);
    }
  });
});

describe('formatCompactionReport', () => {
  const counts = {
    examined: 10,
    keptPayload: 1,
    keptReferenced: 2,
    keptSourceNewest: 1,
    keptLastOfActivitySource: 2,
    deleted: 4,
  };
  const base: CompactObservationsResult = {
    executed: false,
    olderThanDays: 30,
    cutoff: '2026-09-04T00:00:00.000000Z',
    batchSize: 10_000,
    batches: 2,
    workspaces: [
      { workspaceId: 'w1', name: 'one', rowsBefore: 25, ...counts },
      {
        workspaceId: 'w2',
        name: null,
        rowsBefore: 3,
        examined: 0,
        keptPayload: 0,
        keptReferenced: 0,
        keptSourceNewest: 0,
        keptLastOfActivitySource: 0,
        deleted: 0,
      },
    ],
    totals: { rowsBefore: 28, ...counts },
    auditRecordId: null,
  };

  it('a dry run reports per-category counts per workspace and ends with the one-line summary', () => {
    const lines = formatCompactionReport(base, undefined);
    expect(lines[0]).toContain('dry run — nothing deleted');
    expect(lines).toContain(
      'workspace w1 (one): rows=25 older=10 payload=1 referenced=2 source-newest=1 last-of-activity-source=2 would-delete=4',
    );
    expect(lines.at(-1)).toBe(
      'compact-observations: dry-run would-delete=4 of older=10 rows=28 workspaces=1 batches=2',
    );
    expect(lines.some((line) => line.startsWith('audit:'))).toBe(false);
  });

  it('an executing run names its audit row and whether it is attributed', () => {
    const executed = { ...base, executed: true, auditRecordId: 'a1' };
    const unattributed = formatCompactionReport(executed, undefined);
    expect(unattributed.at(-1)).toBe(
      'compact-observations: ok deleted=4 of older=10 rows=28 workspaces=1 batches=2',
    );
    expect(unattributed.find((line) => line.startsWith('audit:'))).toContain('unattributed');
    expect(
      formatCompactionReport(executed, { login: 'ops' }).find((line) => line.startsWith('audit:')),
    ).toBe('audit: cli.observations_compacted a1 (actor ops)');
  });
});
