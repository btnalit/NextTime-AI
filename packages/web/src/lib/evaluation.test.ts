import type { EvalSuiteWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  liveStateNotice,
  operationDiffParts,
  suiteChangeText,
  suiteSummaryOf,
  syncPreview,
  workerChoices,
} from './evaluation.js';
import type { Translate } from './i18n.js';
import type { WorkerDefinitionSummary } from './tasks.js';

const zh: Translate = (zhText) => zhText;
const en: Translate = (_zh, enText) => enText;

function definition(
  id: string,
  version: number,
  name: string,
  extra: Partial<WorkerDefinitionSummary> = {},
): WorkerDefinitionSummary {
  return { id, version, kind: 'worker', status: 'published', definition: { name }, ...extra };
}

describe('lib/evaluation (S10 E3-1a)', () => {
  it('workerChoices: one choice per published worker definition, versions newest first, by name', () => {
    const choices = workerChoices([
      definition('wd-b', 1, 'restarter'),
      definition('wd-a', 1, 'auditor-bot'),
      definition('wd-b', 3, 'restarter'),
      definition('wd-b', 2, 'restarter'),
      definition('wd-entry', 1, 'entry', { kind: 'entry' }),
      definition('wd-draft', 1, 'drafty', { status: 'draft' }),
    ]);
    expect(choices).toEqual([
      { id: 'wd-a', name: 'auditor-bot', versions: [1] },
      { id: 'wd-b', name: 'restarter', versions: [3, 2, 1] },
    ]);
  });

  it('workerChoices tells two same-named definitions apart by their short id', () => {
    const choices = workerChoices([
      definition('11111111-aaaa-4000-8000-000000000001', 1, 'ops-runner'),
      definition('22222222-bbbb-4000-8000-000000000002', 1, 'ops-runner'),
    ]);
    expect(choices).toHaveLength(2);
    expect(choices[0]?.name).not.toBe(choices[1]?.name);
    for (const choice of choices) expect(choice.name).toMatch(/^ops-runner · /);
  });

  it('suiteChangeText says each kind of change in both languages', () => {
    const base = { version: 2, actorId: 'p-1', reason: null, createdAt: '2026-10-30T00:00:00Z' };
    expect(
      suiteChangeText({ ...base, version: 1, kind: 'created', workerDefinitionVersion: 1 }, zh),
    ).toMatch(/^新建用例集，钉住 Worker v1$/);
    expect(suiteChangeText({ ...base, kind: 'repinned', fromVersion: 1, toVersion: 2 }, en)).toBe(
      'Pinned Worker version v1 → v2',
    );
    expect(
      suiteChangeText(
        { ...base, kind: 'fixture_gate_added', gatekeeperId: 'g', gateName: 'inventory' },
        zh,
      ),
    ).toMatch(/^添加夹具门 inventory$/);
    expect(
      suiteChangeText(
        { ...base, kind: 'fixture_gate_removed', gatekeeperId: 'g', gateName: 'inventory' },
        en,
      ),
    ).toBe('Removed fixture gate inventory');
    expect(
      suiteChangeText(
        {
          ...base,
          kind: 'fixture_gate_synced',
          gatekeeperId: 'g',
          gateName: 'inventory',
          addedOperations: ['hosts.reboot', 'hosts.ping'],
          removedOperations: [],
          changedOperations: ['hosts.list'],
        },
        zh,
      ),
    ).toMatch(/^同步夹具门 inventory：新增 hosts\.reboot、hosts\.ping；变更 hosts\.list$/);
  });

  it('syncPreview compares by name and published version', () => {
    const diff = syncPreview(
      [
        { name: 'hosts.list', version: 1 },
        { name: 'hosts.gone', version: 1 },
        { name: 'hosts.same', version: 2 },
      ],
      [
        { name: 'hosts.list', version: 2 },
        { name: 'hosts.same', version: 2 },
        { name: 'hosts.new', version: 1 },
      ],
    );
    expect(diff).toEqual({
      addedOperations: ['hosts.new'],
      removedOperations: ['hosts.gone'],
      changedOperations: ['hosts.list'],
    });
    expect(operationDiffParts(diff, en)).toEqual([
      'added hosts.new',
      'removed hosts.gone',
      'changed hosts.list',
    ]);
    expect(operationDiffParts(syncPreview([], []), zh)).toEqual([]);
  });

  it('liveStateNotice asks for a sync only when the gate changed; unavailable says it cannot sync', () => {
    expect(liveStateNotice('same', zh)).toBeNull();
    expect(liveStateNotice('changed', zh)).toContain('同步');
    expect(liveStateNotice('unavailable', zh)).toContain('无法同步');
  });

  it('suiteSummaryOf drops the detail-only fields', () => {
    const suite = {
      id: 's-1',
      name: 'n',
      description: '',
      workerDefinition: { id: 'wd', version: 1, status: 'published' },
      version: 1,
      fixtureGateCount: 0,
      fixtureGatesNeedingAttention: 0,
      caseCount: 0,
      casesNeedingAttention: 0,
      createdBy: 'p',
      createdAt: 'x',
      updatedAt: 'x',
      canary: `NTEVAL-${'0'.repeat(32)}`,
      fixtureGates: [],
      cases: [],
      history: [],
    } satisfies EvalSuiteWire;
    expect(Object.keys(suiteSummaryOf(suite)).sort()).toEqual(
      [
        'caseCount',
        'casesNeedingAttention',
        'createdAt',
        'createdBy',
        'description',
        'fixtureGateCount',
        'fixtureGatesNeedingAttention',
        'id',
        'name',
        'updatedAt',
        'version',
        'workerDefinition',
      ].sort(),
    );
  });
});
