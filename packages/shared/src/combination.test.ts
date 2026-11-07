import { describe, expect, it } from 'vitest';
import {
  COMBINATION_MIN_ACHIEVED,
  COMBINATION_MIN_GOALS,
  COMBINATION_MIN_RATE,
  COMBINATION_STEP_ONLY_FIELDS,
  type CombinationEvidence,
  combinationShortfalls,
  mergeCombinationDefinition,
} from './combination.js';
import { WORKER_SPEC_FIELD_VALUES } from './goal-plan.js';
import { WorkerWorkerDefinitionContentSchema } from './worker-definition.js';

const qualifying: CombinationEvidence = {
  achieved: COMBINATION_MIN_ACHIEVED,
  notAchieved: 0,
  goals: COMBINATION_MIN_GOALS,
  rate: 1,
  reviewSuggested: false,
};

describe('combinationShortfalls (S11 GO16b, F1 = A)', () => {
  it('qualifies at exactly the thresholds', () => {
    expect(combinationShortfalls(qualifying, true)).toEqual([]);
    expect(
      combinationShortfalls({ ...qualifying, achieved: 4, notAchieved: 1, rate: 0.8 }, true),
    ).toEqual([]);
  });

  it('names every shortfall, in order', () => {
    expect(
      combinationShortfalls(
        { achieved: 2, notAchieved: 1, goals: 1, rate: 2 / 3, reviewSuggested: true },
        false,
      ),
    ).toEqual([
      'base_not_published',
      'too_few_achieved',
      'too_few_goals',
      'rate_too_low',
      'review_suggested',
    ]);
  });

  it('a rate below the threshold, or none, does not qualify', () => {
    expect(
      combinationShortfalls({ ...qualifying, achieved: 7, notAchieved: 2, rate: 7 / 9 }, true),
    ).toEqual(['rate_too_low']);
    expect(7 / 9).toBeLessThan(COMBINATION_MIN_RATE);
    expect(combinationShortfalls({ ...qualifying, achieved: 0, rate: null }, true)).toEqual([
      'too_few_achieved',
      'rate_too_low',
    ]);
  });
});

describe('mergeCombinationDefinition (S11 GO16b, F4 = A)', () => {
  const base = WorkerWorkerDefinitionContentSchema.parse({
    systemPrompt: 'You review change records.',
    model: 'provider/base-model',
    name: 'Reviewer',
    description: 'Reviews change records',
    skills: ['summarize'],
    capabilities: ['get_object'],
    gates: ['00000000-0000-4000-8000-0000000000a1'],
    egressDeny: ['internal.example'],
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  });

  it('adds instructions after the base prompt and replaces the lists and model', () => {
    const merged = mergeCombinationDefinition(
      base,
      {
        instructions: '  Mark the items that need a rollback.  ',
        skills: ['summarize', 'rollback-check'],
        gates: ['00000000-0000-4000-8000-0000000000b2'],
        capabilities: ['get_object', 'traverse'],
        model: 'provider/other-model',
        observeScope: ['00000000-0000-4000-8000-0000000000b2'],
        tokenBudget: 5000,
      },
      'Reviewer · rollbacks',
    );
    expect(merged).toEqual({
      systemPrompt: 'You review change records.\n\nMark the items that need a rollback.',
      model: 'provider/other-model',
      name: 'Reviewer · rollbacks',
      description: 'Reviews change records',
      skills: ['summarize', 'rollback-check'],
      capabilities: ['get_object', 'traverse'],
      gates: ['00000000-0000-4000-8000-0000000000b2'],
      egressDeny: ['internal.example'],
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    // The step-only fields have no place in a definition: the content schema refuses them.
    expect(WorkerWorkerDefinitionContentSchema.safeParse(merged).success).toBe(true);
    for (const field of COMBINATION_STEP_ONLY_FIELDS) expect(merged).not.toHaveProperty(field);
  });

  it('keeps what the WorkerSpec does not set', () => {
    expect(mergeCombinationDefinition(base, { tokenBudget: 1000 }, 'Reviewer · small')).toEqual({
      ...base,
      name: 'Reviewer · small',
    });
  });

  it('the step-only fields are WorkerSpec fields', () => {
    for (const field of COMBINATION_STEP_ONLY_FIELDS) {
      expect(WORKER_SPEC_FIELD_VALUES).toContain(field);
    }
  });
});
