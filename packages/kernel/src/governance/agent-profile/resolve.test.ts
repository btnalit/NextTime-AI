import { describe, expect, it } from 'vitest';
import { resolveEffectiveAgentProfile } from './resolve.js';
import { defaultAgentPolicy } from './store.js';
import type { AgentPolicyRow, AgentProfileRow } from './types.js';

const WORKSPACE_ID = 'ws-1';
const PRINCIPAL_ID = 'pr-1';

function profile(overrides: Partial<AgentProfileRow> = {}): AgentProfileRow {
  return {
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    model: null,
    enabledSkills: null,
    enabledGatekeepers: null,
    enabledWorkerDefinitions: null,
    promptAddendum: null,
    autoApproveLow: null,
    updatedBy: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function policy(overrides: Partial<AgentPolicyRow> = {}): AgentPolicyRow {
  return { ...defaultAgentPolicy(WORKSPACE_ID), ...overrides };
}

describe('governance/agent-profile/resolve: resolveEffectiveAgentProfile', () => {
  it('resolves every field to the compiled-in defaults when there is no profile row and no policy row', () => {
    const effective = resolveEffectiveAgentProfile(undefined, policy());
    expect(effective).toEqual({
      model: null,
      enabledSkills: null,
      enabledGatekeepers: null,
      enabledWorkerDefinitions: null,
      promptAddendum: null,
      autoApproveLow: false,
    });
  });

  it('model: profile.model wins when set', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ model: 'anthropic/claude-sonnet' }),
      policy({ defaultModel: 'anthropic/claude-haiku' }),
    );
    expect(effective.model).toBe('anthropic/claude-sonnet');
  });

  it('model: policy.defaultModel applies when profile.model is null (inherit)', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ model: null }),
      policy({ defaultModel: 'anthropic/claude-haiku' }),
    );
    expect(effective.model).toBe('anthropic/claude-haiku');
  });

  it('model: null when neither the profile nor the policy sets one', () => {
    const effective = resolveEffectiveAgentProfile(profile({ model: null }), policy());
    expect(effective.model).toBeNull();
  });

  it('enabledGatekeepers: null (no restriction) when the profile is null and the policy has no cap', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: null }),
      policy({ allowedGatekeepers: [] }),
    );
    expect(effective.enabledGatekeepers).toBeNull();
  });

  it('enabledGatekeepers: an explicit profile list passes through unchanged when the policy has no cap', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: ['gk-1', 'gk-2'] }),
      policy({ allowedGatekeepers: [] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1', 'gk-2']);
  });

  it('enabledGatekeepers: a policy cap becomes the effective list when the profile is null', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: null }),
      policy({ allowedGatekeepers: ['gk-1', 'gk-2'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1', 'gk-2']);
  });

  it('enabledGatekeepers: a policy cap narrows an explicit profile list to the intersection — never widens', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: ['gk-1', 'gk-2', 'gk-3'] }),
      policy({ allowedGatekeepers: ['gk-2', 'gk-3', 'gk-4'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-2', 'gk-3']);
  });

  it('enabledGatekeepers: intersection can be empty when the profile and the cap share nothing', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: ['gk-1'] }),
      policy({ allowedGatekeepers: ['gk-2'] }),
    );
    expect(effective.enabledGatekeepers).toEqual([]);
  });

  it('enabledSkills: follows the identical cap/inherit rule as enabledGatekeepers', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledSkills: ['skill-a', 'skill-b'] }),
      policy({ allowedSkills: ['skill-b'] }),
    );
    expect(effective.enabledSkills).toEqual(['skill-b']);
  });

  it('enabledWorkerDefinitions: passes through the raw profile value — no policy cap exists for it', () => {
    const withValue = resolveEffectiveAgentProfile(
      profile({ enabledWorkerDefinitions: ['def-1'] }),
      policy(),
    );
    expect(withValue.enabledWorkerDefinitions).toEqual(['def-1']);

    const withNull = resolveEffectiveAgentProfile(
      profile({ enabledWorkerDefinitions: null }),
      policy(),
    );
    expect(withNull.enabledWorkerDefinitions).toBeNull();
  });

  it('promptAddendum: profile value passes through; null when the profile has none', () => {
    const withValue = resolveEffectiveAgentProfile(
      profile({ promptAddendum: 'Prefer concise answers.' }),
      policy(),
    );
    expect(withValue.promptAddendum).toBe('Prefer concise answers.');

    const withNull = resolveEffectiveAgentProfile(profile({ promptAddendum: null }), policy());
    expect(withNull.promptAddendum).toBeNull();
  });

  it('autoApproveLow: profile true overrides a workspace default of false', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ autoApproveLow: true }),
      policy({ allowMemberAutoApproveLow: false }),
    );
    expect(effective.autoApproveLow).toBe(true);
  });

  it('autoApproveLow: profile false narrows a workspace default of true (never widens)', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ autoApproveLow: false }),
      policy({ allowMemberAutoApproveLow: true }),
    );
    expect(effective.autoApproveLow).toBe(false);
  });

  it('autoApproveLow: inherits the workspace default when the profile is null', () => {
    const inheritsTrue = resolveEffectiveAgentProfile(
      profile({ autoApproveLow: null }),
      policy({ allowMemberAutoApproveLow: true }),
    );
    expect(inheritsTrue.autoApproveLow).toBe(true);

    const inheritsFalse = resolveEffectiveAgentProfile(
      profile({ autoApproveLow: null }),
      policy({ allowMemberAutoApproveLow: false }),
    );
    expect(inheritsFalse.autoApproveLow).toBe(false);
  });
});
