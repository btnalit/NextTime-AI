import { describe, expect, it } from 'vitest';
import {
  PLAN_HINT_ADMISSION,
  PLAN_HINT_CODE_VALUES,
  type PlanHint,
  stepAdmissionOf,
} from './goal-plan.js';

const trial = {
  specDigest: 'sha256:spec',
  drafts: [
    {
      skillId: '00000000-0000-4000-8000-000000000001',
      version: 2,
      name: 'triage',
      draftDigest: 'sha256:draft',
      proposedBy: '00000000-0000-4000-8000-000000000002',
    },
  ],
};

describe('PLAN_HINT_ADMISSION (S11 GO15a)', () => {
  it('classifies every plan hint code', () => {
    expect(Object.keys(PLAN_HINT_ADMISSION).sort()).toEqual([...PLAN_HINT_CODE_VALUES].sort());
  });

  it('says only a draft Skill waits for a person; advice never stops a step', () => {
    expect(PLAN_HINT_ADMISSION.step_skill_draft).toBe('needs_approval');
    expect(PLAN_HINT_ADMISSION.step_account_not_connected).toBe('note');
    expect(PLAN_HINT_ADMISSION.step_output_contract_unused).toBe('note');
    expect(PLAN_HINT_ADMISSION.step_input_mismatch).toBe('note');
    expect(PLAN_HINT_ADMISSION.requester_confirm_only).toBe('plan');
    const refused = PLAN_HINT_CODE_VALUES.filter((code) => PLAN_HINT_ADMISSION[code] === 'refused');
    expect(refused).toEqual([
      'requester_cannot_start_workers',
      'step_gate_not_held',
      'step_capability_not_held',
      'step_definition_excluded',
      'step_skill_deprecated',
      'step_model_not_offered',
      'step_model_not_allowed',
      'step_worker_unavailable',
      'step_skill_version_unavailable',
    ]);
  });
});

describe('stepAdmissionOf (S11 GO15a)', () => {
  it('runs a step with no hint, or only advice about it', () => {
    expect(stepAdmissionOf([], 'a')).toEqual({ verdict: 'run' });
    const advice: PlanHint[] = [
      { code: 'requester_confirm_only', message: 'm' },
      { code: 'step_input_mismatch', message: 'm', stepKey: 'a' },
      { code: 'step_account_not_connected', message: 'm', stepKey: 'a', gatekeeperIds: [] },
      { code: 'step_model_not_allowed', message: 'm', stepKey: 'b', model: 'x' },
    ];
    expect(stepAdmissionOf(advice, 'a')).toEqual({ verdict: 'run' });
  });

  it('waits for an approval only when a trial of the draft can be approved', () => {
    const approvable: PlanHint = { code: 'step_skill_draft', message: 'm', stepKey: 'a', trial };
    expect(stepAdmissionOf([approvable], 'a')).toEqual({
      verdict: 'needs_approval',
      hints: [approvable],
    });
    const none: PlanHint = { code: 'step_skill_draft', message: 'm', stepKey: 'a' };
    expect(stepAdmissionOf([none], 'a')).toEqual({ verdict: 'refused', hints: [none] });
  });

  it('refuses when any stopping hint refuses, and lists every stopping hint of the step', () => {
    const draft: PlanHint = { code: 'step_skill_draft', message: 'm', stepKey: 'a', trial };
    const model: PlanHint = { code: 'step_model_not_allowed', message: 'm', stepKey: 'a' };
    expect(stepAdmissionOf([draft, model], 'a')).toEqual({
      verdict: 'refused',
      hints: [draft, model],
    });
  });

  it('refuses every step when the requester cannot start Workers at all', () => {
    const requester: PlanHint = { code: 'requester_cannot_start_workers', message: 'm' };
    expect(stepAdmissionOf([requester], 'any')).toEqual({
      verdict: 'refused',
      hints: [requester],
    });
  });
});
