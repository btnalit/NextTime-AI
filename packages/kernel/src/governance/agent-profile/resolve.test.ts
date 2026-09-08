import { describe, expect, it } from 'vitest';
import { NO_AVAILABLE_AGENT_RESOURCES, resolveEffectiveAgentProfile } from './resolve.js';
import type { AvailableAgentResources } from './resolve.js';
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

function available(overrides: Partial<AvailableAgentResources> = {}): AvailableAgentResources {
  return { ...NO_AVAILABLE_AGENT_RESOURCES, ...overrides };
}

describe('governance/agent-profile/resolve: resolveEffectiveAgentProfile', () => {
  it('resolves every field to a concrete "nothing configured" value when there is no profile row, no policy row, and nothing available', () => {
    const effective = resolveEffectiveAgentProfile(undefined, policy(), available());
    expect(effective).toEqual({
      model: '',
      enabledSkills: [],
      enabledGatekeepers: [],
      enabledWorkerDefinitions: [],
      promptAddendum: '',
      autoApproveLow: false,
    });
  });

  it('model: profile.model wins when set', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ model: 'anthropic/claude-sonnet' }),
      policy({ defaultModel: 'anthropic/claude-haiku' }),
      available(),
    );
    expect(effective.model).toBe('anthropic/claude-sonnet');
  });

  it('model: policy.defaultModel applies when profile.model is null (inherit)', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ model: null }),
      policy({ defaultModel: 'anthropic/claude-haiku' }),
      available(),
    );
    expect(effective.model).toBe('anthropic/claude-haiku');
  });

  it('model: empty string when neither the profile nor the policy sets one', () => {
    const effective = resolveEffectiveAgentProfile(profile({ model: null }), policy(), available());
    expect(effective.model).toBe('');
  });

  it('enabledGatekeepers: null (inherit) resolves to every currently-available (granted) id, not an empty list', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: null }),
      policy({ allowedGatekeepers: [] }),
      available({ grantedGatekeeperIds: ['gk-1', 'gk-2'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1', 'gk-2']);
  });

  it('enabledGatekeepers: an explicit empty list means "nothing" — genuinely different from null', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: [] }),
      policy({ allowedGatekeepers: [] }),
      available({ grantedGatekeeperIds: ['gk-1', 'gk-2'] }),
    );
    expect(effective.enabledGatekeepers).toEqual([]);
  });

  it('enabledGatekeepers: an explicit profile list passes through unchanged when the policy has no cap', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: ['gk-1', 'gk-2'] }),
      policy({ allowedGatekeepers: [] }),
      available({ grantedGatekeeperIds: ['gk-1', 'gk-2', 'gk-3'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1', 'gk-2']);
  });

  it('enabledGatekeepers: a policy cap narrows the "everything available" inherited set', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: null }),
      policy({ allowedGatekeepers: ['gk-1'] }),
      available({ grantedGatekeeperIds: ['gk-1', 'gk-2'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1']);
  });

  it('enabledGatekeepers: a policy cap narrows an explicit profile list to the intersection — never widens', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: ['gk-1', 'gk-2', 'gk-3'] }),
      policy({ allowedGatekeepers: ['gk-2', 'gk-3', 'gk-4'] }),
      available(),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-2', 'gk-3']);
  });

  it('enabledGatekeepers: intersection can be empty when the profile and the cap share nothing', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ enabledGatekeepers: ['gk-1'] }),
      policy({ allowedGatekeepers: ['gk-2'] }),
      available(),
    );
    expect(effective.enabledGatekeepers).toEqual([]);
  });

  it('enabledSkills: follows the identical inherit/cap rule as enabledGatekeepers, against published Skills', () => {
    const inherited = resolveEffectiveAgentProfile(
      profile({ enabledSkills: null }),
      policy(),
      available({ publishedSkillIds: ['skill-a', 'skill-b'] }),
    );
    expect(inherited.enabledSkills).toEqual(['skill-a', 'skill-b']);

    const capped = resolveEffectiveAgentProfile(
      profile({ enabledSkills: ['skill-a', 'skill-b'] }),
      policy({ allowedSkills: ['skill-b'] }),
      available(),
    );
    expect(capped.enabledSkills).toEqual(['skill-b']);
  });

  it('enabledWorkerDefinitions: null (inherit) resolves to every currently-published WorkerDefinition id — no policy cap exists for it', () => {
    const inherited = resolveEffectiveAgentProfile(
      profile({ enabledWorkerDefinitions: null }),
      policy(),
      available({ publishedWorkerDefinitionIds: ['def-1', 'def-2'] }),
    );
    expect(inherited.enabledWorkerDefinitions).toEqual(['def-1', 'def-2']);

    const explicit = resolveEffectiveAgentProfile(
      profile({ enabledWorkerDefinitions: ['def-1'] }),
      policy(),
      available({ publishedWorkerDefinitionIds: ['def-1', 'def-2'] }),
    );
    expect(explicit.enabledWorkerDefinitions).toEqual(['def-1']);
  });

  it('promptAddendum: profile value passes through; empty string when the profile has none', () => {
    const withValue = resolveEffectiveAgentProfile(
      profile({ promptAddendum: 'Prefer concise answers.' }),
      policy(),
      available(),
    );
    expect(withValue.promptAddendum).toBe('Prefer concise answers.');

    const withNull = resolveEffectiveAgentProfile(
      profile({ promptAddendum: null }),
      policy(),
      available(),
    );
    expect(withNull.promptAddendum).toBe('');
  });

  it('autoApproveLow: profile true overrides a workspace default of false', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ autoApproveLow: true }),
      policy({ allowMemberAutoApproveLow: false }),
      available(),
    );
    expect(effective.autoApproveLow).toBe(true);
  });

  it('autoApproveLow: profile false narrows a workspace default of true (never widens)', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ autoApproveLow: false }),
      policy({ allowMemberAutoApproveLow: true }),
      available(),
    );
    expect(effective.autoApproveLow).toBe(false);
  });

  it('autoApproveLow: inherits the workspace default when the profile is null', () => {
    const inheritsTrue = resolveEffectiveAgentProfile(
      profile({ autoApproveLow: null }),
      policy({ allowMemberAutoApproveLow: true }),
      available(),
    );
    expect(inheritsTrue.autoApproveLow).toBe(true);

    const inheritsFalse = resolveEffectiveAgentProfile(
      profile({ autoApproveLow: null }),
      policy({ allowMemberAutoApproveLow: false }),
      available(),
    );
    expect(inheritsFalse.autoApproveLow).toBe(false);
  });

  it('NO_AVAILABLE_AGENT_RESOURCES is a safe placeholder for a caller that never reads the list fields', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ model: 'anthropic/claude-sonnet', autoApproveLow: true }),
      policy(),
      NO_AVAILABLE_AGENT_RESOURCES,
    );
    // The fields this kind of caller actually reads are unaffected by the empty placeholder.
    expect(effective.model).toBe('anthropic/claude-sonnet');
    expect(effective.autoApproveLow).toBe(true);
  });
});
