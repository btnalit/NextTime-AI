import { describe, expect, it } from 'vitest';
import type { AgentPolicyRow } from '../../governance/agent-profile/index.js';
import {
  NO_OBSERVE_EXCLUSIONS,
  type ObserveTarget,
  observeExclusionsOf,
  observeGateExclusion,
  observeRefusal,
} from './observe-access.js';
import type { GateLinkPolicyView } from './store.js';

/**
 * application/gates/observe-access.test: pure unit tests for the one observe predicate (design doc
 * §11 "门上的观察", decision D4 revoked 2026-09-27 — "只读调用不需要授权"). The DB-backed agreement
 * between it, enforcement and every read model is pinned by the integration suites
 * (`request-action.integration.test.ts`, `platform-gates.integration.test.ts`,
 * `find-procedures.integration.test.ts`).
 */

const GATE = 'gate-1';

function target(overrides: Partial<ObserveTarget> = {}): ObserveTarget {
  return {
    gatekeeperId: GATE,
    gateEnabled: true,
    operationName: 'items.list',
    publishedMode: 'observe',
    gateLink: null,
    ...overrides,
  };
}

function link(disabledOperations: readonly string[]): GateLinkPolicyView {
  return {
    gateId: 'platform-gate',
    connector: 'fixture',
    trust: 'vetted',
    instanceStatus: 'enabled',
    disabledOperations: [...disabledOperations],
  };
}

function policy(allowedGatekeepers: readonly string[]): AgentPolicyRow {
  return {
    workspaceId: 'ws',
    allowedModels: [],
    defaultModel: null,
    memberCanEditProfile: true,
    maxPromptAddendumChars: 2000,
    allowedSkills: [],
    allowedGatekeepers,
    allowMemberAutoApproveLow: false,
    updatedBy: null,
    updatedAt: null,
  };
}

describe('observeRefusal', () => {
  it('accepts a published observe-class Operation on an enabled gate with no Grant input at all', () => {
    // There is no Grant / resources.gatekeeper parameter to pass — that is the rule.
    expect(observeRefusal(NO_OBSERVE_EXCLUSIONS, target())).toBeUndefined();
  });

  it('refuses in enforcement order: gate → platform deny list → published → observe-class → exclusions', () => {
    const excluded = { policyAllowedGatekeepers: [], profileExcludedGatekeepers: [GATE] };
    expect(
      observeRefusal(
        excluded,
        target({ gateEnabled: false, gateLink: link(['items.list']), publishedMode: undefined }),
      ),
    ).toEqual({ reason: 'gate_not_enabled' });
    expect(
      observeRefusal(
        excluded,
        target({ gateLink: link(['items.list']), publishedMode: undefined }),
      ),
    ).toEqual({ reason: 'disabled_by_platform', connector: 'fixture' });
    expect(observeRefusal(excluded, target({ publishedMode: undefined }))).toEqual({
      reason: 'no_published_operation',
    });
    expect(observeRefusal(excluded, target({ publishedMode: 'execute' }))).toEqual({
      reason: 'not_observe_class',
      mode: 'execute',
    });
    expect(observeRefusal(excluded, target())).toEqual({ reason: 'excluded_by_profile' });
  });

  it('a deny list naming another Operation does not refuse this one', () => {
    expect(
      observeRefusal(NO_OBSERVE_EXCLUSIONS, target({ gateLink: link(['items.delete']) })),
    ).toBeUndefined();
  });
});

describe('observeGateExclusion', () => {
  it('the AgentPolicy cap leaves out every gate it does not name; [] means no cap', () => {
    expect(observeGateExclusion(observeExclusionsOf(undefined, policy(['other'])), GATE)).toBe(
      'excluded_by_policy',
    );
    expect(
      observeGateExclusion(observeExclusionsOf(undefined, policy([GATE])), GATE),
    ).toBeUndefined();
    expect(observeGateExclusion(observeExclusionsOf(undefined, policy([])), GATE)).toBeUndefined();
  });

  it('the member’s own AgentProfile exclusion applies whether or not the gate was ever granted; the policy cap is reported first', () => {
    const profile = {
      workspaceId: 'ws',
      principalId: 'p',
      model: null,
      excludedSkills: [],
      excludedGatekeepers: [GATE],
      excludedWorkerDefinitions: [],
      promptAddendum: null,
      autoApproveLow: null,
      updatedBy: null,
      updatedAt: null,
    };
    expect(observeGateExclusion(observeExclusionsOf(profile, policy([])), GATE)).toBe(
      'excluded_by_profile',
    );
    expect(observeGateExclusion(observeExclusionsOf(profile, policy(['other'])), GATE)).toBe(
      'excluded_by_policy',
    );
  });
});
