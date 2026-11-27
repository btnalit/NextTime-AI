import { describe, expect, it } from 'vitest';
import type { ScrubRawSecretsResult } from '../application/platform/index.js';
import {
  ScrubRawSecretsUsageError,
  formatCountedRow,
  formatLiveApiKeyRow,
  formatScrubReport,
  formatTailUnprovenRow,
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

/** A key still issued to a service Principal, by ids only. */
const SERVICE_KEY_ROW = {
  principalWorkspaceId: 'ws-1',
  principalId: 'service-1',
  principalKind: 'service',
  userId: null,
} as const;

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
      selfConnectionAddresses: counts(0),
      gatekeeperNames: counts(1, 1),
      connectedSystems: counts(2, 3),
      connectionActivities: counts(1, 1),
      taskInputs: { ...counts(1), examples: [{ workspaceId: 'ws-1', id: 'task-1' }] },
      connectionTargets: counts(0),
      gatekeeperAddresses: counts(0),
      gateInstanceAddresses: { ...counts(1), examples: [{ workspaceId: null, id: 'billing-api' }] },
      factProperties: { ...counts(1), examples: [{ workspaceId: 'ws-1', id: 'fact-1' }] },
      objectProperties: counts(0),
      auditResults: { ...counts(2), examples: [{ workspaceId: null, id: 'audit-1' }] },
      auditPayloads: { ...counts(1), examples: [{ workspaceId: 'ws-1', id: 'audit-2' }] },
      gateCallObservations: {
        ...counts(1),
        examples: [{ workspaceId: 'ws-1', id: 'observation-1' }],
      },
      turnReportKeyShapes: { ...counts(1), examples: [{ workspaceId: 'ws-1', id: 'turn-1' }] },
      decisionKeyShapes: counts(0),
      toolCallRecordKeyShapes: counts(0),
      connectedSystemDuplicates: {
        ...counts(1),
        examples: [{ workspaceId: 'ws-1', id: 'system-2' }],
      },
    },
    tailUnproven: {
      turnReports: { rows: 3, examples: [{ workspaceId: 'ws-1', id: 'turn-2' }] },
      decisions: { rows: 0, examples: [] },
      toolCallRecords: { rows: 0, examples: [] },
      taskInputs: { rows: 0, examples: [] },
      factProperties: { rows: 0, examples: [] },
      objectProperties: { rows: 0, examples: [] },
      auditResults: { rows: 0, examples: [] },
      auditPayloads: { rows: 1, examples: [{ workspaceId: null, id: 'audit-3' }] },
    },
    liveApiKeys: {
      tables: 80,
      rows: 900,
      found: 3,
      keys: 2,
      examples: [
        { ...SERVICE_KEY_ROW, table: 'audit_records', row: ['audit-2'] },
        { ...SERVICE_KEY_ROW, table: 'activities', row: ['ws-1', 'turn-1'] },
      ],
    },
    auditRecordId: executed ? 'audit-row' : null,
  });

  it('ends a dry run with the one-line summary apply-release echoes, naming rows by id only', () => {
    const lines = formatScrubReport(result(false), undefined);
    expect(lines.at(-1)).toBe(
      'scrub-raw-secrets: dry-run would-rewrite=10 counted: taskInputs=1 connectionTargets=0 gatekeeperAddresses=0 gateInstanceAddresses=1 factProperties=1 objectProperties=0 auditResults=2 auditPayloads=1 gateCallObservations=1 turnReportKeyShapes=1 decisionKeyShapes=0 toolCallRecordKeyShapes=0 connectedSystemDuplicates=1 tailUnproven=4 liveApiKeys=2 batches=7',
    );
    // «收尾未证明» apart, each category with its own ids: a row to look at, not a secret count.
    expect(lines).toContain(
      'turnReports tail unproven (a row to look at, not a secret count; not rewritten): rows=3 ids=ws-1/turn-2,… (all 3: the "tail-unproven turnReports" lines)',
    );
    expect(lines).toContain(
      'auditPayloads tail unproven (a row to look at, not a secret count; not rewritten): rows=1 ids=audit-3',
    );
    expect(lines).toContain(
      'decisions tail unproven (a row to look at, not a secret count; not rewritten): rows=0',
    );
    expect(lines).toContain('connectedSystems: examined=10 would-rewrite=2 values=3');
    expect(lines).toContain(
      'connectedSystemDuplicates (listed, nothing to fix): examined=10 duplicates=1 ids=ws-1/system-2',
    );
    expect(lines).toContain(
      'toolCallRecords: examined=10 would-rewrite=3 values=5 skipped-changed-meanwhile=1',
    );
    expect(lines).toContain(
      'taskInputs (counted, not rewritten): examined=10 carrying=1 ids=ws-1/task-1',
    );
    expect(lines).toContain('connectionActivities: examined=10 would-rewrite=1 values=1');
    expect(lines).toContain(
      'gateInstanceAddresses (counted, not rewritten): examined=10 carrying=1 ids=billing-api',
    );
    expect(lines).toContain(
      'factProperties (counted, not rewritten): examined=10 carrying=1 ids=ws-1/fact-1',
    );
    expect(lines).toContain(
      'auditResults (counted, not rewritten): examined=10 carrying=2 ids=audit-1,… (all 2: the "counted auditResults" lines)',
    );
    expect(lines).toContain(
      'gateCallObservations (counted, not rewritten): examined=10 carrying=1 ids=ws-1/observation-1',
    );
    expect(lines).toContain(
      'turnReportKeyShapes (counted, not rewritten): examined=10 carrying=1 ids=ws-1/turn-1',
    );
    expect(lines).toContain(
      'auditPayloads (counted, not rewritten): examined=10 carrying=1 ids=ws-1/audit-2',
    );
    // The Principals whose keys are still issued, each once; the rest are on the per-row lines.
    expect(lines).toContain(
      'liveApiKeys (still issued, rotate each): tables=80 rows=900 keys=2 found=3 principals=ws-1/service-1,… (all 3: the "live-api-key" lines)',
    );
    expect(lines.some((line) => line.startsWith('audit:'))).toBe(false);
  });

  it('with no key still issued, says so and lists nobody', () => {
    const lines = formatScrubReport(
      {
        ...result(false),
        liveApiKeys: { tables: 80, rows: 900, found: 0, keys: 0, examples: [] },
      },
      undefined,
    );
    expect(lines).toContain(
      'liveApiKeys (still issued, rotate each): tables=80 rows=900 keys=0 found=0',
    );
    expect(lines.at(-1)).toMatch(/ liveApiKeys=0 batches=7$/);
  });

  it('prints each row holding a key still issued by ids: the table and row, the Principal, the user', () => {
    expect(
      formatLiveApiKeyRow({ ...SERVICE_KEY_ROW, table: 'audit_records', row: ['audit-3'] }),
    ).toBe('live-api-key audit_records audit-3 principal ws-1/service-1 service');
    expect(
      formatLiveApiKeyRow({
        table: 'chat_messages',
        row: ['ws-2', 'message-1'],
        principalWorkspaceId: 'ws-2',
        principalId: 'member-1',
        principalKind: 'human',
        userId: 'user-1',
      }),
    ).toBe('live-api-key chat_messages ws-2/message-1 principal ws-2/member-1 human user user-1');
  });

  it('prints each counted row by id, one line per row', () => {
    expect(formatCountedRow('taskInputs', { workspaceId: 'ws-1', id: 'task-1' })).toBe(
      'counted taskInputs ws-1/task-1',
    );
    expect(formatTailUnprovenRow('decisions', { workspaceId: 'ws-1', id: 'decision-1' })).toBe(
      'tail-unproven decisions ws-1/decision-1',
    );
    expect(formatTailUnprovenRow('auditPayloads', { workspaceId: null, id: 'audit-3' })).toBe(
      'tail-unproven auditPayloads audit-3',
    );
    expect(
      formatCountedRow('gateInstanceAddresses', { workspaceId: null, id: 'billing-api' }),
    ).toBe('counted gateInstanceAddresses billing-api');
  });

  it('an executing run names its audit row and who it is attributed to', () => {
    const lines = formatScrubReport(result(true), { login: 'ops' });
    expect(lines).toContain('audit: cli.raw_secrets_scrubbed audit-row (actor ops)');
    expect(lines.at(-1)).toMatch(/^scrub-raw-secrets: ok rewritten=10 /);
  });
});
