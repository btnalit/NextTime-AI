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
    excludedSkills: [],
    excludedGatekeepers: [],
    excludedWorkerDefinitions: [],
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

  it('model (P-A2): a profile model outside policy.allowedModels falls back to the allowed defaultModel', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ model: 'anthropic/claude-sonnet' }),
      policy({ allowedModels: ['anthropic/claude-haiku'], defaultModel: 'anthropic/claude-haiku' }),
      available(),
    );
    expect(effective.model).toBe('anthropic/claude-haiku');
  });

  it('model (P-A2): falls back to "" when neither the profile model nor the defaultModel is allowed', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ model: 'anthropic/claude-sonnet' }),
      policy({ allowedModels: ['openai/gpt-x'], defaultModel: 'anthropic/claude-haiku' }),
      available(),
    );
    expect(effective.model).toBe('');
  });

  it('model (P-A2): an empty allowedModels list is unrestricted — the profile model passes through', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ model: 'anthropic/claude-sonnet' }),
      policy({ allowedModels: [], defaultModel: 'anthropic/claude-haiku' }),
      available(),
    );
    expect(effective.model).toBe('anthropic/claude-sonnet');
  });

  it('enabledGatekeepers: no exclusions resolves to every currently-granted id', () => {
    const effective = resolveEffectiveAgentProfile(
      profile(),
      policy({ allowedGatekeepers: [] }),
      available({ grantedGatekeeperIds: ['gk-1', 'gk-2'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1', 'gk-2']);
  });

  it('enabledGatekeepers (console redesign D1): a Gatekeeper granted after the profile was saved is picked up automatically', () => {
    const saved = profile({ excludedGatekeepers: ['gk-old-excluded'] });
    const before = resolveEffectiveAgentProfile(
      saved,
      policy(),
      available({ grantedGatekeeperIds: ['gk-first', 'gk-old-excluded'] }),
    );
    expect(before.enabledGatekeepers).toEqual(['gk-first']);

    // Same saved profile, one more Grant since: it flows in without the member touching anything.
    const after = resolveEffectiveAgentProfile(
      saved,
      policy(),
      available({ grantedGatekeeperIds: ['gk-first', 'gk-old-excluded', 'gk-granted-later'] }),
    );
    expect(after.enabledGatekeepers).toEqual(['gk-first', 'gk-granted-later']);
  });

  it('enabledGatekeepers: an exclusion removes a granted id', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ excludedGatekeepers: ['gk-2'] }),
      policy({ allowedGatekeepers: [] }),
      available({ grantedGatekeeperIds: ['gk-1', 'gk-2', 'gk-3'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1', 'gk-3']);
  });

  it('enabledGatekeepers: an excluded id that is not granted is irrelevant — never widens', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ excludedGatekeepers: ['gk-not-granted'] }),
      policy(),
      available({ grantedGatekeeperIds: ['gk-1'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1']);
  });

  it('enabledGatekeepers: a policy cap narrows the granted set', () => {
    const effective = resolveEffectiveAgentProfile(
      profile(),
      policy({ allowedGatekeepers: ['gk-1'] }),
      available({ grantedGatekeeperIds: ['gk-1', 'gk-2'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-1']);
  });

  it('enabledGatekeepers: exclusions and the policy cap both apply', () => {
    const effective = resolveEffectiveAgentProfile(
      profile({ excludedGatekeepers: ['gk-2'] }),
      policy({ allowedGatekeepers: ['gk-2', 'gk-3', 'gk-4'] }),
      available({ grantedGatekeeperIds: ['gk-1', 'gk-2', 'gk-3'] }),
    );
    expect(effective.enabledGatekeepers).toEqual(['gk-3']);
  });

  it('enabledGatekeepers: never includes an id that is not granted, whatever the cap says', () => {
    const effective = resolveEffectiveAgentProfile(
      profile(),
      policy({ allowedGatekeepers: ['gk-2'] }),
      available({ grantedGatekeeperIds: ['gk-1'] }),
    );
    expect(effective.enabledGatekeepers).toEqual([]);
  });

  it('enabledSkills: follows the identical exclusion/cap rule as enabledGatekeepers, against published Skills', () => {
    const all = resolveEffectiveAgentProfile(
      profile(),
      policy(),
      available({ publishedSkillIds: ['skill-a', 'skill-b'] }),
    );
    expect(all.enabledSkills).toEqual(['skill-a', 'skill-b']);

    const excludedAndCapped = resolveEffectiveAgentProfile(
      profile({ excludedSkills: ['skill-c'] }),
      policy({ allowedSkills: ['skill-b', 'skill-c'] }),
      available({ publishedSkillIds: ['skill-a', 'skill-b', 'skill-c'] }),
    );
    expect(excludedAndCapped.enabledSkills).toEqual(['skill-b']);
  });

  it('enabledWorkerDefinitions: every published WorkerDefinition minus exclusions — no policy cap exists for it, and a newly published one flows in', () => {
    const all = resolveEffectiveAgentProfile(
      profile(),
      policy(),
      available({ publishedWorkerDefinitionIds: ['def-1', 'def-2'] }),
    );
    expect(all.enabledWorkerDefinitions).toEqual(['def-1', 'def-2']);

    const excluded = resolveEffectiveAgentProfile(
      profile({ excludedWorkerDefinitions: ['def-2'] }),
      policy(),
      available({ publishedWorkerDefinitionIds: ['def-1', 'def-2', 'def-3'] }),
    );
    expect(excluded.enabledWorkerDefinitions).toEqual(['def-1', 'def-3']);
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
