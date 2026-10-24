import { describe, expect, it } from 'vitest';
import {
  ActionDescriptionSchema,
  GateAbsenceSchema,
  OPERATION_NAME_MAX,
  OperationSchema,
  isDeclaredAbsence,
  operationAbsentAnswers,
  operationNameProblem,
} from './action-description.js';
import type { ActionDescription, Operation } from './action-description.js';

describe('ActionDescriptionSchema', () => {
  const full: ActionDescription = {
    title: 'Restart container',
    description: '**Restarts** the `web` container; effect is simulated first.',
    implementsRevert: false,
    awaitDecision: false,
    autoApprovable: false,
    actionKind: { tag: 'docker.container_restart', label: 'Restart container' },
  };

  it('round-trips the full shape', () => {
    expect(ActionDescriptionSchema.parse(full)).toEqual(full);
  });

  it('accepts awaitDecision/autoApprovable omitted (optional)', () => {
    const { awaitDecision, autoApprovable, ...minimal } = full;
    expect(ActionDescriptionSchema.parse(minimal)).toEqual(minimal);
  });

  it('requires actionKind', () => {
    const { actionKind, ...withoutActionKind } = full;
    expect(() => ActionDescriptionSchema.parse(withoutActionKind)).toThrow();
  });

  it('requires actionKind.tag and actionKind.label', () => {
    expect(() =>
      ActionDescriptionSchema.parse({ ...full, actionKind: { tag: 'docker.container_restart' } }),
    ).toThrow();
  });

  it('requires title, description, implementsRevert', () => {
    const { title, ...withoutTitle } = full;
    expect(() => ActionDescriptionSchema.parse(withoutTitle)).toThrow();
    const { description, ...withoutDescription } = full;
    expect(() => ActionDescriptionSchema.parse(withoutDescription)).toThrow();
    const { implementsRevert, ...withoutImplementsRevert } = full;
    expect(() => ActionDescriptionSchema.parse(withoutImplementsRevert)).toThrow();
  });
});

describe('OperationSchema', () => {
  const httpOperation: Operation = {
    name: 'stock.get',
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: { type: 'object', properties: { sku: { type: 'string' } } },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: true,
    auto_approvable: true,
    await_decision: false,
    reads: ['Stock'],
    writes: [],
  };

  const cliOperation: Operation = {
    name: 'container.restart',
    binding: { kind: 'cli', command_template: 'docker restart {{container}}' },
    params_schema: { type: 'object', properties: { container: { type: 'string' } } },
    mode: 'execute',
    blast_radius: 'medium',
    reversibility: false,
    auto_approvable: false,
    await_decision: false,
    reads: ['Container'],
    writes: ['Container'],
    result_mapping: {
      jmes_path: 'container',
      object_type: 'Container',
      identity_keys: ['name'],
      attributes: { status: 'status' },
    },
  };

  const mcpOperation: Operation = {
    name: 'kb.retrieve',
    binding: { kind: 'mcp', tool_name: 'retrieve' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: true,
    auto_approvable: true,
    await_decision: false,
    reads: ['Document'],
    writes: [],
  };

  const sshOperation: Operation = {
    name: 'routeros.print',
    binding: { kind: 'ssh', command_pattern: '^/ip firewall .* print$' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: true,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  };

  it.each([
    ['http', httpOperation],
    ['cli', cliOperation],
    ['mcp', mcpOperation],
    ['ssh', sshOperation],
  ])('round-trips a %s-bound Operation', (_kind, operation) => {
    expect(OperationSchema.parse(operation)).toEqual(operation);
  });

  it('rejects an unknown binding kind', () => {
    expect(() =>
      OperationSchema.parse({ ...httpOperation, binding: { kind: 'db', query: 'select 1' } }),
    ).toThrow();
  });

  it('rejects an ssh binding with neither command_template nor command_pattern', () => {
    expect(() => OperationSchema.parse({ ...sshOperation, binding: { kind: 'ssh' } })).toThrow();
  });

  it('rejects an invalid mode or blast_radius', () => {
    expect(() => OperationSchema.parse({ ...httpOperation, mode: 'delete' })).toThrow();
    expect(() => OperationSchema.parse({ ...httpOperation, blast_radius: 'extreme' })).toThrow();
  });

  it('requires reads and writes arrays (possibly empty)', () => {
    const { reads, ...withoutReads } = httpOperation;
    expect(() => OperationSchema.parse(withoutReads)).toThrow();
  });
});

describe('operationNameProblem (legacy 232)', () => {
  it('accepts an ordinary name, spaces and non-Latin letters included', () => {
    expect(operationNameProblem('inventory.list_items')).toBeUndefined();
    expect(operationNameProblem('库存 查询')).toBeUndefined();
    expect(operationNameProblem('x'.repeat(OPERATION_NAME_MAX))).toBeUndefined();
  });

  it('refuses an empty, an over-long, and an invisible-or-reordering name', () => {
    expect(operationNameProblem('  ')).toBe('empty');
    expect(operationNameProblem('x'.repeat(OPERATION_NAME_MAX + 1))).toBe('too_long');
    for (const name of [
      'delete‮toor', // right-to-left override
      'approve​me', // zero-width space
      'a⁦b', // left-to-right isolate
      'line\nbreak',
      'tab\there',
      'para sep',
      'lone\uD800surrogate',
    ]) {
      expect(operationNameProblem(name)).toBe('invisible_or_control_characters');
    }
  });
});

describe('absence declarations (S11 「门确认不存在」 A)', () => {
  const observeHttp: Operation = {
    name: 'record.get',
    binding: { kind: 'http', method: 'GET', path: '/records/{id}', absent_statuses: [404] },
    params_schema: { type: 'object' },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: true,
    auto_approvable: true,
    await_decision: false,
    reads: ['Record'],
    writes: [],
  };
  const observeCli: Operation = {
    ...observeHttp,
    name: 'unit.show',
    binding: { kind: 'cli', command_template: 'unitctl show {{name}}', absent_exit_codes: [4] },
  };
  const observeSsh: Operation = {
    ...observeHttp,
    name: 'file.stat',
    binding: { kind: 'ssh', command_template: 'stat {{path}}', absent_exit_codes: [1] },
  };

  it('parses a declaration on http, cli and ssh bindings and keeps it', () => {
    expect(OperationSchema.parse(observeHttp).binding).toMatchObject({ absent_statuses: [404] });
    expect(OperationSchema.parse(observeCli).binding).toMatchObject({ absent_exit_codes: [4] });
    expect(OperationSchema.parse(observeSsh).binding).toMatchObject({ absent_exit_codes: [1] });
    expect(
      OperationSchema.parse({
        ...observeHttp,
        binding: { ...observeHttp.binding, absent_statuses: [404, 410] },
      }).binding,
    ).toMatchObject({ absent_statuses: [404, 410] });
  });

  it('refuses statuses other than 404 / 410, exit statuses outside 1–125, empty and repeated lists', () => {
    for (const absent_statuses of [[200], [400], [403], [500], [], [404, 404]]) {
      expect(() =>
        OperationSchema.parse({
          ...observeHttp,
          binding: { kind: 'http', method: 'GET', path: '/x', absent_statuses },
        }),
      ).toThrow();
    }
    for (const absent_exit_codes of [[0], [126], [127], [130], [255], [-1], [1.5], [], [2, 2]]) {
      expect(() =>
        OperationSchema.parse({
          ...observeCli,
          binding: { kind: 'cli', command_template: 'x', absent_exit_codes },
        }),
      ).toThrow();
      expect(() =>
        OperationSchema.parse({
          ...observeSsh,
          binding: { kind: 'ssh', command_template: 'x', absent_exit_codes },
        }),
      ).toThrow();
    }
    expect(() =>
      OperationSchema.parse({
        ...observeCli,
        binding: {
          kind: 'cli',
          command_template: 'x',
          absent_exit_codes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        },
      }),
    ).toThrow();
  });

  it('refuses a declaration on an execute-class Operation, where it would never act (review #501 on #753)', () => {
    for (const declared of [observeHttp, observeCli, observeSsh]) {
      const result = OperationSchema.safeParse({ ...declared, mode: 'execute' });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([
        'binding',
        declared.binding.kind === 'http' ? 'absent_statuses' : 'absent_exit_codes',
      ]);
    }
    // Without a declaration an execute-class Operation parses as before.
    expect(
      OperationSchema.safeParse({
        ...observeHttp,
        mode: 'execute',
        binding: { kind: 'http', method: 'POST', path: '/records' },
      }).success,
    ).toBe(true);
  });

  it('reads a declaration only on an observe-class Operation', () => {
    expect(operationAbsentAnswers(observeHttp)).toEqual({ statuses: [404] });
    expect(operationAbsentAnswers(observeCli)).toEqual({ exitCodes: [4] });
    expect(operationAbsentAnswers(observeSsh)).toEqual({ exitCodes: [1] });
    expect(operationAbsentAnswers({ ...observeHttp, mode: 'execute' })).toBeUndefined();
    expect(
      operationAbsentAnswers({
        ...observeHttp,
        binding: { kind: 'http', method: 'GET', path: '/x' },
      }),
    ).toBeUndefined();
    expect(
      operationAbsentAnswers({ ...observeHttp, binding: { kind: 'mcp', tool_name: 'get' } }),
    ).toBeUndefined();
  });

  it('counts an answer as absent only when the Operation declares that very answer', () => {
    expect(isDeclaredAbsence(observeHttp, { status: 404 })).toBe(true);
    expect(isDeclaredAbsence(observeHttp, { status: 410 })).toBe(false);
    expect(isDeclaredAbsence(observeHttp, { exitCode: 404 })).toBe(false);
    expect(isDeclaredAbsence(observeCli, { exitCode: 4 })).toBe(true);
    expect(isDeclaredAbsence(observeCli, { exitCode: 1 })).toBe(false);
    expect(isDeclaredAbsence(observeCli, { status: 4 })).toBe(false);
    expect(isDeclaredAbsence({ ...observeCli, mode: 'execute' }, { exitCode: 4 })).toBe(false);
  });

  it('GateAbsenceSchema takes exactly one of status / exitCode and nothing else', () => {
    expect(GateAbsenceSchema.safeParse({ status: 404 }).success).toBe(true);
    expect(GateAbsenceSchema.safeParse({ exitCode: 4 }).success).toBe(true);
    expect(GateAbsenceSchema.safeParse({ status: 404, exitCode: 4 }).success).toBe(false);
    expect(GateAbsenceSchema.safeParse({ status: '404' }).success).toBe(false);
    expect(GateAbsenceSchema.safeParse({ status: 404, note: 'x' }).success).toBe(false);
    expect(GateAbsenceSchema.safeParse({}).success).toBe(false);
  });
});
