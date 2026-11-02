import { describe, expect, it } from 'vitest';
import { getCapability } from './capabilities.js';
import {
  ADMIN_PROPOSAL_PLATFORM_ITEM_KIND_VALUES,
  ADMIN_PROPOSAL_SEGMENT_STATUS_VALUES,
  adminProposalStatusOf,
} from './enums.js';
import {
  ADMIN_PROPOSAL_GATE_ID_PATTERN,
  ADMIN_PROPOSAL_PLATFORM_MAX_ITEMS,
  ADMIN_PROPOSAL_SOURCE_NAME_PATTERN,
  AdminProposalGateInstanceIntentWireSchema,
  AdminProposalItemIntentWireSchema,
  AdminProposalPlatformItemIntentWireSchema,
  AdminProposalSegmentInputWireSchema,
  GATE_INSTANCE_TARGET_MAX_LENGTH,
  GENERIC_CONNECTOR_NAMES,
  PLATFORM_STATE_GATE_ID_PATTERN,
} from './wire/index.js';

/**
 * S11 AA3b: what an admin agent proposes (wire/change-plan.ts) and how a proposal's status follows
 * from its segments' (enums.ts `adminProposalStatusOf`).
 */

describe('adminProposalStatusOf', () => {
  it('derives a proposal status from its segments', () => {
    expect(adminProposalStatusOf(['proposed', 'proposed'])).toBe('proposed');
    // A rejection with the rest still open: nothing applied yet, something still awaits.
    expect(adminProposalStatusOf(['proposed', 'rejected'])).toBe('proposed');
    expect(adminProposalStatusOf(['applied', 'proposed'])).toBe('partially_applied');
    expect(adminProposalStatusOf(['applied', 'rejected'])).toBe('partially_applied');
    expect(adminProposalStatusOf(['applied', 'applied'])).toBe('applied');
    expect(adminProposalStatusOf(['rejected', 'withdrawn', 'rolled_back'])).toBe('closed');
    // Every segment's target purged.
    expect(adminProposalStatusOf([])).toBe('closed');
  });

  it('answers for every combination of one or two segments', () => {
    for (const a of ADMIN_PROPOSAL_SEGMENT_STATUS_VALUES) {
      for (const b of ADMIN_PROPOSAL_SEGMENT_STATUS_VALUES) {
        const status = adminProposalStatusOf([a, b]);
        const applied = [a, b].filter((s) => s === 'applied').length;
        expect(status === 'applied', `${a},${b}`).toBe(applied === 2);
        expect(status === 'partially_applied', `${a},${b}`).toBe(applied === 1);
      }
    }
  });
});

describe('AdminProposalItemIntentWireSchema', () => {
  const skill = {
    kind: 'skill_version',
    skill: { name: 'disk-triage', description: 'Triage a full disk.', markdown: '# Steps' },
  };

  it('takes each kind, naming its target the way any workspace resolves it', () => {
    expect(AdminProposalItemIntentWireSchema.safeParse(skill).success).toBe(true);
    expect(
      AdminProposalItemIntentWireSchema.safeParse({
        kind: 'worker_definition_version',
        definition: { name: 'disk-worker', systemPrompt: 'You triage disks.' },
      }).success,
    ).toBe(true);
    expect(
      AdminProposalItemIntentWireSchema.safeParse({
        kind: 'operation_version',
        gateId: 'ssh-lab',
        name: 'df',
        set: { auto_approvable: false },
      }).success,
    ).toBe(true);
  });

  it('refuses a workspace id in place of a name, and keys it does not know', () => {
    expect(
      AdminProposalItemIntentWireSchema.safeParse({
        ...skill,
        skillId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      AdminProposalItemIntentWireSchema.safeParse({
        kind: 'operation_version',
        gatekeeperId: '00000000-0000-4000-8000-000000000001',
        name: 'df',
        set: { auto_approvable: false },
      }).success,
    ).toBe(false);
  });

  it('refuses a Skill name that would not publish, and an Operation revision that changes nothing or what the gate runs', () => {
    expect(
      AdminProposalItemIntentWireSchema.safeParse({
        ...skill,
        skill: { ...skill.skill, name: 'Disk' },
      }).success,
    ).toBe(false);
    const operation = { kind: 'operation_version', gateId: 'ssh-lab', name: 'df' };
    expect(AdminProposalItemIntentWireSchema.safeParse({ ...operation, set: {} }).success).toBe(
      false,
    );
    expect(
      AdminProposalItemIntentWireSchema.safeParse({ ...operation, set: { mode: 'execute' } })
        .success,
    ).toBe(false);
  });

  it('bounds a segment: one target workspace, one to fifty items', () => {
    const target = '00000000-0000-4000-8000-000000000001';
    expect(
      AdminProposalSegmentInputWireSchema.safeParse({ targetWorkspaceId: target, items: [] })
        .success,
    ).toBe(false);
    expect(
      AdminProposalSegmentInputWireSchema.safeParse({
        targetWorkspaceId: target,
        items: Array.from({ length: 51 }, () => skill),
      }).success,
    ).toBe(false);
    expect(
      AdminProposalSegmentInputWireSchema.safeParse({ targetWorkspaceId: 'ws-1', items: [skill] })
        .success,
    ).toBe(false);
  });

  it('uses the gate id rule of the platform state reads, and a pack name for the source', () => {
    expect(ADMIN_PROPOSAL_GATE_ID_PATTERN.source).toBe(PLATFORM_STATE_GATE_ID_PATTERN.source);
    expect(ADMIN_PROPOSAL_SOURCE_NAME_PATTERN.test('ops-tools')).toBe(true);
    expect(ADMIN_PROPOSAL_SOURCE_NAME_PATTERN.test('Ops_tools')).toBe(false);
  });
});

/**
 * S11 AA3c (AA3 plan F6; aa3c-plan §3 invariants): the platform segment's whitelist. A platform
 * segment proposes new gate-host instances and nothing else: no field of what it takes points at a
 * user, a membership, a workspace, a platform setting, a model, a runtime image or a token, and none
 * carries a credential.
 */
describe('the platform segment whitelist', () => {
  const gate = {
    kind: 'gate_instance',
    gateId: 'ragflow-lab',
    preset: 'ragflow',
    target: 'https://ragflow.example.com',
  };

  it('holds gate_instance only, and the schema takes exactly that kind', () => {
    expect(ADMIN_PROPOSAL_PLATFORM_ITEM_KIND_VALUES).toEqual(['gate_instance']);
    expect(
      AdminProposalPlatformItemIntentWireSchema.options.map((o) => o.shape.kind.value),
    ).toEqual([...ADMIN_PROPOSAL_PLATFORM_ITEM_KIND_VALUES]);
    expect(AdminProposalPlatformItemIntentWireSchema.safeParse(gate).success).toBe(true);
    // A workspace kind is not a platform item, and a platform kind is not a workspace item.
    expect(
      AdminProposalPlatformItemIntentWireSchema.safeParse({
        kind: 'operation_version',
        gateId: 'ssh-lab',
        name: 'df',
        set: { auto_approvable: false },
      }).success,
    ).toBe(false);
    expect(
      AdminProposalSegmentInputWireSchema.safeParse({
        targetWorkspaceId: '00000000-0000-4000-8000-000000000001',
        items: [gate],
      }).success,
    ).toBe(false);
  });

  it('takes exactly create_gate_instance’s fields, none of them a person, workspace, setting, model, image or token', () => {
    const keys = Object.keys(AdminProposalGateInstanceIntentWireSchema.shape).sort();
    expect(keys).toEqual([
      'connector',
      'credentialMode',
      'displayName',
      'gateId',
      'kind',
      'manifestSource',
      'preset',
      'target',
      'transportKind',
    ]);
    const createGate = getCapability('create_gate_instance');
    const createKeys = Object.keys(
      (createGate?.paramsSchema as unknown as { shape: Record<string, unknown> }).shape,
    ).sort();
    expect(keys.filter((key) => key !== 'kind')).toEqual(createKeys);
    const forbidden =
      /user|member|principal|workspace|role|setting|model|image|runtime|token|secret|credential(?!Mode)|password|key|budget|quota|policy|grant|handle/i;
    expect(keys.filter((key) => forbidden.test(key))).toEqual([]);
  });

  it('refuses an unknown key, a generic or missing connector, and a target past 500 characters', () => {
    expect(
      AdminProposalPlatformItemIntentWireSchema.safeParse({ ...gate, apiKey: 'x' }).success,
    ).toBe(false);
    const http = {
      kind: 'gate_instance',
      gateId: 'billing-api',
      transportKind: 'http',
      target: 'https://billing.example.com',
      credentialMode: 'shared',
      manifestSource: 'https://billing.example.com/openapi.json',
    };
    expect(AdminProposalPlatformItemIntentWireSchema.safeParse(http).success).toBe(false);
    for (const connector of GENERIC_CONNECTOR_NAMES) {
      expect(
        AdminProposalPlatformItemIntentWireSchema.safeParse({ ...http, connector }).success,
        connector,
      ).toBe(false);
    }
    expect(
      AdminProposalPlatformItemIntentWireSchema.safeParse({ ...http, connector: 'billing' })
        .success,
    ).toBe(true);
    expect(
      AdminProposalPlatformItemIntentWireSchema.safeParse({
        ...gate,
        target: `https://ragflow.example.com/${'a'.repeat(GATE_INSTANCE_TARGET_MAX_LENGTH)}`,
      }).success,
    ).toBe(false);
    // A preset excludes what it brings.
    expect(
      AdminProposalPlatformItemIntentWireSchema.safeParse({ ...gate, transportKind: 'http' })
        .success,
    ).toBe(false);
  });

  it('a proposal takes a platform segment of at most ten items, alone or beside workspace segments', () => {
    const propose = getCapability('propose_admin_proposal')?.paramsSchema;
    const head = { title: 'Connect RAGFlow', sourceName: 'kb-rollout' };
    expect(propose?.safeParse({ ...head, platform: { items: [gate] } }).success).toBe(true);
    expect(propose?.safeParse({ ...head, segments: [] }).success).toBe(false);
    expect(propose?.safeParse(head).success).toBe(false);
    expect(
      propose?.safeParse({
        ...head,
        platform: {
          items: Array.from({ length: ADMIN_PROPOSAL_PLATFORM_MAX_ITEMS + 1 }, (_, i) => ({
            ...gate,
            gateId: `ragflow-${i}`,
          })),
        },
      }).success,
    ).toBe(false);
  });
});
