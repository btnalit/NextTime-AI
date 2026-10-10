import { describe, expect, it } from 'vitest';
import type { ScrubRawSecretsResult } from '../application/platform/index.js';
import {
  ScrubRawSecretsUsageError,
  formatScrubReport,
  parseScrubRawSecretsArgs,
} from './scrub-raw-secrets.js';

/**
 * cli/scrub-raw-secrets.test: the operator CLI's argument guards and report format (no database) —
 * STATUS legacy 183–187. What it rewrites and counts is covered against real Postgres in
 * application/platform/scrub-raw-secrets.integration.test.ts.
 */

describe('parseScrubRawSecretsArgs', () => {
  it('defaults to a dry run in windows of 500', () => {
    expect(parseScrubRawSecretsArgs([])).toEqual({ confirm: false, batchSize: 500 });
    expect(parseScrubRawSecretsArgs(['--dry-run']).confirm).toBe(false);
  });

  it('--yes executes; flags take `--flag value` and `--flag=value`', () => {
    expect(parseScrubRawSecretsArgs(['--yes', '--batch-size', '50', '--actor=ops'])).toEqual({
      confirm: true,
      batchSize: 50,
      actorLogin: 'ops',
    });
  });

  it.each([
    [['--yes', '--dry-run'], 'exclusive'],
    [['--batch-size', '0'], 'positive integer'],
    [['--batch-size'], 'needs a value'],
    [['--workspace', 'x'], 'unknown argument'],
    [['yes'], 'unknown argument'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseScrubRawSecretsArgs(argv)).toThrow(ScrubRawSecretsUsageError);
    expect(() => parseScrubRawSecretsArgs(argv)).toThrow(message);
  });
});

describe('formatScrubReport', () => {
  const counts = (affected: number, values = 0, skipped = 0) => ({
    examined: 10,
    affected,
    skipped,
    values,
    examples: [] as { workspaceId: string | null; id: string }[],
  });
  const result = (executed: boolean): ScrubRawSecretsResult => ({
    executed,
    batchSize: 500,
    batches: 7,
    categories: {
      turnReports: counts(2, 3),
      decisions: counts(1, 1),
      toolCallRecords: counts(4, 5, 1),
      taskInputs: { ...counts(1), examples: [{ workspaceId: 'ws-1', id: 'task-1' }] },
      connectionTargets: counts(0),
      gatekeeperAddresses: counts(0),
      auditResults: { ...counts(2), examples: [{ workspaceId: null, id: 'audit-1' }] },
    },
    auditRecordId: executed ? 'audit-row' : null,
  });

  it('ends a dry run with the one-line summary apply-release echoes, naming rows by id only', () => {
    const lines = formatScrubReport(result(false), undefined);
    expect(lines.at(-1)).toBe(
      'scrub-raw-secrets: dry-run would-rewrite=6 counted: taskInputs=1 connectionTargets=0 gatekeeperAddresses=0 auditResults=2 batches=7',
    );
    expect(lines).toContain(
      'toolCallRecords: examined=10 would-rewrite=3 values=5 skipped-changed-meanwhile=1',
    );
    expect(lines).toContain(
      'taskInputs (counted, not rewritten): examined=10 carrying=1 ids=ws-1/task-1',
    );
    expect(lines).toContain(
      'auditResults (counted, not rewritten): examined=10 carrying=2 ids=audit-1,…',
    );
    expect(lines.some((line) => line.startsWith('audit:'))).toBe(false);
  });

  it('an executing run names its audit row and who it is attributed to', () => {
    const lines = formatScrubReport(result(true), { login: 'ops' });
    expect(lines).toContain('audit: cli.raw_secrets_scrubbed audit-row (actor ops)');
    expect(lines.at(-1)).toMatch(/^scrub-raw-secrets: ok rewritten=6 /);
  });
});
