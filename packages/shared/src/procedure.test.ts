import { describe, expect, it } from 'vitest';
import { CAPABILITY_REGISTRY } from './capabilities.js';
import { OUTPUT_MAX_CHARS } from './output-schema.js';
import {
  GoalFromProcedureSchema,
  PROCEDURE_PARAMS_SOURCE,
  type ProcedureStep,
  ProcedureStepSchema,
  ProposeProcedureContentSchema,
  usesPlanTemplateFields,
} from './procedure.js';

describe('ProcedureStepSchema', () => {
  it('accepts an operation step', () => {
    const result = ProcedureStepSchema.safeParse({
      kind: 'operation',
      gatekeeperId: 'gk-1',
      operationName: 'container.restart',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a worker step', () => {
    const result = ProcedureStepSchema.safeParse({
      kind: 'worker',
      definitionId: 'def-1',
      version: 1,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an approval step', () => {
    const result = ProcedureStepSchema.safeParse({
      kind: 'approval',
      description: 'Finance must approve the expense claim.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a verify step', () => {
    const result = ProcedureStepSchema.safeParse({
      kind: 'verify',
      description: 'Confirm the stock level changed.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(ProcedureStepSchema.safeParse({ kind: 'bogus' }).success).toBe(false);
  });

  it('rejects an approval/verify step with no description', () => {
    expect(ProcedureStepSchema.safeParse({ kind: 'approval' }).success).toBe(false);
    expect(ProcedureStepSchema.safeParse({ kind: 'verify' }).success).toBe(false);
  });

  it('rejects a worker step with a non-positive version', () => {
    expect(
      ProcedureStepSchema.safeParse({ kind: 'worker', definitionId: 'd', version: 0 }).success,
    ).toBe(false);
  });

  it('rejects an operation step with unknown extra fields (strict)', () => {
    expect(
      ProcedureStepSchema.safeParse({
        kind: 'operation',
        gatekeeperId: 'gk-1',
        operationName: 'op',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('ProposeProcedureContentSchema', () => {
  it('accepts a minimal procedure with an empty steps array (propose is permissive)', () => {
    const result = ProposeProcedureContentSchema.safeParse({
      name: 'restart-and-verify',
      description: 'Restart a container and confirm it came back up.',
      steps: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full multi-step procedure', () => {
    const result = ProposeProcedureContentSchema.safeParse({
      name: 'restart-and-verify',
      description: 'Restart a container and confirm it came back up.',
      steps: [
        { kind: 'operation', gatekeeperId: 'gk-1', operationName: 'container.restart' },
        { kind: 'verify', description: 'Container status is running.' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing field', () => {
    expect(ProposeProcedureContentSchema.safeParse({ name: 'x', description: 'y' }).success).toBe(
      false,
    );
  });

  it('rejects unknown extra fields (strict)', () => {
    expect(
      ProposeProcedureContentSchema.safeParse({
        name: 'x',
        description: 'y',
        steps: [],
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('Procedure as a plan template (S11 GO5d-2)', () => {
  const DEF = '00000000-0000-4000-8000-000000000001';
  const fetch = {
    kind: 'worker',
    definitionId: DEF,
    version: 1,
    key: 'fetch',
    input: { scope: 'all' },
    bindings: [{ to: 'site', from: PROCEDURE_PARAMS_SOURCE, path: 'site' }],
    outputSchema: { type: 'object', properties: { hosts: { type: 'array' } } },
    maxAttempts: 2,
  };
  const apply = {
    kind: 'worker',
    definitionId: DEF,
    version: 1,
    key: 'apply',
    dependsOn: ['fetch'],
    bindings: [{ to: 'target.hosts', from: 'fetch', path: 'hosts' }],
  };
  const verify = {
    kind: 'verify',
    description: 'The certificate is renewed on every host.',
    check: {
      kind: 'observe_predicate',
      key: 'renewed',
      check: {
        gatekeeperId: DEF,
        operation: 'cert.status',
        params: {},
        expect: { path: 'state', op: 'eq', value: 'valid' },
      },
    },
  };

  it('a worker step carries the plan step fields, and a binding may read the parameters', () => {
    for (const step of [fetch, apply, verify]) {
      expect(ProcedureStepSchema.safeParse(step).success).toBe(true);
    }
    for (const from of ['$other', '-x', '']) {
      expect(
        ProcedureStepSchema.safeParse({ ...apply, bindings: [{ to: 'a', from, path: 'x' }] })
          .success,
        from,
      ).toBe(false);
    }
    expect(ProcedureStepSchema.safeParse({ ...apply, bindings: [] }).success).toBe(false);
    expect(ProcedureStepSchema.safeParse({ ...apply, maxAttempts: 9 }).success).toBe(false);
    expect(ProcedureStepSchema.safeParse({ ...apply, nested: true }).success).toBe(false);
    expect(
      ProcedureStepSchema.safeParse({
        ...verify,
        check: { kind: 'requester_confirm', key: 'k', prompt: 'p' },
      }).success,
    ).toBe(false);
  });

  it('a Procedure may declare its parameters with the output schema subset', () => {
    const content = {
      name: 'renew',
      description: 'Renew the certificates of a site.',
      steps: [fetch, apply, verify],
      parameters: { type: 'object', properties: { site: { type: 'string' } }, required: ['site'] },
    };
    expect(ProposeProcedureContentSchema.safeParse(content).success).toBe(true);
    expect(
      ProposeProcedureContentSchema.safeParse({ ...content, parameters: { type: 'array' } })
        .success,
    ).toBe(false);
  });

  it('usesPlanTemplateFields tells a template from a plain Procedure', () => {
    const worker: ProcedureStep = { kind: 'worker', definitionId: 'd', version: 1 };
    const plain: ProcedureStep[] = [
      worker,
      { kind: 'verify', description: 'v' },
      { kind: 'approval', description: 'a' },
    ];
    expect(usesPlanTemplateFields({ steps: plain })).toBe(false);
    expect(usesPlanTemplateFields({ steps: plain, parameters: null })).toBe(false);
    expect(usesPlanTemplateFields({ steps: plain, parameters: { type: 'object' } })).toBe(true);
    expect(usesPlanTemplateFields({ steps: [{ ...worker, key: 'a' }] })).toBe(true);
    expect(usesPlanTemplateFields({ steps: [{ ...worker, input: null }] })).toBe(true);
    expect(usesPlanTemplateFields({ steps: [ProcedureStepSchema.parse(verify)] })).toBe(true);
  });

  it('fromProcedure names a Procedure by id, with plain JSON parameters within the size', () => {
    expect(GoalFromProcedureSchema.safeParse({ procedureId: DEF }).success).toBe(true);
    expect(
      GoalFromProcedureSchema.safeParse({ procedureId: DEF, version: 2, parameters: { a: 1 } })
        .success,
    ).toBe(true);
    expect(GoalFromProcedureSchema.safeParse({ procedureId: 'p-1' }).success).toBe(false);
    expect(GoalFromProcedureSchema.safeParse({ procedureId: DEF, parameters: [1] }).success).toBe(
      false,
    );
    expect(
      GoalFromProcedureSchema.safeParse({
        procedureId: DEF,
        parameters: { a: 'x'.repeat(OUTPUT_MAX_CHARS) },
      }).success,
    ).toBe(false);
  });

  it('propose_goal takes exactly one of plan and fromProcedure', () => {
    const propose = CAPABILITY_REGISTRY.find((capability) => capability.name === 'propose_goal');
    if (!propose) throw new Error('propose_goal is not registered');
    const base = {
      statement: 'Renew the certificates of the main site.',
      budget: { maxTokens: 1000, maxSteps: 5, maxRevisions: 1, maxWallClockSeconds: 600 },
    };
    const plan = { steps: [{ key: 'a', worker: { definitionId: DEF, version: 1 } }] };
    const fromProcedure = { procedureId: DEF, parameters: { site: 'main' } };
    expect(propose.paramsSchema.safeParse({ ...base, plan }).success).toBe(true);
    expect(propose.paramsSchema.safeParse({ ...base, fromProcedure }).success).toBe(true);
    const both = propose.paramsSchema.safeParse({ ...base, plan, fromProcedure });
    const neither = propose.paramsSchema.safeParse(base);
    expect(both.success || neither.success).toBe(false);
    if (!both.success && !neither.success) {
      expect(both.error.issues.map((issue) => issue.message)).toContain(
        'give exactly one of plan and fromProcedure',
      );
      expect(neither.error.issues.map((issue) => issue.path.join('.'))).toEqual(['plan']);
    }
  });
});
