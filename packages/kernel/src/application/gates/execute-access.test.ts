import { describe, expect, it } from 'vitest';
import type { AgentPolicyRow, AgentProfileRow } from '../../governance/agent-profile/index.js';
import { defaultAgentPolicy } from '../../governance/agent-profile/index.js';
import {
  type ExecuteAccess,
  entryGatekeeperIds,
  executableGatekeepers,
  narrowScopeToExecutableGates,
} from './execute-access.js';

/** Pure half of R-37 / D-20 (application/gates/execute-access.ts). */

function profile(excludedGatekeepers: readonly string[]): AgentProfileRow {
  return {
    workspaceId: 'ws',
    principalId: 'p',
    model: null,
    excludedSkills: [],
    excludedGatekeepers,
    excludedWorkerDefinitions: [],
    promptAddendum: null,
    autoApproveLow: null,
    updatedBy: null,
    updatedAt: null,
  };
}

function policy(allowedGatekeepers: readonly string[] = []): AgentPolicyRow {
  return { ...defaultAgentPolicy('ws'), allowedGatekeepers };
}

function access(overrides: Partial<ExecuteAccess> = {}): ExecuteAccess {
  return {
    role: 'member',
    profile: undefined,
    policy: policy(),
    grantedGatekeeperIds: ['g1', 'g2'],
    ...overrides,
  };
}

describe('executableGatekeepers', () => {
  it('a member keeps only the Handle gates still in effective.enabledGatekeepers', () => {
    expect(executableGatekeepers(access(), ['g1', 'g2', 'g3'])).toEqual(['g1', 'g2']);
    expect(executableGatekeepers(access({ profile: profile(['g1']) }), ['g1', 'g2'])).toEqual([
      'g2',
    ]);
    expect(executableGatekeepers(access({ policy: policy(['g2']) }), ['g1', 'g2'])).toEqual(['g2']);
    expect(executableGatekeepers(access({ grantedGatekeeperIds: [] }), ['g1'])).toEqual([]);
  });

  it('an owner keeps the Handle’s own gates (every scope) minus the AgentPolicy cap and their own exclusions', () => {
    const owner = access({ role: 'owner', grantedGatekeeperIds: [] });
    expect(executableGatekeepers(owner, ['g1', 'g9'])).toEqual(['g1', 'g9']);
    expect(executableGatekeepers({ ...owner, profile: profile(['g9']) }, ['g1', 'g9'])).toEqual([
      'g1',
    ]);
    expect(executableGatekeepers({ ...owner, policy: policy(['g1']) }, ['g1', 'g9'])).toEqual([
      'g1',
    ]);
  });

  it('never adds a gate the Handle does not carry', () => {
    expect(executableGatekeepers(access({ role: 'owner' }), [])).toEqual([]);
    expect(executableGatekeepers(access(), ['g2'])).toEqual(['g2']);
  });
});

describe('entryGatekeeperIds', () => {
  it('is effective.enabledGatekeepers — Grants minus exclusions, capped — for every role', () => {
    expect(entryGatekeeperIds(access({ profile: profile(['g2']) }))).toEqual(['g1']);
    expect(entryGatekeeperIds(access({ role: 'owner', policy: policy(['g2']) }))).toEqual(['g2']);
  });
});

describe('narrowScopeToExecutableGates', () => {
  it('narrows only resources.gatekeeper and drops the key when nothing is left', () => {
    const scope = {
      capabilities: ['request_action'],
      resources: { gatekeeper: ['g1', 'g3'], other: ['x'] },
    };
    expect(narrowScopeToExecutableGates(scope, access())).toEqual({
      capabilities: ['request_action'],
      resources: { gatekeeper: ['g1'], other: ['x'] },
    });
    expect(narrowScopeToExecutableGates(scope, access({ grantedGatekeeperIds: [] }))).toEqual({
      capabilities: ['request_action'],
      resources: { other: ['x'] },
    });
  });

  it('leaves a scope with no gatekeeper key as it is', () => {
    const scope = { capabilities: ['observe_operation'], resources: {} };
    expect(narrowScopeToExecutableGates(scope, access())).toBe(scope);
  });
});
