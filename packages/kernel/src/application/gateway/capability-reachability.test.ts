import { describe, expect, it } from 'vitest';
import { entryScope } from '../../governance/capability/index.js';
import type { CapabilityReachability, GateReachability } from './capability-reachability.js';
import { operationReachability } from './capability-reachability.js';

/**
 * capability-reachability.test: `operationReachability` — the per-Operation annotation
 * `find_operations` hands the entry agent (console redesign M3). The DB-backed half
 * (`computeCapabilityReachability`) is covered through `execution_readiness` in
 * `execution-readiness-handler.integration.test.ts`, and the connector-deny-list /
 * `disabled_by_platform` layer plus the observe-without-Grant rule (design doc §11 "门上的观察", D4
 * revoked 2026-09-27) through `platform-gates.integration.test.ts`'s own consistency describe block.
 * `directOperations` below stands for what `observeRefusal` (application/gates/observe-access.ts)
 * accepted — `computeCapabilityReachability` fills it by calling that predicate.
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
    disabledOperations: [],
    definitionMismatch: [],
    directOperations: ['op'],
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
  it('an observe Operation the observe predicate accepted is callable directly', () => {
    expect(operationReachability(reach([gate({ gateId: 'g' })]), 'g', 'observe', 'op')).toEqual({
      status: 'direct',
    });
  });

  // D4 revoked (2026-09-27, "只读调用不需要授权"): observation needs no Grant — an ungranted gate
  // outside the entry Handle's gate scope is still direct for its observe Operations.
  it('an observe Operation on an ungranted gate is direct — never not_granted', () => {
    const r = reach([gate({ gateId: 'g', granted: false, inEntryScope: false })]);
    expect(operationReachability(r, 'g', 'observe', 'op')).toEqual({ status: 'direct' });
  });

  it('an execute Operation is never direct — only via a Worker that may request actions', () => {
    const r = reach([gate({ gateId: 'g', workerDefinitionIds: ['w-observe'] })]);
    expect(operationReachability(r, 'g', 'execute', 'op')).toEqual({
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
    expect(operationReachability(withExecutor, 'g', 'execute', 'op')).toEqual({
      status: 'via_worker',
    });
  });

  it('names the first missing condition: exclusions refuse observation, a missing Grant only refuses execution', () => {
    const r = reach([
      gate({ gateId: 'not-granted', granted: false, inEntryScope: false }),
      gate({
        gateId: 'excluded',
        excludedByProfile: true,
        inEntryScope: false,
        directOperations: [],
      }),
      gate({ gateId: 'policy', excludedByPolicy: true, inEntryScope: false, directOperations: [] }),
    ]);
    expect(operationReachability(r, 'not-granted', 'observe', 'op')).toEqual({ status: 'direct' });
    expect(operationReachability(r, 'not-granted', 'execute', 'op')).toEqual({
      status: 'unreachable',
      reason: 'not_granted',
    });
    for (const mode of ['observe', 'execute']) {
      expect(operationReachability(r, 'excluded', mode, 'op')).toEqual({
        status: 'unreachable',
        reason: 'excluded_by_profile',
      });
      expect(operationReachability(r, 'policy', mode, 'op')).toEqual({
        status: 'unreachable',
        reason: 'excluded_by_policy',
      });
    }
  });

  it('an ungranted gate can still be excluded: observation reports the exclusion, execution the missing Grant first', () => {
    const r = reach([
      gate({
        gateId: 'g',
        granted: false,
        inEntryScope: false,
        excludedByProfile: true,
        directOperations: [],
      }),
    ]);
    expect(operationReachability(r, 'g', 'observe', 'op')).toEqual({
      status: 'unreachable',
      reason: 'excluded_by_profile',
    });
    expect(operationReachability(r, 'g', 'execute', 'op')).toEqual({
      status: 'unreachable',
      reason: 'not_granted',
    });
  });

  it('an Operation of a gate that is not registered here is unreachable, never direct', () => {
    expect(operationReachability(reach([]), 'unknown', 'observe', 'op')).toEqual({
      status: 'unreachable',
      reason: 'not_granted',
    });
  });

  // Production incident 2026-09-26: the connector deny list disables Operations by name, not whole
  // gates — a gate with one disabled Operation and one still-enabled one must report each
  // correctly, not just agree/disagree with the gate's own aggregate `status`.
  it('a platform-disabled Operation is unreachable even when the gate itself is still direct (another Operation on it is still enabled)', () => {
    const r = reach([
      gate({
        gateId: 'g',
        observeOperationCount: 2,
        disabledOperations: ['blocked_op'],
        directOperations: ['other_op'],
        status: 'direct',
      }),
    ]);
    expect(operationReachability(r, 'g', 'observe', 'blocked_op')).toEqual({
      status: 'unreachable',
      reason: 'disabled_by_platform',
    });
    expect(operationReachability(r, 'g', 'observe', 'other_op')).toEqual({ status: 'direct' });
  });

  it('a gate whose every published Operation is platform-disabled is unreachable/disabled_by_platform at the gate level too, ranked ahead of not_granted', () => {
    const r = reach([
      gate({
        gateId: 'g',
        granted: false,
        inEntryScope: false,
        observeOperationCount: 1,
        executeOperationCount: 0,
        disabledOperations: ['only_op'],
        directOperations: [],
      }),
    ]);
    expect(operationReachability(r, 'g', 'observe', 'only_op')).toEqual({
      status: 'unreachable',
      reason: 'disabled_by_platform',
    });
  });

  // Legacy K (UX acceptance of #538): the gate refuses a call made under a definition it does not
  // run, whatever else would allow it — so `find_operations` names that Operation as refused even
  // while the gate stays direct through another one, and an execute Operation is not via_worker.
  it('an Operation the gate runs another definition of is unreachable/definition_mismatch, observe or execute', () => {
    const r = reach([
      gate({
        gateId: 'g',
        directOperations: ['op'],
        definitionMismatch: [
          { operation: 'stock.get', awaiting: 'platform_adoption' },
          { operation: 'stock.set', awaiting: 'workspace_revision' },
        ],
        executeWorkerDefinitionIds: ['wd'],
      }),
    ]);
    expect(operationReachability(r, 'g', 'observe', 'stock.get')).toEqual({
      status: 'unreachable',
      reason: 'definition_mismatch',
    });
    expect(operationReachability(r, 'g', 'execute', 'stock.set')).toEqual({
      status: 'unreachable',
      reason: 'definition_mismatch',
    });
    expect(operationReachability(r, 'g', 'observe', 'op')).toEqual({ status: 'direct' });
  });
});
