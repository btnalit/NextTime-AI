import type { OutputSchema, ProcedureBinding } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  parsedProcedureSteps,
  procedureBindingIssue,
  procedurePlanPlaces,
  procedureTemplateProblemText,
  procedureWorkersByKey,
} from './procedure-template.js';

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

describe('procedureTemplateProblemText (UX acceptance of #722, P2-1)', () => {
  // Each as the kernel words it (application/goal/from-procedure.ts, plan.ts, the binding path
  // checks in substrate/epistemic/predicate.ts).
  const cases: readonly (readonly [string, RegExp])[] = [
    [
      'step "scan": bindings[2]: path "zone": the parameters schema does not declare "zone" in the parameters',
      /^步骤 scan 的第 3 个绑定：路径 zone 取不到值：启动参数里没有声明 zone$/,
    ],
    [
      'step "scan": bindings[0]: path "cfg.zone": the parameters schema does not declare "zone" in cfg',
      /^步骤 scan 的第 1 个绑定：路径 cfg\.zone 取不到值：启动参数的 cfg 里没有声明 zone$/,
    ],
    [
      'step "scan": bindings[0]: takes from $params, but the Procedure declares no parameters',
      /^步骤 scan 的第 1 个绑定：取自启动参数，但这个流程没有声明启动参数$/,
    ],
    [
      'the plan it makes: step "apply": bindings[1]: takes from step "missing", which this step does not depend on — add it to dependsOn',
      /^步骤 apply 的第 2 个绑定：取自步骤 missing，但这一步不等它完成：要把它加进 dependsOn$/,
    ],
    [
      'the plan it makes: step "apply": bindings[0]: step "scan" declares no outputSchema — a binding takes only from a declared output',
      /^步骤 apply 的第 1 个绑定：步骤 scan 没有声明输出约定，绑定只能取自声明过的输出$/,
    ],
    [
      'the plan it makes: step "apply": bindings[0]: path "nope": the output schema does not declare "nope" in the output of step "scan"',
      /^步骤 apply 的第 1 个绑定：路径 nope 取不到值：步骤 scan 的输出约定里没有声明 nope$/,
    ],
    [
      'the plan it makes: step "apply": bindings[0]: path "hosts.x": hosts is not an object in the output schema of step "scan"',
      /^步骤 apply 的第 1 个绑定：路径 hosts\.x 取不到值：步骤 scan 的输出的 hosts 不是对象$/,
    ],
    [
      'step "scan": bindings[0]: path "site.x": the parameters is not an object in the parameters schema',
      /^步骤 scan 的第 1 个绑定：路径 site\.x 取不到值：启动参数不是对象$/,
    ],
    [
      'step "scan": bindings[1]: puts its value at "site", where bindings[0] puts its own at "site"',
      /^步骤 scan 的第 2 个绑定：放到 site，和第 1 个绑定放的 site 重叠$/,
    ],
    [
      'step "scan": bindings[0]: puts its value at "hosts", where the binding from step "fetch" puts its own at "hosts"',
      /^步骤 scan 的第 1 个绑定：放到 hosts，和取自步骤 fetch 的绑定放的 hosts 重叠$/,
    ],
    [
      'step "scan": bindings[0]: the input already has a value at "site" — take it out of the input, or bind another field',
      /^步骤 scan 的第 1 个绑定：写定的输入在 site 已经有值：把它从输入里去掉，或者绑到别的字段$/,
    ],
    [
      'step "scan": the input must be an object when the step has bindings — a binding fills a field of it',
      /^步骤 scan：有绑定时，写定的输入必须是对象，绑定是往它的字段里填值$/,
    ],
    [
      'the plan it makes: step "step-2": depends on "missing", which is not in the plan',
      /^步骤 step-2：要等的步骤 missing 不在计划里$/,
    ],
    [
      "the Procedure has no worker step — a goal's plan runs at least one Worker",
      /^这个流程没有 Worker 步骤：目标的计划至少要运行一个 Worker$/,
    ],
  ];

  it.each(cases)('%s', (problem, expected) => {
    expect(procedureTemplateProblemText(problem, zh)).toMatch(expected);
    // The English console shows the kernel's own text.
    expect(procedureTemplateProblemText(problem, en)).toBe(problem);
  });

  it('shows a problem it does not know as the kernel wrote it', () => {
    for (const problem of [
      'the plan it makes: the plan carries 1 suspected credential, at plan.steps.0.input.password',
      'step "scan": bindings[0]: path "a[": does not compile',
      'something new',
    ]) {
      expect(procedureTemplateProblemText(problem, zh)).toBe(problem);
    }
  });
});

describe('procedureBindingIssue (UX acceptance of #722, P3-1)', () => {
  const PARAMETERS: OutputSchema = {
    type: 'object',
    properties: { site: { type: 'string' } },
    additionalProperties: false,
  };
  const steps = parsedProcedureSteps([
    { kind: 'worker', definitionId: 'wd', version: 1, key: 'scan' },
    {
      kind: 'worker',
      definitionId: 'wd',
      version: 1,
      key: 'fetch',
      outputSchema: { type: 'object' },
      dependsOn: [],
    },
    { kind: 'worker', definitionId: 'wd', version: 1, key: 'apply' },
  ]);
  const places = procedurePlanPlaces(steps);
  const workers = procedureWorkersByKey(steps, places);
  const apply = places.get(2);
  if (!apply) throw new Error('no place for apply');
  const issue = (binding: ProcedureBinding, parameters: OutputSchema | null = PARAMETERS) =>
    procedureBindingIssue(binding, apply, workers, parameters, zh);

  it('marks what publishing would be refused for', () => {
    expect(issue({ to: 'zone', from: '$params', path: 'zone' })).toMatch(/没有声明 zone/);
    expect(issue({ to: 'site', from: '$params', path: 'site' }, null)).toMatch(/没有声明启动参数/);
    expect(issue({ to: 'x', from: 'missing', path: 'x' })).toMatch(/没有叫 missing 的 Worker 步骤/);
    // apply waits for the step before it (fetch) by default, not for scan.
    expect(issue({ to: 'x', from: 'scan', path: 'x' })).toMatch(/不等步骤 scan 完成/);
    const scanFirst = procedureBindingIssue(
      { to: 'x', from: 'fetch', path: 'x' },
      { key: 'apply', dependsOn: ['fetch', 'scan'], defaulted: false },
      workers,
      PARAMETERS,
      zh,
    );
    expect(scanFirst).toBeNull();
    expect(
      procedureBindingIssue(
        { to: 'x', from: 'scan', path: 'x' },
        { key: 'apply', dependsOn: ['scan'], defaulted: false },
        workers,
        PARAMETERS,
        zh,
      ),
    ).toMatch(/步骤 scan 没有声明输出约定/);
  });

  it('leaves the rest to the kernel', () => {
    expect(issue({ to: 'site', from: '$params', path: 'site' })).toBeNull();
    expect(issue({ to: 'x', from: 'fetch', path: 'anything.deeper' })).toBeNull();
    expect(
      issue({ to: 'zone', from: '$params', path: 'zone' }, { type: 'object', properties: {} }),
    ).toBeNull();
  });
});
