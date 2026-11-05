import { describe, expect, it } from 'vitest';
import {
  ADMIN_PROPOSAL_REJECTION_LIMIT_VAR,
  ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR,
  AdminProposalTargetRejectedRepeatedlyError,
  type AdminProposalTargetRejection,
  DEFAULT_ADMIN_PROPOSAL_REJECTION_LIMIT,
  DEFAULT_ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS,
  adminProposalRejectionBreaker,
  rejectionWindowStart,
  trippedTargetOf,
} from './admin-proposal-breaker.js';

// S11 AA5a-2 (F6(a), legacy 595): when a target closes to an administrator's agent and when it
// opens again, decided from the rejections alone; and the two settings, read strictly.

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T12:00:00.000Z');
const TARGET = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const BREAKER = { limit: 3, windowDays: 7 } as const;

let serial = 0;
function rejection(daysAgo: number, target = TARGET): AdminProposalTargetRejection {
  serial += 1;
  const n = String(serial).padStart(12, '0');
  return {
    targetWorkspaceId: target,
    proposalId: `00000000-0000-4000-8000-${n}`,
    segmentId: `00000000-0000-4000-9000-${n}`,
    decidedAt: new Date(NOW.getTime() - daysAgo * DAY),
  };
}

describe('trippedTargetOf (F6(a))', () => {
  it('stays open below the limit, and closes at it', () => {
    const two = [rejection(1), rejection(2)];
    expect(trippedTargetOf(TARGET, two, BREAKER, NOW)).toBeUndefined();
    const three = [...two, rejection(3)];
    const tripped = trippedTargetOf(TARGET, three, BREAKER, NOW);
    expect(tripped?.targetWorkspaceId).toBe(TARGET);
    expect(tripped?.rejections).toHaveLength(3);
    // Exactly the limit: it opens when the oldest leaves the window.
    expect(tripped?.reopensAt.toISOString()).toBe(new Date(NOW.getTime() + 4 * DAY).toISOString());
  });

  it('lists the rejections oldest first, whatever order they came in', () => {
    const rows = [rejection(1), rejection(5), rejection(3)];
    const tripped = trippedTargetOf(TARGET, rows, BREAKER, NOW);
    expect(tripped?.rejections.map((row) => row.decidedAt.getTime())).toEqual([
      NOW.getTime() - 5 * DAY,
      NOW.getTime() - 3 * DAY,
      NOW.getTime() - 1 * DAY,
    ]);
  });

  it('with more than the limit, it opens when the limit-th newest leaves, not the oldest', () => {
    // Five within the window: after the two oldest leave, three remain — still closed. It opens
    // when the third newest (two days ago) leaves.
    const rows = [rejection(6), rejection(5), rejection(2), rejection(1), rejection(0.5)];
    const tripped = trippedTargetOf(TARGET, rows, BREAKER, NOW);
    expect(tripped?.rejections).toHaveLength(5);
    expect(tripped?.reopensAt.toISOString()).toBe(new Date(NOW.getTime() + 5 * DAY).toISOString());
    // At that moment it is open, and a moment before it is not.
    const reopensAt = tripped?.reopensAt ?? NOW;
    expect(trippedTargetOf(TARGET, rows, BREAKER, reopensAt)).toBeUndefined();
    expect(trippedTargetOf(TARGET, rows, BREAKER, new Date(reopensAt.getTime() - 1))).toBeDefined();
  });

  it('does not count a rejection decided exactly at the window start; one a moment later counts', () => {
    const start = rejectionWindowStart(BREAKER, NOW);
    expect(start.toISOString()).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString());
    const atStart = { ...rejection(7), decidedAt: start };
    const justAfter = { ...rejection(7), decidedAt: new Date(start.getTime() + 1) };
    expect(
      trippedTargetOf(TARGET, [atStart, rejection(1), rejection(2)], BREAKER, NOW),
    ).toBeUndefined();
    const tripped = trippedTargetOf(TARGET, [justAfter, rejection(1), rejection(2)], BREAKER, NOW);
    // It opens a window after the oldest was decided: a millisecond from now.
    expect(tripped?.reopensAt.toISOString()).toBe(new Date(NOW.getTime() + 1).toISOString());
  });

  it('counts a rejection stamped a moment after the kernel’s clock', () => {
    const ahead = { ...rejection(0), decidedAt: new Date(NOW.getTime() + 500) };
    expect(
      trippedTargetOf(TARGET, [ahead, rejection(1), rejection(2)], BREAKER, NOW),
    ).toBeDefined();
  });

  it('counts only the target asked about', () => {
    const rows = [rejection(1), rejection(2), rejection(3, OTHER), rejection(4, OTHER)];
    expect(trippedTargetOf(TARGET, rows, BREAKER, NOW)).toBeUndefined();
    expect(trippedTargetOf(OTHER, rows, BREAKER, NOW)).toBeUndefined();
    const closed = trippedTargetOf(OTHER, [...rows, rejection(5, OTHER)], BREAKER, NOW);
    expect(closed?.rejections.every((row) => row.targetWorkspaceId === OTHER)).toBe(true);
  });

  it('follows the configured limit and window', () => {
    const rows = [rejection(1), rejection(9)];
    expect(trippedTargetOf(TARGET, rows, { limit: 2, windowDays: 7 }, NOW)).toBeUndefined();
    const wider = trippedTargetOf(TARGET, rows, { limit: 2, windowDays: 10 }, NOW);
    expect(wider?.reopensAt.toISOString()).toBe(new Date(NOW.getTime() + 1 * DAY).toISOString());
    expect(
      trippedTargetOf(TARGET, [rejection(0.5)], { limit: 1, windowDays: 1 }, NOW),
    ).toBeDefined();
    expect(
      trippedTargetOf(TARGET, [rejection(1)], { limit: 1, windowDays: 1 }, NOW),
    ).toBeUndefined();
  });
});

describe('adminProposalRejectionBreaker (coordinator 2026-11-02: configurable, 3 in 7 days)', () => {
  it('defaults to 3 rejections in 7 days', () => {
    expect(DEFAULT_ADMIN_PROPOSAL_REJECTION_LIMIT).toBe(3);
    expect(DEFAULT_ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS).toBe(7);
    expect(adminProposalRejectionBreaker({})).toEqual({ limit: 3, windowDays: 7 });
    expect(
      adminProposalRejectionBreaker({
        [ADMIN_PROPOSAL_REJECTION_LIMIT_VAR]: '',
        [ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR]: '  ',
      }),
    ).toEqual({ limit: 3, windowDays: 7 });
  });

  it('reads whole numbers of at least 1', () => {
    expect(
      adminProposalRejectionBreaker({
        [ADMIN_PROPOSAL_REJECTION_LIMIT_VAR]: '5',
        [ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR]: '14',
      }),
    ).toEqual({ limit: 5, windowDays: 14 });
    expect(adminProposalRejectionBreaker({ [ADMIN_PROPOSAL_REJECTION_LIMIT_VAR]: '1' })).toEqual({
      limit: 1,
      windowDays: 7,
    });
  });

  it.each(['0', '-1', '2.5', 'three', '3d', 'Infinity', 'NaN'])(
    'refuses %s rather than ignore it, naming the variable and the default',
    (raw) => {
      expect(() =>
        adminProposalRejectionBreaker({ [ADMIN_PROPOSAL_REJECTION_LIMIT_VAR]: raw }),
      ).toThrow(`${ADMIN_PROPOSAL_REJECTION_LIMIT_VAR}="${raw}"`);
      expect(() =>
        adminProposalRejectionBreaker({ [ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR]: raw }),
      ).toThrow('unset it to use the default 7');
    },
  );
});

describe('AdminProposalTargetRejectedRepeatedlyError (what the agent reads)', () => {
  it('names the segment, the rule and when, never the proposals, segments or reasons', () => {
    const rows = [rejection(1), rejection(2), rejection(3)];
    const tripped = trippedTargetOf(TARGET, rows, BREAKER, NOW);
    if (tripped === undefined) throw new Error('expected the target to be closed');
    const err = new AdminProposalTargetRejectedRepeatedlyError(2, BREAKER, tripped);
    expect(err.code).toBe('admin_proposal_target_rejected_repeatedly');
    expect(err.details).toEqual({
      segment: 2,
      rejectionLimit: 3,
      windowDays: 7,
      reopensAt: tripped.reopensAt.toISOString(),
    });
    expect(err.message).toContain('segments[2].targetWorkspaceId');
    expect(err.message).toContain(tripped.reopensAt.toISOString());
    const sent = `${err.message} ${JSON.stringify(err.details)}`;
    for (const row of rows) {
      expect(sent).not.toContain(row.proposalId);
      expect(sent).not.toContain(row.segmentId);
    }
    expect(sent).not.toContain(TARGET);
  });
});
