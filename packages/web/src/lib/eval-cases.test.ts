import {
  type EvalCaseWire,
  type EvalFixtureGateWire,
  evalCallCountPath,
  evalOutputFieldPath,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  assertionDraftOf,
  assertionSentence,
  caseDraftOf,
  caseWriteErrors,
  checkCaseDraft,
  emptyAssertion,
  emptyCaseDraft,
  emptyRule,
  refusalPlace,
  ruleWhenText,
  sameContent,
} from './eval-cases.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { predicateDraftFrom } from './predicate-draft.js';

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

const HOSTS = '22222222-2222-4222-8222-222222222222';

const GATES: readonly EvalFixtureGateWire[] = [
  {
    gatekeeperId: HOSTS,
    gateName: 'hosts',
    operations: [
      {
        name: 'hosts.get',
        version: 1,
        mode: 'observe',
        description: null,
        paramsSchema: { type: 'object', properties: { host: { type: 'string' }, 'zone-id': {} } },
        answersAbsent: true,
      },
      {
        name: 'hosts.list',
        version: 1,
        mode: 'observe',
        description: null,
        paramsSchema: {},
        answersAbsent: false,
      },
      {
        name: 'hosts.restart',
        version: 1,
        mode: 'execute',
        description: null,
        paramsSchema: { type: 'object', properties: { host: { type: 'string' } } },
        answersAbsent: false,
      },
    ],
    snapshotDigest: `sha256:${'0'.repeat(64)}`,
    addedInVersion: 2,
    addedBy: 'p-me',
    addedAt: '2026-10-30T00:00:00.000Z',
    liveState: 'same',
  },
];

function wholeCase(extra: Partial<EvalCaseWire> = {}): EvalCaseWire {
  const evalCase: EvalCaseWire = {
    id: 'c-1',
    suiteId: 's-1',
    title: 'restart web only after checking dependants',
    partition: 'mechanism',
    split: 'holdout',
    mechanism: 'restarts without checking dependants',
    origin: 'human',
    addedInVersion: 3,
    addedBy: 'p-me',
    addedAt: '2026-10-30T00:00:00.000Z',
    supersedes: null,
    fixtureRuleCount: 3,
    assertionCount: 6,
    fixtureProblems: [],
    fixtureOperations: [],
    input: { ask: 'restart web', priority: 2 },
    fixtures: [
      {
        gatekeeperId: HOSTS,
        operation: 'hosts.get',
        when: { path: 'host', op: 'eq', value: 'web' },
        answer: { kind: 'data', data: { host: 'web', dependants: ['api'] } },
      },
      {
        gatekeeperId: HOSTS,
        operation: 'hosts.get',
        when: {
          all: [
            { path: '"zone-id"', op: 'exists' },
            { path: 'host', op: 'ne', value: 'web' },
          ],
        },
        answer: { kind: 'absent' },
      },
      {
        gatekeeperId: HOSTS,
        operation: 'hosts.restart',
        answer: { kind: 'error', message: 'maintenance window closed' },
      },
    ],
    assertions: [
      {
        expect: { path: 'result.summary', op: 'contains', value: 'api' },
        note: 'names the dependant',
      },
      { expect: { path: evalOutputFieldPath('restarted'), op: 'eq', value: false } },
      { expect: { path: evalCallCountPath(HOSTS, 'hosts.get'), op: 'gte', value: 1 } },
      { expect: { path: evalCallCountPath(HOSTS, 'hosts.list'), op: 'eq', value: 0 } },
      { expect: { path: evalCallCountPath(HOSTS, 'hosts.restart'), op: 'lte', value: 1 } },
      {
        expect: {
          any: [
            { path: 'result.output.why', op: 'exists' },
            { path: 'calls[0].answer', op: 'eq', value: 'absent' },
          ],
        },
      },
    ],
    contentDigest: `sha256:${'1'.repeat(64)}`,
    retiredInVersion: null,
    retireReason: null,
    supersededBy: null,
    ...extra,
  };
  // The kernel's brief: the distinct gate and operation pairs the rules answer, in rule order.
  const pairs = new Map(
    evalCase.fixtures.map((rule) => [
      `${rule.gatekeeperId}\u0000${rule.operation}`,
      { gatekeeperId: rule.gatekeeperId, operation: rule.operation },
    ]),
  );
  return { ...evalCase, fixtureOperations: extra.fixtureOperations ?? [...pairs.values()] };
}

describe('lib/eval-cases (S10 E3-1b)', () => {
  it('reads a case into the editor and writes the same content back, every template kept', () => {
    const original = wholeCase();
    const draft = caseDraftOf(original, GATES);
    expect(draft.inputMode).toBe('json');
    expect(draft.fixtures.map((rule) => rule.whenMode)).toEqual(['param', 'predicate', 'always']);
    expect(draft.fixtures[0]).toMatchObject({
      whenParam: 'host',
      whenOp: 'eq',
      whenValueText: 'web',
    });
    expect(draft.assertions.map((assertion) => assertion.template)).toEqual([
      'summary_contains',
      'output_equals',
      'called',
      'not_called',
      'at_most',
      'predicate',
    ]);
    const check = checkCaseDraft(draft, GATES, true, zh);
    expect(check.missing).toEqual([]);
    expect(check.errors).toEqual({});
    expect(check.content).not.toBeNull();
    expect(sameContent(check.content as NonNullable<typeof check.content>, original)).toBe(true);
  });

  it('a text input stays text; a parameter the Operation does not name reads as a custom condition', () => {
    const draft = caseDraftOf(
      wholeCase({
        input: 'restart web',
        fixtures: [
          {
            gatekeeperId: HOSTS,
            operation: 'hosts.get',
            when: { path: 'filters.name', op: 'eq', value: 'web' },
            answer: { kind: 'absent' },
          },
        ],
      }),
      GATES,
    );
    expect(draft.inputMode).toBe('text');
    expect(draft.inputText).toBe('restart web');
    expect(draft.fixtures[0]?.whenMode).toBe('predicate');
  });

  it('says what is still missing, and refuses a kind left unpicked on a new case', () => {
    const check = checkCaseDraft(emptyCaseDraft(), GATES, false, en);
    expect(check.content).toBeNull();
    expect(check.missing).toEqual([
      'enter a title',
      'choose a partition',
      'choose dev or holdout',
      'enter the input',
      'complete the assertions',
    ]);
    const mechanism = checkCaseDraft(
      { ...emptyCaseDraft(), partition: 'mechanism', split: 'dev' },
      GATES,
      false,
      en,
    );
    expect(mechanism.missing).toContain('name the mechanism');
  });

  it('marks a field that does not parse, under its own place', () => {
    const rule = { ...emptyRule(HOSTS, 'hosts.list'), dataText: '{not json' };
    const absent = { ...emptyRule(HOSTS, 'hosts.list'), answer: 'absent' as const };
    const count = {
      ...emptyAssertion('at_most'),
      gatekeeperId: HOSTS,
      operation: 'hosts.list',
      count: '0',
    };
    const custom = {
      ...emptyAssertion('predicate'),
      predicate: { mode: 'json' as const, text: '{"path": 1}' },
    };
    const check = checkCaseDraft(
      {
        ...emptyCaseDraft(),
        title: 't',
        partition: 'full',
        split: 'dev',
        inputMode: 'json',
        inputText: 'null',
        fixtures: [rule, absent],
        assertions: [count, custom],
      },
      GATES,
      false,
      en,
    );
    expect(check.content).toBeNull();
    expect(check.errors.input).toBe('The input cannot be null');
    expect(check.errors[`${rule.uid}.data`]).toBe('Not valid JSON');
    // hosts.list declares no "not there" answer.
    expect(check.errors[`${absent.uid}.answer`]).toMatch(/declares no “not there” answer/);
    expect(check.errors[`${count.uid}.count`]).toMatch(/at least 1/);
    expect(Object.keys(check.errors).some((key) => key.startsWith(`${custom.uid}.expect`))).toBe(
      true,
    );
    // A marked problem is not also "missing".
    expect(check.missing).toEqual([]);
  });

  it('writes the templates as the shared paths, and reads anything else back as a custom condition', () => {
    const summary = { ...emptyAssertion('summary_contains'), text: 'done' };
    const notCalled = {
      ...emptyAssertion('not_called'),
      gatekeeperId: HOSTS,
      operation: 'hosts.restart',
    };
    const check = checkCaseDraft(
      {
        ...emptyCaseDraft(),
        title: 't',
        partition: 'regression',
        split: 'dev',
        inputText: 'go',
        assertions: [summary, notCalled],
      },
      GATES,
      false,
      zh,
    );
    expect(check.content?.assertions).toEqual([
      { expect: { path: 'result.summary', op: 'contains', value: 'done' } },
      { expect: { path: evalCallCountPath(HOSTS, 'hosts.restart'), op: 'eq', value: 0 } },
    ]);
    expect(
      assertionDraftOf({
        expect: { path: evalCallCountPath(HOSTS, 'hosts.restart'), op: 'gt', value: 2 },
      }).template,
    ).toBe('predicate');
    expect(
      assertionDraftOf({ expect: { path: 'result.summary', op: 'eq', value: 'done' } }).template,
    ).toBe('predicate');
    expect(predicateDraftFrom(undefined).mode).toBe('form');
  });

  it('says each assertion and rule in a sentence, naming the gate and Operation', () => {
    const evalCase = wholeCase();
    const sentences = evalCase.assertions.map((assertion) =>
      assertionSentence(assertion, GATES, zh),
    );
    expect(sentences[0]).toBe('结果摘要包含 "api"');
    expect(sentences[1]).toMatch(/^输出字段 restarted 等于 false$/);
    expect(sentences[2]).toMatch(/^调用过 hosts · hosts\.get$/);
    expect(sentences[3]).toMatch(/^没有调用 hosts · hosts\.list$/);
    expect(sentences[4]).toBe('调用 hosts · hosts.restart 至多 1 次');
    expect(sentences[5]).toMatch(/^以下任一成立/);
    expect(assertionSentence(evalCase.assertions[2] as never, [], zh)).toMatch(
      /^调用过 （已不在用例集里的门） · hosts\.get$/,
    );
    expect(ruleWhenText(evalCase.fixtures[2] as never, zh)).toBe('任何参数');
    expect(ruleWhenText(evalCase.fixtures[0] as never, zh)).toBe('参数满足：host 等于 "web"');
  });

  it('says where a credential or masked-text refusal found something, never the value', () => {
    expect(refusalPlace('fixtures[1].answer.data.auth', zh)).toBe('规则 2 的应答');
    expect(refusalPlace('fixtures[0].when.value', zh)).toBe('规则 1 的条件');
    expect(refusalPlace('assertions[2].note', zh)).toBe('断言 3 的说明');
    expect(refusalPlace('assertions[0].expect.value', zh)).toBe('断言 1');
    expect(refusalPlace('input.password', zh)).toBe('输入');
    expect(refusalPlace('title', zh)).toBe('标题');
    const refused = new HttpError('capability_error', 'refused', 'credentials_in_text', {
      field: 'fixtures[1].answer.data.auth',
      suspectedSecretValues: 2,
      suspectedSecretPaths: ['fixtures[1].answer.data.auth', 'assertions[0].expect.value'],
    });
    const text = caseWriteErrors(refused, zh).credentials_in_text;
    expect(text).toMatch(/^规则 2 的应答、断言 1里有像凭据的写法/);
    expect(caseWriteErrors(refused, en).credentials_in_text).toMatch(
      /^The answer of rule 2, assertion 1 looks like it carries a credential/,
    );
    const masked = new HttpError('capability_error', 'refused', 'redacted_text_submitted', {
      field: 'input',
      paths: ['input'],
    });
    expect(caseWriteErrors(masked, zh).redacted_text_submitted).toMatch(
      /^输入里还留着 \[redacted\]/,
    );
    // Any other error keeps the suite's own words.
    expect(Object.keys(caseWriteErrors(new Error('x'), zh))).toEqual(['version_changed']);
  });
});
