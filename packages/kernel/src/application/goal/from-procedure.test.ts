import { randomUUID } from 'node:crypto';
import type { OutputSchema, ProcedureStep } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  RedactedTextSubmittedError,
  TextCarriesCredentialsError,
} from '../../governance/redaction/index.js';
import {
  PROCEDURE_CONFIRM_KEY,
  type ProcedureTemplate,
  expandProcedure,
  procedureTemplateProblems,
  refuseProcedureParameters,
} from './from-procedure.js';
import { GoalPlanValidationError, parsePlan } from './plan.js';

/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
const DEF = randomUUID();
const GATE = randomUUID();

const SITE: OutputSchema = {
  type: 'object',
  properties: {
    site: { type: 'string', minLength: 1 },
    hosts: { type: 'array', items: { type: 'string' } },
  },
  required: ['site'],
  additionalProperties: false,
};
const HOSTS: OutputSchema = {
  type: 'object',
  properties: { hosts: { type: 'array', items: { type: 'string' } } },
};

const worker = (fields: Record<string, unknown> = {}): ProcedureStep =>
  ({ kind: 'worker', definitionId: DEF, version: 1, ...fields }) as ProcedureStep;

function template(
  steps: readonly ProcedureStep[],
  parameters: OutputSchema | null = null,
): ProcedureTemplate {
  return { id: randomUUID(), version: 3, name: 'renew', steps, parameters };
}

/** The problems `fn` is refused with. */
function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof GoalPlanValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected a GoalPlanValidationError');
}

describe('expandProcedure (S11 GO5d-2)', () => {
  it('makes a plan of the worker steps, one after another, keyed by their place', () => {
    const plan = expandProcedure(
      template([
        worker({ input: { scope: 'all' } }),
        { kind: 'verify', description: 'The certificates are renewed.' },
        worker({ maxAttempts: 2 }),
      ]),
      undefined,
    );
    expect(plan).toEqual({
      steps: [
        { key: 'step-1', worker: { definitionId: DEF, version: 1 }, input: { scope: 'all' } },
        {
          key: 'step-3',
          worker: { definitionId: DEF, version: 1 },
          dependsOn: ['step-1'],
          maxAttempts: 2,
        },
      ],
      acceptance: [
        {
          kind: 'requester_confirm',
          key: PROCEDURE_CONFIRM_KEY,
          prompt: 'The certificates are renewed.',
        },
      ],
    });
    expect(() => parsePlan(plan)).not.toThrow();
  });

  it('keeps the keys, dependencies, contracts and step bindings a template states', () => {
    const plan = expandProcedure(
      template([
        worker({ key: 'fetch', outputSchema: HOSTS }),
        worker({ key: 'audit', dependsOn: [] }),
        worker({
          key: 'apply',
          dependsOn: ['fetch'],
          bindings: [{ to: 'target.hosts', from: 'fetch', path: 'hosts' }],
        }),
      ]),
      undefined,
    ) as { steps: Record<string, unknown>[] };
    expect(plan.steps.map((step) => [step.key, step.dependsOn])).toEqual([
      ['fetch', undefined],
      ['audit', []],
      ['apply', ['fetch']],
    ]);
    expect(plan.steps[0]?.outputSchema).toEqual(HOSTS);
    expect(plan.steps[2]?.bindings).toEqual([{ to: 'target.hosts', from: 'fetch', path: 'hosts' }]);
    expect(() => parsePlan(plan)).not.toThrow();
  });

  it('fills the $params bindings in from the parameters, so the plan is concrete', () => {
    const plan = expandProcedure(
      template(
        [
          worker({
            key: 'fetch',
            input: { mode: 'safe', target: { port: 443 } },
            bindings: [
              { to: 'target.site', from: '$params', path: 'site' },
              { to: 'first', from: '$params', path: 'hosts[0]' },
            ],
          }),
        ],
        SITE,
      ),
      { site: 'main', hosts: ['web-1', 'web-2'] },
    ) as { steps: Record<string, unknown>[] };
    expect(plan.steps[0]).toEqual({
      key: 'fetch',
      worker: { definitionId: DEF, version: 1 },
      input: { mode: 'safe', target: { port: 443, site: 'main' }, first: 'web-1' },
    });
  });

  it('checks the parameters against the schema, places under fromProcedure.parameters', () => {
    const steps = [worker({ bindings: [{ to: 'site', from: '$params', path: 'site' }] })];
    expect(problemsOf(() => expandProcedure(template(steps, SITE), undefined))).toEqual([
      'fromProcedure.parameters.site: required, missing',
    ]);
    expect(
      problemsOf(() => expandProcedure(template(steps, SITE), { site: '', extra: 1 })),
    ).toEqual([
      'fromProcedure.parameters.site: shorter than 1 characters',
      'fromProcedure.parameters.extra: not declared by the schema (additionalProperties is false)',
    ]);
    expect(problemsOf(() => expandProcedure(template([worker()]), { site: 'main' }))).toEqual([
      expect.stringMatching(
        /^fromProcedure\.parameters: Procedure .* version 3 takes no parameters$/,
      ),
    ]);
    // Nothing given to a Procedure that takes none is fine.
    expect(() => expandProcedure(template([worker()]), {})).not.toThrow();
  });

  it('a $params binding that selects nothing, or clashes with the input or another binding, is a problem', () => {
    const optional: OutputSchema = {
      type: 'object',
      properties: { site: { type: 'string' }, region: { type: 'string' } },
    };
    expect(
      problemsOf(() =>
        expandProcedure(
          template(
            [worker({ bindings: [{ to: 'region', from: '$params', path: 'region' }] })],
            optional,
          ),
          { site: 'main' },
        ),
      ),
    ).toEqual(['step "step-1": bindings[0]: selects nothing of fromProcedure.parameters (region)']);
    expect(
      problemsOf(() =>
        expandProcedure(
          template(
            [
              worker({ key: 'fetch', outputSchema: HOSTS }),
              worker({
                input: { site: 'fixed' },
                bindings: [
                  { to: 'site', from: '$params', path: 'site' },
                  { to: 'target', from: '$params', path: 'site' },
                  { to: 'target.hosts', from: 'fetch', path: 'hosts' },
                  { to: 'target.name', from: '$params', path: 'site' },
                ],
              }),
            ],
            optional,
          ),
          { site: 'main' },
        ),
      ),
    ).toEqual([
      'step "step-2": bindings[0]: the input already has a value at "site" — take it out of the input, or bind another field',
      'step "step-2": bindings[1]: puts its value at "target", where the binding from step "fetch" puts its own at "target.hosts"',
      'step "step-2": bindings[3]: puts its value at "target.name", where bindings[1] puts its own at "target"',
    ]);
    expect(
      problemsOf(() =>
        expandProcedure(
          template(
            [worker({ input: [1], bindings: [{ to: 'site', from: '$params', path: 'site' }] })],
            optional,
          ),
          { site: 'main' },
        ),
      ),
    ).toEqual([
      'step "step-1": the input must be an object when the step has bindings — a binding fills a field of it',
    ]);
  });

  it('makes a verify step with a check the platform’s, and the others one confirmation', () => {
    const observe = {
      kind: 'observe_predicate' as const,
      key: 'renewed',
      check: {
        gatekeeperId: GATE,
        operation: 'cert.status',
        params: { name: 'web' },
        expect: { path: 'state', op: 'eq' as const, value: 'valid' },
      },
    };
    const plan = expandProcedure(
      template([
        worker(),
        { kind: 'verify', description: 'The old certificate is revoked.' },
        { kind: 'verify', description: 'renewed', check: observe },
        { kind: 'verify', description: 'The owner was told.' },
      ]),
      undefined,
    ) as { acceptance: unknown[] };
    expect(plan.acceptance).toEqual([
      observe,
      {
        kind: 'requester_confirm',
        key: PROCEDURE_CONFIRM_KEY,
        prompt: '1. The old certificate is revoked.\n2. The owner was told.',
      },
    ]);
    expect(() => parsePlan(plan)).not.toThrow();
  });

  it('makes no plan of an operation or approval step, nor of no worker step', () => {
    expect(
      problemsOf(() =>
        expandProcedure(
          template([
            worker(),
            { kind: 'approval', description: 'Finance approves.' },
            { kind: 'operation', gatekeeperId: GATE, operationName: 'cert.replace' },
          ]),
          undefined,
        ),
      ),
    ).toEqual([
      expect.stringMatching(/^Procedure step 2 is an approval step — /),
      expect.stringMatching(/^Procedure step 3 is an operation step — /),
    ]);
    expect(
      problemsOf(() =>
        expandProcedure(template([{ kind: 'verify', description: 'Done.' }]), undefined),
      ),
    ).toEqual(["the Procedure has no worker step — a goal's plan runs at least one Worker"]);
  });
});

describe('procedureTemplateProblems (S11 GO5d-2)', () => {
  it('passes a template whose plan passes, $params checked against the schema only', () => {
    expect(
      procedureTemplateProblems(
        template(
          [
            worker({
              key: 'fetch',
              outputSchema: HOSTS,
              bindings: [{ to: 'site', from: '$params', path: 'site' }],
            }),
            worker({ bindings: [{ to: 'hosts', from: 'fetch', path: 'hosts' }] }),
            { kind: 'approval', description: 'Kept for following by hand.' },
          ],
          SITE,
        ),
      ),
    ).toEqual([]);
  });

  it('refuses $params without parameters, or a path the schema rules out', () => {
    expect(
      procedureTemplateProblems(
        template([worker({ bindings: [{ to: 'site', from: '$params', path: 'site' }] })]),
      ),
    ).toEqual([
      'step "step-1": bindings[0]: takes from $params, but the Procedure declares no parameters',
    ]);
    const problems = procedureTemplateProblems(
      template([worker({ bindings: [{ to: 'x', from: '$params', path: 'nowhere' }] })], SITE),
    );
    expect(problems).toEqual([
      'step "step-1": bindings[0]: path "nowhere": the parameters schema does not declare "nowhere" in the parameters',
    ]);
  });

  it('says every problem in one go — the making’s and the plan’s — a binding by its place in the Procedure step', () => {
    expect(
      procedureTemplateProblems(
        template(
          [
            worker({
              key: 'scan',
              outputSchema: HOSTS,
              bindings: [
                { to: 'site', from: '$params', path: 'site' },
                { to: 'zone', from: '$params', path: 'zone' },
              ],
            }),
            worker({
              key: 'apply-20',
              bindings: [
                { to: 'site', from: '$params', path: 'site' },
                { to: 'hosts', from: 'scan', path: 'hosts' },
                { to: 'more', from: '$params', path: 'hosts' },
                { to: 'hosts', from: 'missing', path: 'hosts' },
              ],
            }),
          ],
          SITE,
        ),
      ),
    ).toEqual([
      'step "scan": bindings[1]: path "zone": the parameters schema does not declare "zone" in the parameters',
      'the plan it makes: step "apply-20": bindings[3]: takes from step "missing", which this step does not depend on — add it to dependsOn',
      'the plan it makes: step "apply-20": bindings[3]: puts its value at "hosts", where bindings[1] puts its own at "hosts"',
    ]);
    // No step at all: the making's problem alone, not the plan's restatement of it.
    expect(procedureTemplateProblems(template([{ kind: 'verify', description: 'ok' }]))).toEqual([
      "the Procedure has no worker step — a goal's plan runs at least one Worker",
    ]);
  });

  it('names the plan’s own problems as the plan it makes', () => {
    expect(
      procedureTemplateProblems(
        template([
          worker({ key: 'fetch' }),
          worker({ dependsOn: ['missing'] }),
          worker({ bindings: [{ to: 'hosts', from: 'fetch', path: 'hosts' }] }),
        ]),
      ),
    ).toEqual([
      'the plan it makes: step "step-2": depends on "missing", which is not in the plan',
      'the plan it makes: step "step-3": bindings[0]: takes from step "fetch", which this step does not depend on — add it to dependsOn',
    ]);
  });

  it('refuses a template whose plan would carry a credential or a [redacted] mark', () => {
    const [credential] = procedureTemplateProblems(
      template([worker({ input: { password: FAKE } })]),
    );
    expect(credential).toMatch(/^the plan it makes: the plan carries 1 suspected credential/);
    expect(credential).toContain('plan.steps.0.input.password');
    const [mark] = procedureTemplateProblems(template([worker({ input: { note: '[redacted]' } })]));
    expect(mark).toMatch(
      /^the plan it makes: the plan still holds, at plan\.steps\.0\.input\.note/,
    );
  });
});

describe('refuseProcedureParameters (S11 GO5d-2)', () => {
  it('refuses a credential or a [redacted] mark at its place under fromProcedure.parameters', () => {
    expect(() => refuseProcedureParameters(undefined)).not.toThrow();
    expect(() => refuseProcedureParameters({ site: 'main', hosts: ['a'] })).not.toThrow();
    let thrown: unknown;
    try {
      refuseProcedureParameters({ site: 'main', auth: { token: FAKE } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TextCarriesCredentialsError);
    expect((thrown as TextCarriesCredentialsError).details).toMatchObject({
      field: 'fromProcedure.parameters.auth.token',
      suspectedSecretValues: 1,
    });
    try {
      refuseProcedureParameters({ hosts: ['a', '[redacted]'] });
      thrown = undefined;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RedactedTextSubmittedError);
    expect((thrown as RedactedTextSubmittedError).details).toEqual({
      field: 'fromProcedure.parameters.hosts.1',
      paths: ['fromProcedure.parameters.hosts.1'],
    });
  });
});
