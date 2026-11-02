import { describe, expect, it } from 'vitest';
import { ADMIN_PROPOSAL_SEGMENT_STATUS_VALUES, adminProposalStatusOf } from './enums.js';
import {
  ADMIN_PROPOSAL_GATE_ID_PATTERN,
  ADMIN_PROPOSAL_SOURCE_NAME_PATTERN,
  AdminProposalItemIntentWireSchema,
  AdminProposalSegmentInputWireSchema,
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
