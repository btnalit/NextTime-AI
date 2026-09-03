import type { CapabilityScope } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  GATEKEEPER_RESOURCE_SCOPE_KEY,
  HighBlastRadiusAutoApproveError,
  type PolicyEvaluationInput,
  assertPolicyWriteAllowed,
  evaluate,
} from './engine.js';

/**
 * governance/policy/engine.test: table-driven unit tests for `evaluate()` (design doc §5.4 I8;
 * docs/development-tasks.md S2.2 acceptance "三种判定的表驱动测试；试图为 high 开自动批准被拒"). Pure
 * — no IO, no DB, matches the module's own nature.
 */

const GATEKEEPER_ID = 'gk-1';
const OTHER_GATEKEEPER_ID = 'gk-2';

function scopeCovering(...gatekeeperIds: string[]): CapabilityScope {
  return {
    capabilities: ['request_action'],
    resources: { [GATEKEEPER_RESOURCE_SCOPE_KEY]: gatekeeperIds },
  };
}

const COVERING_SCOPE = scopeCovering(GATEKEEPER_ID);
const NON_COVERING_SCOPE = scopeCovering(OTHER_GATEKEEPER_ID);
const EMPTY_SCOPE: CapabilityScope = { capabilities: ['request_action'], resources: {} };

function baseInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    gatekeeperId: GATEKEEPER_ID,
    blastRadius: 'low',
    operationAutoApprovable: true,
    workspacePolicy: undefined,
    requesterScope: COVERING_SCOPE,
    ...overrides,
  };
}

describe('evaluate — deny (I13/coverage)', () => {
  it('denies when the requester scope does not cover the gatekeeper', () => {
    const result = evaluate(baseInput({ requesterScope: NON_COVERING_SCOPE }));
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('requester_scope_does_not_cover_gatekeeper');
  });

  it('denies when the requester scope has no resources at all', () => {
    const result = evaluate(baseInput({ requesterScope: EMPTY_SCOPE }));
    expect(result.decision).toBe('deny');
  });

  it('deny takes priority over an otherwise-auto-approvable low-blast-radius operation', () => {
    const result = evaluate(
      baseInput({
        requesterScope: NON_COVERING_SCOPE,
        blastRadius: 'low',
        operationAutoApprovable: true,
        workspacePolicy: { autoApprove: true },
      }),
    );
    expect(result.decision).toBe('deny');
  });
});

describe('evaluate — allow (I8 double signal)', () => {
  it('allows low blast radius, operation auto_approvable, no workspace row (compiled-in default)', () => {
    const result = evaluate(baseInput({ blastRadius: 'low', operationAutoApprovable: true }));
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('auto_approved_by_operation_and_low_blast_radius_default');
  });

  it('allows medium blast radius when the operation and workspace both opt in', () => {
    const result = evaluate(
      baseInput({
        blastRadius: 'medium',
        operationAutoApprovable: true,
        workspacePolicy: { autoApprove: true },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('auto_approved_by_operation_and_workspace_policy');
  });

  it('never allows high blast radius, even when both signals say yes', () => {
    const result = evaluate(
      baseInput({
        blastRadius: 'high',
        operationAutoApprovable: true,
        workspacePolicy: { autoApprove: true },
      }),
    );
    expect(result.decision).toBe('require_approval');
    expect(result.reason).toBe('blast_radius_high_requires_approval');
  });
});

describe('evaluate — require_approval (medium/high/unclassified/opted-out)', () => {
  it('requires approval for medium blast radius with no workspace policy row', () => {
    const result = evaluate(baseInput({ blastRadius: 'medium', operationAutoApprovable: true }));
    expect(result.decision).toBe('require_approval');
    expect(result.reason).toBe('no_workspace_policy_and_not_low_blast_radius');
  });

  it('requires approval for high blast radius unconditionally', () => {
    const result = evaluate(baseInput({ blastRadius: 'high', operationAutoApprovable: true }));
    expect(result.decision).toBe('require_approval');
  });

  it('requires approval for an unclassified operation (operationAutoApprovable: false) even at low blast radius', () => {
    const result = evaluate(baseInput({ blastRadius: 'low', operationAutoApprovable: false }));
    expect(result.decision).toBe('require_approval');
    expect(result.reason).toBe('operation_not_auto_approvable');
  });

  it('requires approval when a workspace row explicitly disables auto-approve at low blast radius', () => {
    const result = evaluate(
      baseInput({
        blastRadius: 'low',
        operationAutoApprovable: true,
        workspacePolicy: { autoApprove: false },
      }),
    );
    expect(result.decision).toBe('require_approval');
    expect(result.reason).toBe('workspace_policy_disables_auto_approve');
  });
});

describe('evaluate — requesterCanApprove (§5.8)', () => {
  it('defaults to false at high blast radius', () => {
    const result = evaluate(baseInput({ blastRadius: 'high' }));
    expect(result.requesterCanApprove).toBe(false);
  });

  it('defaults to true at low/medium blast radius', () => {
    expect(evaluate(baseInput({ blastRadius: 'low' })).requesterCanApprove).toBe(true);
    expect(evaluate(baseInput({ blastRadius: 'medium' })).requesterCanApprove).toBe(true);
  });

  it('a workspace override can allow requester-approval at high blast radius', () => {
    const result = evaluate(
      baseInput({
        blastRadius: 'high',
        workspacePolicy: { autoApprove: false, requesterCanApprove: true },
      }),
    );
    expect(result.requesterCanApprove).toBe(true);
  });

  it('a workspace override can disallow requester-approval at low blast radius', () => {
    const result = evaluate(
      baseInput({
        blastRadius: 'low',
        workspacePolicy: { autoApprove: true, requesterCanApprove: false },
      }),
    );
    expect(result.requesterCanApprove).toBe(false);
  });

  it('null workspace requesterCanApprove falls back to the blast-radius default (not treated as false)', () => {
    const result = evaluate(
      baseInput({
        blastRadius: 'high',
        workspacePolicy: { autoApprove: false, requesterCanApprove: null },
      }),
    );
    expect(result.requesterCanApprove).toBe(false);
  });
});

describe('assertPolicyWriteAllowed — S2.2 acceptance "试图为 high 开自动批准被拒"', () => {
  it('throws HighBlastRadiusAutoApproveError for high + autoApprove:true', () => {
    expect(() =>
      assertPolicyWriteAllowed({
        actionKind: 'docker.compose_up',
        blastRadius: 'high',
        autoApprove: true,
      }),
    ).toThrow(HighBlastRadiusAutoApproveError);
  });

  it('allows high + autoApprove:false', () => {
    expect(() =>
      assertPolicyWriteAllowed({
        actionKind: 'docker.compose_up',
        blastRadius: 'high',
        autoApprove: false,
      }),
    ).not.toThrow();
  });

  it('allows low/medium + autoApprove:true', () => {
    expect(() =>
      assertPolicyWriteAllowed({ actionKind: 'k', blastRadius: 'low', autoApprove: true }),
    ).not.toThrow();
    expect(() =>
      assertPolicyWriteAllowed({ actionKind: 'k', blastRadius: 'medium', autoApprove: true }),
    ).not.toThrow();
  });

  it('allows autoApprove:true when blastRadius is undefined (unknown to this write)', () => {
    expect(() =>
      assertPolicyWriteAllowed({ actionKind: 'k', blastRadius: undefined, autoApprove: true }),
    ).not.toThrow();
  });
});
