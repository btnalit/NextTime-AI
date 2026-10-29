import type { OperationSummaryWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { confirmsAbsence, operationChoices } from './gate-operations.js';

function op(overrides: Partial<OperationSummaryWire>): OperationSummaryWire {
  return {
    gatekeeperId: 'gk-1',
    name: 'op',
    mode: 'execute',
    blastRadius: 'low',
    autoApprovable: false,
    version: 1,
    status: 'published',
    ...overrides,
  };
}

describe('operationChoices', () => {
  it('keeps published Operations only, one per name, sorted', () => {
    expect(
      operationChoices([
        op({ name: 'restart', blastRadius: 'medium', description: 'Restart a container' }),
        op({ name: 'prune', status: 'draft' }),
        op({ name: 'old', status: 'deprecated' }),
        op({ name: 'inspect', mode: 'observe' }),
      ]),
    ).toEqual([
      { name: 'inspect', blastRadius: 'low', gateCount: 1, version: 1 },
      {
        name: 'restart',
        blastRadius: 'medium',
        description: 'Restart a container',
        gateCount: 1,
        version: 1,
      },
    ]);
  });

  it('folds the same name across gates, keeping the blast radius only when every gate agrees', () => {
    expect(
      operationChoices([
        op({ gatekeeperId: 'gk-1', name: 'restart', blastRadius: 'medium' }),
        op({ gatekeeperId: 'gk-2', name: 'restart', blastRadius: 'high' }),
        op({ gatekeeperId: 'gk-1', name: 'inspect' }),
        op({ gatekeeperId: 'gk-2', name: 'inspect' }),
      ]),
    ).toEqual([
      // Legacy 218: a version names one gate's Operation, so folded names carry none.
      { name: 'inspect', blastRadius: 'low', gateCount: 2, version: null },
      { name: 'restart', blastRadius: null, gateCount: 2, version: null },
    ]);
  });
});

describe('confirmsAbsence (S11 gate-confirmed absence B)', () => {
  it('offers an absence check only an Operation that declares its “not there” answers, confirmed at publish', () => {
    const review = { reviewedBy: 'pr-owner', reviewedAt: '2026-10-29T00:00:00.000Z' };
    const rows = [
      op({
        name: 'confirmed',
        mode: 'observe',
        absentAnswers: { statuses: [404] },
        absentAnswersReview: review,
      }),
      op({ name: 'unconfirmed', mode: 'observe', absentAnswers: { statuses: [404] } }),
      op({ name: 'undeclared', mode: 'observe' }),
      op({
        name: 'exit',
        mode: 'observe',
        absentAnswers: { exitCodes: [3] },
        absentAnswersReview: review,
      }),
    ];
    expect(operationChoices(rows.filter(confirmsAbsence)).map((choice) => choice.name)).toEqual([
      'confirmed',
      'exit',
    ]);
  });
});
