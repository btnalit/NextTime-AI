import { describe, expect, it } from 'vitest';
import { PlanStepSchema, StepBindingSchema } from './goal-plan.js';
import {
  MAX_OUTPUT_PROBLEMS,
  OUTPUT_MAX_CHARS,
  OUTPUT_SCHEMA_MAX_DEPTH,
  OUTPUT_SCHEMA_MAX_NODES,
  OUTPUT_VALIDATION_MAX_NODES,
  type OutputSchema,
  StepOutputSchemaSchema,
  outputContractProblems,
  outputPath,
  validateOutput,
} from './output-schema.js';
import { WorkerResultContractSchema } from './worker-result.js';

const HOSTS: OutputSchema = {
  type: 'object',
  properties: {
    hosts: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    count: { type: 'integer', minimum: 0 },
    mode: { enum: ['fast', 'safe'] },
  },
  required: ['hosts'],
  additionalProperties: false,
};

const issues = (value: unknown): string[] => {
  const parsed = StepOutputSchemaSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('StepOutputSchemaSchema (S11 GO5d-1)', () => {
  it('accepts a bounded subset schema whose root is an object', () => {
    expect(issues(HOSTS)).toEqual([]);
    expect(issues({ type: 'object' })).toEqual([]);
  });

  it('refuses a root that is not an object, unknown keywords and misplaced ones', () => {
    expect(issues({ type: 'array', items: { type: 'string' } })).toEqual([
      "type: a step's output is an object: the schema's root must be type 'object'",
    ]);
    expect(issues({ type: 'object', pattern: '^a+$' }).join('\n')).toContain('pattern');
    expect(issues({ type: 'object', $ref: '#/x' }).join('\n')).toContain('$ref');
    expect(issues({ type: 'object', properties: { a: { minLength: 1 } } })).toEqual([
      'properties.a.minLength: acts only on string values — declare that type on this node',
    ]);
  });

  it('refuses required names it does not declare, repeats, and inverted bounds', () => {
    expect(
      issues({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b', 'a'] }),
    ).toEqual([
      'required.1: names "b", which properties does not declare',
      'required.2: names "a" more than once',
    ]);
    expect(
      issues({ type: 'object', properties: { n: { type: 'number', minimum: 5, maximum: 1 } } }),
    ).toEqual(['properties.n.minimum: is greater than maximum']);
  });

  it('bounds depth and node count, and a deep document costs no stack', () => {
    let deep: OutputSchema = { type: 'string' };
    for (let i = 0; i < OUTPUT_SCHEMA_MAX_DEPTH; i += 1) {
      deep = { type: 'object', properties: { a: deep } };
    }
    expect(issues(deep).join('\n')).toContain(`levels deep; at most ${OUTPUT_SCHEMA_MAX_DEPTH}`);

    const wide: Record<string, OutputSchema> = {};
    for (let i = 0; i < 64; i += 1) {
      wide[`p${i}`] = {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
      };
    }
    expect(issues({ type: 'object', properties: wide }).join('\n')).toContain(
      `at most ${OUTPUT_SCHEMA_MAX_NODES}`,
    );

    // 100 000 levels: refused by the iterative precheck, not by a stack overflow.
    let huge: unknown = {};
    for (let i = 0; i < 100_000; i += 1) huge = { type: 'object', items: huge };
    expect(issues(huge)).toEqual([`: nests more than ${OUTPUT_SCHEMA_MAX_DEPTH} levels deep`]);
  });
});

describe('validateOutput (S11 GO5d-1)', () => {
  it('passes an output that meets the schema', () => {
    expect(validateOutput(HOSTS, { hosts: ['a'], count: 1, mode: 'safe' })).toEqual({
      problems: [],
      problemCount: 0,
    });
  });

  it('names each place, never a value', () => {
    const result = validateOutput(HOSTS, {
      hosts: ['', 7],
      count: -1.5,
      mode: 'secret-mode-value',
      'odd key': true,
    });
    expect(result.problems).toEqual([
      { path: 'output.hosts.0', message: 'shorter than 1 characters' },
      { path: 'output.hosts.1', message: 'expected string, got integer' },
      { path: 'output.count', message: 'expected integer, got number' },
      { path: 'output.mode', message: 'must be one of ["fast","safe"]' },
      {
        path: 'output["odd key"]',
        message: 'not declared by the schema (additionalProperties is false)',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-mode-value');
  });

  it('reports a missing required field and counts past the listed problems', () => {
    expect(validateOutput(HOSTS, {}).problems).toEqual([
      { path: 'output.hosts', message: 'required, missing' },
    ]);
    const many = validateOutput(
      { type: 'object', properties: { xs: { type: 'array', items: { type: 'string' } } } },
      { xs: Array.from({ length: 30 }, () => 1) },
    );
    expect(many.problems).toHaveLength(MAX_OUTPUT_PROBLEMS);
    expect(many.problemCount).toBe(30);
  });

  it('stops past its visit bound with one problem', () => {
    const result = validateOutput(
      { type: 'object', properties: { xs: { type: 'array', items: {} } } },
      { xs: Array.from({ length: OUTPUT_VALIDATION_MAX_NODES + 5 }, () => 0) },
    );
    expect(result).toEqual({
      problems: [
        {
          path: 'output',
          message: `too large to check: more than ${OUTPUT_VALIDATION_MAX_NODES} values`,
        },
      ],
      problemCount: 1,
    });
  });

  it('does not follow __proto__ in an output to a declared property', () => {
    const output = JSON.parse('{"hosts":["a"],"__proto__":{"x":1}}');
    expect(validateOutput(HOSTS, output).problems).toEqual([
      {
        path: 'output.__proto__',
        message: 'not declared by the schema (additionalProperties is false)',
      },
    ]);
  });

  it('outputPath quotes keys that are not plain and cuts long ones', () => {
    expect(outputPath('output', 'a-b')).toBe('output.a-b');
    expect(outputPath('output', 'a b')).toBe('output["a b"]');
    expect(outputPath('output', 3)).toBe('output.3');
    expect(outputPath('output', 'k'.repeat(100))).toBe(`output["${'k'.repeat(64)}…"]`);
  });
});

describe('outputContractProblems (S11 GO5d-1)', () => {
  it('asks nothing without a schema, and an output when there is one', () => {
    expect(outputContractProblems(null, undefined).problemCount).toBe(0);
    expect(outputContractProblems(HOSTS, undefined).problems[0]?.path).toBe('output');
    expect(outputContractProblems(HOSTS, { hosts: ['a'] }).problemCount).toBe(0);
  });
});

describe('the result contract and the plan step (S11 GO5d-1)', () => {
  it('a result contract takes an object output of plain JSON, within its size', () => {
    expect(WorkerResultContractSchema.safeParse({ summary: 's', output: { a: [1] } }).success).toBe(
      true,
    );
    expect(WorkerResultContractSchema.safeParse({ summary: 's', output: [1] }).success).toBe(false);
    expect(
      WorkerResultContractSchema.safeParse({
        summary: 's',
        output: { a: 'x'.repeat(OUTPUT_MAX_CHARS) },
      }).success,
    ).toBe(false);
  });

  it('a binding fills a field by a dotted name and never a reserved one', () => {
    expect(
      StepBindingSchema.safeParse({ to: 'target.host', from: 'scan', path: 'hosts[0]' }).success,
    ).toBe(true);
    for (const to of ['hosts[0]', '.host', 'a..b', 'constructor', 'a.__proto__']) {
      expect(StepBindingSchema.safeParse({ to, from: 'scan', path: 'x' }).success, to).toBe(false);
    }
    expect(StepBindingSchema.safeParse({ to: 'a', from: 'scan', path: '  ' }).success).toBe(false);
  });

  it('a plan step carries an outputSchema and bindings', () => {
    const step = {
      key: 'apply',
      worker: { definitionId: '00000000-0000-4000-8000-000000000001', version: 1 },
      dependsOn: ['scan'],
      outputSchema: HOSTS,
      bindings: [{ to: 'host', from: 'scan', path: 'hosts[0]' }],
    };
    expect(PlanStepSchema.safeParse(step).success).toBe(true);
    expect(PlanStepSchema.safeParse({ ...step, bindings: [] }).success).toBe(false);
  });
});
