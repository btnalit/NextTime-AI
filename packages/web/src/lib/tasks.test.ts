import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  type WorkerDefinitionSummary,
  definitionVersions,
  distinctDefinitionName,
  inUseEntryVersion,
  latestPerDefinition,
  publishedFamilyHeads,
  taskNeed,
  versionOptionText,
  workerDefinitionChoices,
} from './tasks.js';

const zh: Translate = (text) => text;

/**
 * lib/tasks.test: `taskNeed` (S8 W4, audit R7 "行副标题直接显示原始 JSON 输入") — the conventional
 * `invoke_worker` input shapes `TasksPage`'s row subtitle recognizes before falling back to a raw
 * JSON excerpt of the opaque `input` blob.
 */
describe('taskNeed', () => {
  it("strips the kernel's turn-id routing marker from a chat message (#559 acceptance P2-2)", () => {
    expect(taskNeed({ message: '<!--nexttime:turn_id=01HZXY-abc-->\n 帮我整理本周的告警' })).toBe(
      '帮我整理本周的告警',
    );
    // A marker alone is no need at all — the page then falls back to its excerpt.
    expect(taskNeed({ message: '<!--nexttime:turn_id=abc-->\n' })).toBeUndefined();
    // Text that merely mentions a comment later on is left alone.
    expect(taskNeed('see <!--nexttime:turn_id=abc-->')).toBe('see <!--nexttime:turn_id=abc-->');
  });

  it('returns a bare string input as-is', () => {
    expect(taskNeed('restart web-1')).toBe('restart web-1');
  });

  it.each(['need', 'intent', 'message', 'prompt', 'summary', 'task'])(
    'reads the %s key off an object input',
    (key) => {
      expect(taskNeed({ [key]: 'Inventory the Docker containers' })).toBe(
        'Inventory the Docker containers',
      );
    },
  );

  it('prefers need over a later key when both are present', () => {
    expect(taskNeed({ need: 'from need', intent: 'from intent' })).toBe('from need');
  });

  it('returns undefined for an object with none of the conventional keys, or a non-string value', () => {
    expect(taskNeed({ foo: 'bar' })).toBeUndefined();
    expect(taskNeed({ intent: 42 })).toBeUndefined();
    expect(taskNeed(null)).toBeUndefined();
    expect(taskNeed(undefined)).toBeUndefined();
  });
});

describe('workerDefinitionChoices (#541 acceptance: same-name Workers)', () => {
  const row = (id: string, name: string | undefined, version = 1): WorkerDefinitionSummary => ({
    id,
    version,
    kind: 'pi',
    status: 'published',
    definition: name === undefined ? {} : { name },
  });

  it('tells same-name definitions apart by short id, and leaves unique names alone', () => {
    const choices = workerDefinitionChoices(
      [
        row('aaaaaaaa-1111-4111-8111-111111111111', 'ops-runner'),
        row('bbbbbbbb-2222-4222-8222-222222222222', 'ops-runner'),
        row('cccccccc-3333-4333-8333-333333333333', 'reporter', 2),
      ],
      zh,
    );
    expect(choices.map((choice) => [choice.label, choice.version, choice.distinguisher])).toEqual([
      ['ops-runner', 'v1', 'aaaaaaaa'],
      ['ops-runner', 'v1', 'bbbbbbbb'],
      ['reporter', 'v2', undefined],
    ]);
  });

  it('an unnamed definition reads as its kind plus short id, never a bare uuid (#559 acceptance P2-3)', () => {
    const unnamed: WorkerDefinitionSummary = {
      ...row('dddddddd-4444-4444-8444-444444444444', undefined),
      kind: 'entry',
    };
    const [choice] = workerDefinitionChoices([unnamed], zh);
    expect(choice?.label).toMatch(/^入口 agent$/);
    expect(choice?.distinguisher).toBe('dddddddd');
  });
});

describe('per-definition versions and same-name names (#554 acceptance, field-inventory #26)', () => {
  const row = (id: string, name: string, version: number): WorkerDefinitionSummary => ({
    id,
    version,
    kind: 'pi',
    status: 'published',
    definition: { name },
  });
  const rows = [
    row('aaaaaaaa-1111', 'ops-runner', 1),
    row('aaaaaaaa-1111', 'ops-runner', 3),
    row('bbbbbbbb-2222', 'ops-runner', 1),
    row('cccccccc-3333', 'collector', 2),
  ];

  it('offers each definition once, at its newest version', () => {
    expect(latestPerDefinition(rows).map((r) => `${r.id}@${r.version}`)).toEqual([
      'aaaaaaaa-1111@3',
      'bbbbbbbb-2222@1',
      'cccccccc-3333@2',
    ]);
  });

  it('lists one definition’s versions newest first', () => {
    expect(definitionVersions(rows, 'aaaaaaaa-1111').map((r) => r.version)).toEqual([3, 1]);
    expect(definitionVersions(rows, 'missing')).toEqual([]);
  });

  it('names a same-name definition with its short id, a unique one plainly', () => {
    expect(distinctDefinitionName(rows, 'aaaaaaaa-1111', 3)).toBe('ops-runner · aaaaaaaa');
    expect(distinctDefinitionName(rows, 'cccccccc-3333', 2)).toBe('collector');
  });
});

describe('which published version matters (legacy 481)', () => {
  const row = (
    id: string,
    version: number,
    kind: string,
    status: string,
    publishedAt: string | null,
  ): WorkerDefinitionSummary => ({ id, version, kind, status, publishedAt, definition: {} });

  it('the entry version in use is the most recently published one, ties broken by id then version', () => {
    expect(
      inUseEntryVersion([
        row('e-a', 1, 'entry', 'published', '2026-10-01T00:00:00.000Z'),
        row('e-a', 2, 'entry', 'published', '2026-10-03T00:00:00.000Z'),
        row('e-a', 3, 'entry', 'draft', null),
        row('w-1', 9, 'worker', 'published', '2026-10-09T00:00:00.000Z'),
      ]),
    ).toEqual({ definitionId: 'e-a', version: 2 });
    expect(
      inUseEntryVersion([
        row('e-a', 1, 'entry', 'published', '2026-10-01T00:00:00.000Z'),
        row('e-b', 1, 'entry', 'published', '2026-10-01T00:00:00.000Z'),
      ]),
    ).toEqual({ definitionId: 'e-b', version: 1 });
    // No publish time to go by (a deprecated or draft row only): unknown, never a guess.
    expect(inUseEntryVersion([row('e-a', 1, 'entry', 'deprecated', null)])).toBeNull();
  });

  it('a family head only where a Worker has several published versions', () => {
    const heads = publishedFamilyHeads([
      row('w-1', 1, 'worker', 'published', null),
      row('w-1', 3, 'worker', 'published', null),
      row('w-1', 4, 'worker', 'draft', null),
      row('w-2', 1, 'worker', 'published', null),
    ]);
    expect([...heads]).toEqual([['w-1', 3]]);
  });

  it('a version picker marks the newest of several', () => {
    const versions = [
      row('w-1', 2, 'worker', 'published', null),
      row('w-1', 1, 'worker', 'published', null),
    ];
    expect(versionOptionText(versions[0] as WorkerDefinitionSummary, versions, zh)).toMatch(
      /^v2（最新）$/,
    );
    expect(versionOptionText(versions[1] as WorkerDefinitionSummary, versions, zh)).toBe('v1');
    expect(versionOptionText(versions[1] as WorkerDefinitionSummary, versions.slice(1), zh)).toBe(
      'v1',
    );
  });
});
