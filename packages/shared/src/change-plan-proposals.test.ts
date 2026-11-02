import { describe, expect, it } from 'vitest';
import { CHANGE_PLAN_SEGMENT_STATUS_VALUES, changePlanStatusOf } from './enums.js';
import {
  CHANGE_PLAN_GATE_ID_PATTERN,
  CHANGE_PLAN_SOURCE_NAME_PATTERN,
  ChangePlanItemIntentWireSchema,
  ChangePlanSegmentProposalWireSchema,
  PLATFORM_STATE_GATE_ID_PATTERN,
} from './wire/index.js';

/**
 * S11 AA3b: what an admin agent proposes (wire/change-plan.ts) and how a plan's status follows
 * from its segments' (enums.ts `changePlanStatusOf`).
 */

describe('changePlanStatusOf', () => {
  it('derives a plan status from its segments', () => {
    expect(changePlanStatusOf(['proposed', 'proposed'])).toBe('proposed');
    // A rejection with the rest still open: nothing applied yet, something still awaits.
    expect(changePlanStatusOf(['proposed', 'rejected'])).toBe('proposed');
    expect(changePlanStatusOf(['applied', 'proposed'])).toBe('partially_applied');
    expect(changePlanStatusOf(['applied', 'rejected'])).toBe('partially_applied');
    expect(changePlanStatusOf(['applied', 'applied'])).toBe('applied');
    expect(changePlanStatusOf(['rejected', 'withdrawn', 'rolled_back'])).toBe('closed');
    // Every segment's target purged.
    expect(changePlanStatusOf([])).toBe('closed');
  });

  it('answers for every combination of one or two segments', () => {
    for (const a of CHANGE_PLAN_SEGMENT_STATUS_VALUES) {
      for (const b of CHANGE_PLAN_SEGMENT_STATUS_VALUES) {
        const status = changePlanStatusOf([a, b]);
        const applied = [a, b].filter((s) => s === 'applied').length;
        expect(status === 'applied', `${a},${b}`).toBe(applied === 2);
        expect(status === 'partially_applied', `${a},${b}`).toBe(applied === 1);
      }
    }
  });
});

describe('ChangePlanItemIntentWireSchema', () => {
  const skill = {
    kind: 'skill_version',
    skill: { name: 'disk-triage', description: 'Triage a full disk.', markdown: '# Steps' },
  };

  it('takes each kind, naming its target the way any workspace resolves it', () => {
    expect(ChangePlanItemIntentWireSchema.safeParse(skill).success).toBe(true);
    expect(
      ChangePlanItemIntentWireSchema.safeParse({
        kind: 'worker_definition_version',
        definition: { name: 'disk-worker', systemPrompt: 'You triage disks.' },
      }).success,
    ).toBe(true);
    expect(
      ChangePlanItemIntentWireSchema.safeParse({
        kind: 'operation_version',
        gateId: 'ssh-lab',
        name: 'df',
        set: { auto_approvable: false },
      }).success,
    ).toBe(true);
  });

  it('refuses a workspace id in place of a name, and keys it does not know', () => {
    expect(
      ChangePlanItemIntentWireSchema.safeParse({
        ...skill,
        skillId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      ChangePlanItemIntentWireSchema.safeParse({
        kind: 'operation_version',
        gatekeeperId: '00000000-0000-4000-8000-000000000001',
        name: 'df',
        set: { auto_approvable: false },
      }).success,
    ).toBe(false);
  });

  it('refuses a Skill name that would not publish, and an Operation revision that changes nothing or what the gate runs', () => {
    expect(
      ChangePlanItemIntentWireSchema.safeParse({
        ...skill,
        skill: { ...skill.skill, name: 'Disk' },
      }).success,
    ).toBe(false);
    const operation = { kind: 'operation_version', gateId: 'ssh-lab', name: 'df' };
    expect(ChangePlanItemIntentWireSchema.safeParse({ ...operation, set: {} }).success).toBe(false);
    expect(
      ChangePlanItemIntentWireSchema.safeParse({ ...operation, set: { mode: 'execute' } }).success,
    ).toBe(false);
  });

  it('bounds a segment: one target workspace, one to fifty items', () => {
    const target = '00000000-0000-4000-8000-000000000001';
    expect(
      ChangePlanSegmentProposalWireSchema.safeParse({ targetWorkspaceId: target, items: [] })
        .success,
    ).toBe(false);
    expect(
      ChangePlanSegmentProposalWireSchema.safeParse({
        targetWorkspaceId: target,
        items: Array.from({ length: 51 }, () => skill),
      }).success,
    ).toBe(false);
    expect(
      ChangePlanSegmentProposalWireSchema.safeParse({ targetWorkspaceId: 'ws-1', items: [skill] })
        .success,
    ).toBe(false);
  });

  it('uses the gate id rule of the platform state reads, and a pack name for the source', () => {
    expect(CHANGE_PLAN_GATE_ID_PATTERN.source).toBe(PLATFORM_STATE_GATE_ID_PATTERN.source);
    expect(CHANGE_PLAN_SOURCE_NAME_PATTERN.test('ops-tools')).toBe(true);
    expect(CHANGE_PLAN_SOURCE_NAME_PATTERN.test('Ops_tools')).toBe(false);
  });
});
