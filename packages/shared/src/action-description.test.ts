import { describe, expect, it } from 'vitest';
import { ActionDescriptionSchema, OperationSchema } from './action-description.js';
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
