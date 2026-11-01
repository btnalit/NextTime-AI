import type { GoalPlan, PlanStep } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  MAX_INPUT_PATHS,
  type StepFieldChange,
  planStepDiff,
  stepChangeLine,
  stepFieldChangeText,
  stepFieldChanges,
} from './plan-step-diff.js';

const zh: Translate = (text) => text;
const en: Translate = (_zh, text) => text;

const WORKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const GATE = '11111111-1111-4111-8111-111111111111';
const names = {
  gateNames: new Map([[GATE, 'cert-gate']]),
  workerNames: new Map([[OTHER, 'renewer']]),
};

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  key: 'apply',
  worker: { definitionId: WORKER, version: 2 },
  ...overrides,
});
const plan = (...steps: PlanStep[]): GoalPlan => ({ steps });
const texts = (changes: readonly StepFieldChange[], t: Translate = zh) =>
  changes.map((change) => stepFieldChangeText(change, names, t));

describe('planStepDiff (S11 GO15a)', () => {
  it('lists only the steps kept under their key and redefined, in the new plan’s order', () => {
    const before = plan(step({ key: 'fetch' }), step({ key: 'apply' }), step({ key: 'gone' }));
    const after = plan(
      step({ key: 'apply', maxAttempts: 5 }),
      step({ key: 'new' }),
      step({ key: 'fetch', input: { hosts: 3 } }),
    );
    expect(planStepDiff(before, after).map((change) => change.key)).toEqual(['apply', 'fetch']);
    expect(planStepDiff(before, before)).toEqual([]);
  });

  it('says a step that differs only in how it is written still changed, since it starts over', () => {
    const before = plan(step({ dependsOn: ['a', 'b'] }));
    const after = plan(step({ dependsOn: ['b', 'a'], maxAttempts: 3 }));
    const [change] = planStepDiff(before, after);
    expect(change?.changes).toEqual([{ kind: 'notation' }]);
    expect(texts(change?.changes ?? [])).toEqual([
      '只改了写法（比如顺序，或写明了默认值），内容没变',
    ]);
  });
});

describe('stepFieldChanges as sentences (S11 GO15a)', () => {
  it('names the files a step reads instead, from what', () => {
    const changes = stepFieldChanges(
      step({ filesFrom: ['fetch'] }),
      step({ filesFrom: ['side', 'fetch-2'] }),
    );
    expect(texts(changes)).toEqual(['改读 side、fetch-2 留下的文件（原来读 fetch）']);
    expect(texts(changes, en)).toEqual([
      'Reads the files left by side, fetch-2 instead (was fetch)',
    ]);
    expect(texts(stepFieldChanges(step(), step({ filesFrom: ['fetch'] })))).toEqual([
      '读取步骤 fetch 留下的文件',
    ]);
    expect(texts(stepFieldChanges(step({ filesFrom: ['fetch'] }), step()))).toEqual([
      '不再读取步骤 fetch 留下的文件',
    ]);
  });

  it('says the WorkerSpec model, Skills, gates and scope from what to what', () => {
    const before = step({ spec: { model: 'model-a', skills: ['triage', 'audit'] } });
    const after = step({
      spec: { model: 'model-b', skills: ['triage', 'renew'], gates: [GATE], observeScope: [GATE] },
    });
    expect(texts(stepFieldChanges(before, after))).toEqual([
      expect.stringMatching(/^Skill 加上 renew，去掉 audit$/),
      '门 改为 cert-gate（原来沿用 Worker 定义）',
      expect.stringMatching(/^模型 model-a → model-b$/),
      '观察范围限定为门 cert-gate（原来不限）',
    ]);
    expect(texts(stepFieldChanges(after, step()))).toEqual([
      'Skill 改回沿用 Worker 定义',
      '门 改回沿用 Worker 定义',
      '模型改回沿用 Worker 定义',
      '观察范围改回不限',
    ]);
  });

  it('says a WorkerSpec’s responsibility and token cap changed without quoting them', () => {
    const changes = stepFieldChanges(
      step({ spec: { instructions: 'Only the hosts.', tokenBudget: 1000 } }),
      step({ spec: { instructions: 'Every host.', tokenBudget: 2000 } }),
    );
    expect(texts(changes)).toEqual([
      '这一步的职责说明改了',
      `每次尝试的 Token 上限 ${(1000).toLocaleString()} → ${(2000).toLocaleString()}`,
    ]);
    expect(texts(changes).join('')).not.toContain('Every host');
  });

  it('names where the input changed, never what it holds', () => {
    const changes = stepFieldChanges(
      step({ input: { hosts: 3, auth: { token: 'old-secret' } } }),
      step({ input: { hosts: 4, auth: { token: 'new-secret' } } }),
    );
    expect(texts(changes)).toEqual([expect.stringMatching(/^输入改了：auth\.token、hosts$/)]);
    expect(texts(changes).join('')).not.toMatch(/secret|3|4/);
    const many = Object.fromEntries(
      Array.from({ length: MAX_INPUT_PATHS + 2 }, (_, index) => [`f${index}`, index]),
    );
    const [wide] = stepFieldChanges(step({ input: {} }), step({ input: many }));
    expect(wide).toMatchObject({ kind: 'input', total: MAX_INPUT_PATHS + 2 });
    expect(texts(wide ? [wide] : [])[0]).toMatch(/等 12 处$/);
    expect(texts(stepFieldChanges(step(), step({ input: [1] })))).toEqual(['输入改了：整个输入']);
  });

  it('says what changed in its order, attempts, Worker, bindings, contract and checks', () => {
    const before = step({
      dependsOn: ['fetch'],
      bindings: [{ to: 'host', from: 'fetch', path: 'host' }],
      acceptance: [
        {
          kind: 'observe_predicate',
          key: 'renewed',
          check: {
            gatekeeperId: GATE,
            operation: 'cert.list',
            expect: { path: 'n', op: 'eq', value: 0 },
          },
        },
      ],
    });
    const after = step({
      worker: { definitionId: OTHER, version: 1 },
      dependsOn: ['side'],
      maxAttempts: 5,
      nested: true,
      bindings: [{ to: 'host', from: 'side', path: 'host' }],
      outputSchema: { type: 'object', properties: {} },
      acceptance: [
        {
          kind: 'observe_predicate',
          key: 'renewed',
          check: {
            gatekeeperId: GATE,
            operation: 'cert.list',
            expect: { path: 'n', op: 'eq', value: 1 },
          },
        },
      ],
    });
    const lines = texts(stepFieldChanges(before, after));
    expect(lines).toEqual([
      // The Worker the page has no name for reads by its short id, never the bare id.
      expect.stringMatching(/^换了 Worker：\S+ v2 → renewer v1$/),
      expect.stringMatching(/^前置步骤加上 side，去掉 fetch$/),
      '最多尝试次数 3 → 5',
      expect.stringMatching(/^改为可以起子 Worker$/),
      '取自前面步骤的输入：加上「输入 host 来自步骤 side 输出的 host」，去掉「输入 host 来自步骤 fetch 输出的 host」',
      '设了输出约定',
      expect.stringMatching(/^这一步的验收：renewed 从「.*0.*」改为「.*1.*」$/),
    ]);
    expect(lines[0]).not.toContain(WORKER);
    expect(
      texts(stepFieldChanges(step(), step({ worker: { definitionId: WORKER, version: 3 } }))),
    ).toEqual(['Worker 改用第 3 版（原来第 2 版）']);
  });

  it('joins a step’s changes into one line for a confirm', () => {
    const [change] = planStepDiff(
      plan(step({ filesFrom: ['fetch'] })),
      plan(step({ filesFrom: ['side', 'fetch-2'], spec: { model: 'model-b' } })),
    );
    expect(change && stepChangeLine(change, names, zh)).toBe(
      '模型设为 model-b（原来沿用 Worker 定义）；改读 side、fetch-2 留下的文件（原来读 fetch）',
    );
    expect(change && stepChangeLine(change, names, en)).toBe(
      'Model set to model-b (the Worker’s own before); Reads the files left by side, fetch-2 instead (was fetch)',
    );
  });
});
