import { describe, expect, it } from 'vitest';
import {
  EvalCaseContentSchema,
  EvalCaseKindSchema,
  evalCallCountPath,
  evalCaseKindProblem,
  evalCaseSizeProblem,
  evalOutputFieldPath,
  parseEvalCallCountPath,
  parseEvalOutputFieldPath,
} from './eval-case.js';

const GATE = '6b0e2f1e-3d4a-4c4e-9a8b-0d2c4e6f8a1b';

describe('eval-case (S10 E3-1b)', () => {
  it('reads back the call-count path it writes, whatever the Operation is named', () => {
    for (const operation of ['hosts.restart', "it's `odd` `twice`", 'a"b\\c', '重启']) {
      const path = evalCallCountPath(GATE, operation);
      expect(path).not.toMatch(/`[^`]*`[^`]*`[^`]*`[^`]*`[^`]*`/); // two literals, no stray backtick
      expect(parseEvalCallCountPath(path)).toEqual({ gatekeeperId: GATE, operation });
    }
    expect(parseEvalCallCountPath('length(calls)')).toBeNull();
    expect(
      parseEvalCallCountPath(`length(calls[?gatekeeperId==\`"${GATE}"\` && operation==\`"x"\`]) `),
    ).toBeNull();
  });

  it('reads back the output-field path it writes', () => {
    expect(evalOutputFieldPath('restarted')).toBe('result.output.restarted');
    expect(evalOutputFieldPath('host name')).toBe('result.output."host name"');
    for (const field of ['restarted', 'host name', 'a.b', '"quoted"']) {
      expect(parseEvalOutputFieldPath(evalOutputFieldPath(field))).toBe(field);
    }
    expect(parseEvalOutputFieldPath('result.output.a.b')).toBeNull();
    expect(parseEvalOutputFieldPath('result.summary')).toBeNull();
  });

  it('holds a mechanism to its partition', () => {
    expect(evalCaseKindProblem({ partition: 'mechanism', split: 'dev' })).toMatch(
      /names the mechanism/,
    );
    expect(
      evalCaseKindProblem({ partition: 'regression', split: 'dev', mechanism: 'loops' }),
    ).toMatch(/no other case names one/);
    expect(
      evalCaseKindProblem({ partition: 'mechanism', split: 'holdout', mechanism: 'loops' }),
    ).toBeNull();
    expect(EvalCaseKindSchema.safeParse({ partition: 'smoke', split: 'dev' }).success).toBe(false);
  });

  it('takes a case with an input, fixture rules and at least one assertion', () => {
    const content = {
      title: '  Restart web-1  ',
      input: { task: 'restart web-1' },
      fixtures: [
        {
          gatekeeperId: GATE,
          operation: 'hosts.get',
          when: { path: 'host', op: 'eq', value: 'web-1' },
          answer: { kind: 'data', data: { state: 'hung' } },
        },
        { gatekeeperId: GATE, operation: 'hosts.get', answer: { kind: 'absent' } },
        { gatekeeperId: GATE, operation: 'hosts.list', answer: { kind: 'error', message: 'down' } },
      ],
      assertions: [{ expect: { path: 'result.summary', op: 'exists' }, note: 'says something' }],
    };
    const parsed = EvalCaseContentSchema.parse(content);
    expect(parsed.title).toBe('Restart web-1');
    expect(evalCaseSizeProblem(parsed)).toBeNull();
    for (const bad of [
      { ...content, input: '   ' },
      { ...content, input: null },
      { ...content, assertions: [] },
      { ...content, fixtures: [{ ...content.fixtures[0], answer: { kind: 'skip' } }] },
      {
        ...content,
        fixtures: [{ ...content.fixtures[2], answer: { kind: 'error', message: ' ' } }],
      },
      { ...content, fixtures: [{ ...content.fixtures[0], gatekeeperId: 'hosts' }] },
      { ...content, extra: true },
    ]) {
      expect(EvalCaseContentSchema.safeParse(bad).success).toBe(false);
    }
    const big = {
      ...parsed,
      input: 'x'.repeat(16_000),
      fixtures: Array(4).fill({
        gatekeeperId: GATE,
        operation: 'hosts.get',
        answer: { kind: 'data', data: 'y'.repeat(16_000) },
      }),
    };
    expect(evalCaseSizeProblem(big)).toMatch(/larger than 65536 bytes/);
  });
});
