import { describe, expect, it } from 'vitest';
import {
  AcceptanceCheckSchema,
  GoalPlanSchema,
  type ReviewCriterion,
  StepAcceptanceCheckSchema,
} from './goal-plan.js';
import {
  REVIEWER_OUTPUT_SCHEMA,
  ReviewerOutputSchema,
  reviewDerivation,
  reviewReportProblems,
  reviewShortfalls,
} from './goal-review.js';
import { StepOutputSchemaSchema, validateOutput } from './output-schema.js';
import { ProcedureStepSchema } from './procedure.js';

const criteria: ReviewCriterion[] = [
  { key: 'accurate', description: 'Every number matches the source tables.', weight: 3 },
  { key: 'clear', description: 'A reader new to the system follows it.', weight: 1 },
];

describe('ReviewCheckSchema (S11 GO18)', () => {
  const check = {
    kind: 'review',
    key: 'quality',
    subjects: ['draft'],
    criteria,
    passAt: 75,
  };

  it('is one of the goal acceptance kinds', () => {
    expect(AcceptanceCheckSchema.parse(check)).toEqual(check);
    expect(
      GoalPlanSchema.safeParse({
        steps: [{ key: 'draft', worker: { definitionId: crypto.randomUUID(), version: 1 } }],
        acceptance: [check],
      }).success,
    ).toBe(true);
  });

  it('refuses a review that reviews nothing, scores nothing or passes at an impossible line', () => {
    expect(AcceptanceCheckSchema.safeParse({ ...check, subjects: [] }).success).toBe(false);
    expect(AcceptanceCheckSchema.safeParse({ ...check, criteria: [] }).success).toBe(false);
    expect(AcceptanceCheckSchema.safeParse({ ...check, passAt: 0 }).success).toBe(false);
    expect(AcceptanceCheckSchema.safeParse({ ...check, passAt: 101 }).success).toBe(false);
    expect(
      AcceptanceCheckSchema.safeParse({
        ...check,
        criteria: [{ key: 'x', description: ' ', weight: 1 }],
      }).success,
    ).toBe(false);
    expect(
      AcceptanceCheckSchema.safeParse({
        ...check,
        criteria: [{ key: 'x', description: 'y', weight: 6 }],
      }).success,
    ).toBe(false);
    expect(AcceptanceCheckSchema.safeParse({ ...check, verdict: 'passed' }).success).toBe(false);
  });

  it('a plan’s sealed copy (criteria and passAt as the goal planner reads them) is no plan', () => {
    expect(
      AcceptanceCheckSchema.safeParse({ ...check, criteria: '[sealed]', passAt: '[sealed]' })
        .success,
    ).toBe(false);
  });

  // F1 (goal-level only), independent review N1: a step's checks — and so a Procedure's verify
  // step, an object of the graph a Worker reads with find_procedures — never hold a review.
  it('is never a step’s check, nor a Procedure verify step’s', () => {
    expect(StepAcceptanceCheckSchema.safeParse(check).success).toBe(false);
    expect(
      ProcedureStepSchema.safeParse({ kind: 'verify', description: 'reads well', check }).success,
    ).toBe(false);
  });
});

describe('the reviewer output contract', () => {
  it('is an output schema the platform accepts, and holds a report to it', () => {
    const schema = StepOutputSchemaSchema.parse(REVIEWER_OUTPUT_SCHEMA);
    const ok = {
      scores: [
        { criterion: 'accurate', score: 4, reason: 'all match' },
        { criterion: 'clear', score: null, reason: 'only the tables were given' },
      ],
    };
    expect(validateOutput(schema, ok).problems).toEqual([]);
    expect(ReviewerOutputSchema.parse(ok)).toEqual(ok);
    const tooHigh = { scores: [{ criterion: 'accurate', score: 5, reason: 'x' }] };
    expect(validateOutput(schema, tooHigh).problems.map((p) => p.path)).toEqual([
      'output.scores.0.score',
    ]);
    expect(ReviewerOutputSchema.safeParse({ ...ok, verdict: 'passed' }).success).toBe(false);
  });
});

describe('reviewReportProblems', () => {
  it('names a criterion scored twice, one the review does not have and one left out', () => {
    expect(
      reviewReportProblems(criteria, {
        scores: [
          { criterion: 'accurate', score: 4, reason: 'a' },
          { criterion: 'accurate', score: 3, reason: 'b' },
          { criterion: 'tone', score: 3, reason: 'c' },
        ],
      }),
    ).toEqual([
      { path: 'output.scores.1.criterion', message: 'scores criterion accurate a second time' },
      {
        path: 'output.scores.2.criterion',
        message: 'is not a criterion of this review (accurate, clear)',
      },
      { path: 'output.scores', message: 'has no score for criterion clear' },
    ]);
    expect(
      reviewReportProblems(criteria, {
        scores: [
          { criterion: 'clear', score: 1, reason: 'a' },
          { criterion: 'accurate', score: 4, reason: 'b' },
        ],
      }),
    ).toEqual([]);
  });
});

describe('reviewDerivation', () => {
  it('weighs each score, adds them up and compares with passAt in integers', () => {
    // 4×3 + 0×1 = 12 of 16 = 75%: exactly at the line passes.
    const at = reviewDerivation(criteria, 75, [
      { criterion: 'clear', score: 0, reason: 'dense' },
      { criterion: 'accurate', score: 4, reason: 'all match' },
    ]);
    expect(at).toEqual({
      lines: [
        {
          criterion: 'accurate',
          weight: 3,
          score: 4,
          reason: 'all match',
          points: 12,
          maxPoints: 12,
        },
        { criterion: 'clear', weight: 1, score: 0, reason: 'dense', points: 0, maxPoints: 4 },
      ],
      points: 12,
      maxPoints: 16,
      passAt: 75,
      unassessed: [],
      verdict: 'passed',
    });
    expect(reviewShortfalls(at)).toEqual(['clear 0/4']);
    // One point short of the line fails.
    const below = reviewDerivation(criteria, 76, [
      { criterion: 'accurate', score: 4, reason: 'a' },
      { criterion: 'clear', score: 0, reason: 'b' },
    ]);
    expect(below.verdict).toBe('failed');
  });

  it('never passes a review with a criterion it could not judge, however high the rest', () => {
    const derivation = reviewDerivation(criteria, 10, [
      { criterion: 'accurate', score: 4, reason: 'a' },
      { criterion: 'clear', score: null, reason: 'not given the text' },
    ]);
    expect(derivation.verdict).toBe('unavailable');
    expect(derivation.unassessed).toEqual(['clear']);
    expect(derivation.lines[1]).toMatchObject({ points: null, maxPoints: 4 });
  });

  it('throws on scores that do not match the criteria', () => {
    expect(() =>
      reviewDerivation(criteria, 50, [{ criterion: 'accurate', score: 4, reason: 'a' }]),
    ).toThrow(/do not match/);
    expect(() =>
      reviewDerivation(criteria, 50, [
        { criterion: 'accurate', score: 4, reason: 'a' },
        { criterion: 'tone', score: 4, reason: 'b' },
      ]),
    ).toThrow(/no score for criterion clear/);
  });
});
