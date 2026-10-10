import { operationDefinitionDigest } from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  definitionRefusal,
  gateRunningDefinitions,
  operationsRefusedUntilAdopted,
} from './definition-drift.js';

/**
 * definition-drift.test (legacy K, UX acceptance of #538): the one derivation of "the gate refuses
 * this call, and whose step ends it". The DB-backed readers are covered through
 * `platform-gates.integration.test.ts`'s legacy K case.
 */

const STOCK: Operation = {
  name: 'stock.get',
  binding: { kind: 'http', method: 'GET', path: '/stock' },
  params_schema: { type: 'object', properties: {} },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};
const STOCK_V2: Operation = {
  ...STOCK,
  params_schema: {
    type: 'object',
    properties: { warehouse: { type: 'string', 'x-in': 'query' } },
  },
};
const ORDER: Operation = {
  ...STOCK,
  name: 'order.list',
  binding: { kind: 'http', method: 'GET', path: '/orders' },
};

const digest = (operation: Operation) => operationDefinitionDigest(operation);

describe('definition drift', () => {
  it('nothing held and the workspace published what the gate runs: no refusal', () => {
    const defs = gateRunningDefinitions({ operations: [STOCK, ORDER], pending_operations: null });
    expect(definitionRefusal(defs, STOCK.name, digest(STOCK))).toBeNull();
    expect(operationsRefusedUntilAdopted(defs)).toEqual([]);
  });

  it('a held announcement that redefines an Operation: refused until the platform adopts it', () => {
    const defs = gateRunningDefinitions({
      operations: [STOCK, ORDER],
      pending_operations: [STOCK_V2, ORDER],
    });
    expect(definitionRefusal(defs, STOCK.name, digest(STOCK))).toBe('platform_adoption');
    // An Operation the announcement leaves alone keeps running.
    expect(definitionRefusal(defs, ORDER.name, digest(ORDER))).toBeNull();
    expect(operationsRefusedUntilAdopted(defs)).toEqual([STOCK.name]);
  });

  it('adopted but not yet revised in the workspace: refused until the workspace publishes the revision', () => {
    const defs = gateRunningDefinitions({ operations: [STOCK_V2], pending_operations: null });
    expect(definitionRefusal(defs, STOCK.name, digest(STOCK))).toBe('workspace_revision');
    expect(definitionRefusal(defs, STOCK.name, digest(STOCK_V2))).toBeNull();
    expect(operationsRefusedUntilAdopted(defs)).toEqual([]);
  });

  it('a workspace definition that does not parse is refused; publishing a revision is the step', () => {
    const defs = gateRunningDefinitions({ operations: [STOCK], pending_operations: null });
    expect(definitionRefusal(defs, STOCK.name, null)).toBe('workspace_revision');
  });

  it('a held announcement dropping an Operation counts as awaiting adoption; one the gate never had does not', () => {
    const defs = gateRunningDefinitions({
      operations: [STOCK, ORDER],
      pending_operations: [ORDER],
    });
    expect(definitionRefusal(defs, STOCK.name, digest(STOCK))).toBe('platform_adoption');
    expect(operationsRefusedUntilAdopted(defs)).toEqual([STOCK.name]);
    expect(definitionRefusal(defs, 'never.announced', digest(STOCK))).toBeNull();
  });

  it('a governance-only held change (description, auto_approvable) refuses nothing', () => {
    const defs = gateRunningDefinitions({
      operations: [STOCK],
      pending_operations: [{ ...STOCK, auto_approvable: false, description: 'Reads stock.' }],
    });
    expect(defs.pending).toBe(true);
    expect(definitionRefusal(defs, STOCK.name, digest(STOCK))).toBeNull();
    expect(operationsRefusedUntilAdopted(defs)).toEqual([]);
  });

  it('a stored entry that is not an Operation defines nothing', () => {
    const defs = gateRunningDefinitions({
      operations: [STOCK, { name: 'broken' }, 'junk'],
      pending_operations: null,
    });
    expect([...defs.running.keys()]).toEqual([STOCK.name]);
  });
});
