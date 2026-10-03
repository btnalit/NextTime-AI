import type { Role } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { draftVisibilityBinds, draftVisibleTo } from './draft-visibility.js';

/**
 * application/worker/draft-visibility (pure): the Skill / Procedure draft read rule — the
 * proposer, builders and the owner see a draft; published and deprecated rows are never narrowed.
 * The DB-gated end-to-end coverage is
 * application/gateway/skill-procedure-draft-review.integration.test.ts.
 */

const PROPOSER = 'proposer-principal';
const OTHER = 'other-principal';

function viewer(principalId: string, role: Role) {
  return { principalId, role };
}

describe('draftVisibleTo', () => {
  const draft = { status: 'draft' as const, proposedBy: PROPOSER };

  it('shows a draft to its proposer, whatever their role', () => {
    expect(draftVisibleTo(viewer(PROPOSER, 'member'), draft)).toBe(true);
  });

  it('shows every draft to the owner and builders (D-26 reviewer rule)', () => {
    expect(draftVisibleTo(viewer(OTHER, 'owner'), draft)).toBe(true);
    expect(draftVisibleTo(viewer(OTHER, 'builder'), draft)).toBe(true);
  });

  it('hides someone else’s draft from every other role', () => {
    for (const role of ['member', 'operator', 'auditor'] as const) {
      expect(draftVisibleTo(viewer(OTHER, role), draft)).toBe(false);
    }
  });

  it('never narrows a published or deprecated row', () => {
    for (const status of ['published', 'deprecated'] as const) {
      expect(draftVisibleTo(viewer(OTHER, 'member'), { status, proposedBy: PROPOSER })).toBe(true);
    }
  });
});

describe('draftVisibilityBinds', () => {
  it('carries the same reviewer rule into SQL', () => {
    expect(draftVisibilityBinds(viewer(OTHER, 'owner'))).toEqual({
      seesEveryDraft: true,
      principalId: OTHER,
    });
    expect(draftVisibilityBinds(viewer(OTHER, 'builder')).seesEveryDraft).toBe(true);
    expect(draftVisibilityBinds(viewer(OTHER, 'member'))).toEqual({
      seesEveryDraft: false,
      principalId: OTHER,
    });
  });
});
