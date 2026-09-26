import { describe, expect, it } from 'vitest';
import { entryScope } from '../../governance/capability/index.js';
import type { CapabilityReachability, GateReachability } from './capability-reachability.js';
import { operationReachability } from './capability-reachability.js';

/**
 * capability-reachability.test: `operationReachability` — the per-Operation annotation
 * `find_operations` hands the entry agent (console redesign M3). The DB-backed half
 * (`computeCapabilityReachability`) is covered through `execution_readiness` in
 * `execution-readiness-handler.integration.test.ts`.
 */

function gate(
  overrides: Partial<GateReachability> & Pick<GateReachability, 'gateId'>,
): GateReachability {
  return {
    name: overrides.gateId,
    granted: true,
    excludedByPolicy: false,
    excludedByProfile: false,
    inEntryScope: true,
    observeOperationCount: 1,
    executeOperationCount: 1,
    workerDefinitionIds: [],
    executeWorkerDefinitionIds: [],
    status: 'direct',
    ...overrides,
  };
}

function reach(gates: readonly GateReachability[]): CapabilityReachability {
  return {
    role: 'member',
    parentAuthority: entryScope({}, { role: 'member' }),
    entryGatekeeperIds: gates.filter((g) => g.inEntryScope).map((g) => g.gateId),
    grantedGatekeeperIds: gates.filter((g) => g.granted).map((g) => g.gateId),
    gates,
    workers: [],
  };
}

describe('operationReachability', () => {
  it('an observe Operation on a gate in the entry scope is callable directly', () => {
    expect(operationReachability(reach([gate({ gateId: 'g' })]), 'g', 'observe')).toEqual({
      status: 'direct',
    });
  });

  it('an execute Operation is never direct — only via a Worker that may request actions', () => {
    const r = reach([gate({ gateId: 'g', workerDefinitionIds: ['w-observe'] })]);
    expect(operationReachability(r, 'g', 'execute')).toEqual({
      status: 'unreachable',
      reason: 'no_worker',
    });
    const withExecutor = reach([
      gate({
        gateId: 'g',
        workerDefinitionIds: ['w-exec'],
        executeWorkerDefinitionIds: ['w-exec'],
      }),
    ]);
    expect(operationReachability(withExecutor, 'g', 'execute')).toEqual({ status: 'via_worker' });
  });

  it('names the first missing condition for a gate the agent cannot reach', () => {
    const r = reach([
      gate({ gateId: 'not-granted', granted: false, inEntryScope: false }),
      gate({ gateId: 'excluded', excludedByProfile: true, inEntryScope: false }),
      gate({ gateId: 'policy', excludedByPolicy: true, inEntryScope: false }),
    ]);
    expect(operationReachability(r, 'not-granted', 'observe')).toEqual({
      status: 'unreachable',
      reason: 'not_granted',
    });
    expect(operationReachability(r, 'excluded', 'observe')).toEqual({
      status: 'unreachable',
      reason: 'excluded_by_profile',
    });
    expect(operationReachability(r, 'policy', 'observe')).toEqual({
      status: 'unreachable',
      reason: 'excluded_by_policy',
    });
  });

  it('an Operation of a gate that is not registered here is unreachable, never direct', () => {
    expect(operationReachability(reach([]), 'unknown', 'observe')).toEqual({
      status: 'unreachable',
      reason: 'not_granted',
    });
  });
});
