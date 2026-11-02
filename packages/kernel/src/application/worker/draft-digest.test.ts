import { DRAFT_ORIGIN_VALUES } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { familyVersionDigest } from './family-version.js';
import { procedureDraftDigest } from './procedures.js';
import { skillDraftDigest } from './skills.js';

/**
 * application/worker/draft-digest.test (pure) — S11 AA3a (legacy 293, review #493 on #914 P3-2):
 * a Skill / Procedure draft's digest covers who wrote it (`origin`) only when that was recorded.
 * A row written before has no origin, and its digest must stay the one it had: publish evidence,
 * evaluation runs and rejections already stored name it. So the null-origin digest is pinned to
 * the value the digest had before origin existed (the same fields, no origin), and each recorded
 * origin gives another.
 */

const PROPOSER = '00000000-0000-4000-8000-0000000000b1';
const SKILL = {
  id: '00000000-0000-4000-8000-0000000000a1',
  version: 2,
  name: 'disk-triage',
  description: 'Triage a full disk.',
  markdown: '# Steps\n\nCheck df.',
  applicable: { gateKinds: ['ssh'] },
  proposedBy: PROPOSER,
};
const PROCEDURE = {
  id: '00000000-0000-4000-8000-0000000000a2',
  version: 1,
  name: 'restart-service',
  description: 'Restart a service.',
  steps: [],
  parameters: null,
  proposedBy: PROPOSER,
};

/** What each digest was before AA3a recorded an origin: main's `skillDraftDigest` /
 *  `procedureDraftDigest` (the same fields, no origin) on these rows, written down here. */
const SKILL_DIGEST_BEFORE_ORIGIN =
  'sha256:b94b4e230c6f6bdc5d7d7e5aafcddfe5920bfa7fdabdfbf54896ad090e8f2ba4';
const PROCEDURE_DIGEST_BEFORE_ORIGIN =
  'sha256:f52a5fecf60d2879acc9c3b8719efada0191828b4bcce8125be9f7881a3f630d';

describe('draft digests and origin (S11 AA3a)', () => {
  it('a Skill row with no origin keeps the digest it had before origin was recorded', () => {
    expect(skillDraftDigest({ ...SKILL, origin: null })).toBe(SKILL_DIGEST_BEFORE_ORIGIN);
    expect(familyVersionDigest('skill', SKILL)).toBe(SKILL_DIGEST_BEFORE_ORIGIN);
  });

  it('a Procedure row with no origin keeps the digest it had before origin was recorded', () => {
    expect(procedureDraftDigest({ ...PROCEDURE, origin: null })).toBe(
      PROCEDURE_DIGEST_BEFORE_ORIGIN,
    );
    expect(familyVersionDigest('procedure', PROCEDURE)).toBe(PROCEDURE_DIGEST_BEFORE_ORIGIN);
  });

  it('each recorded origin gives its own digest, none of them the unrecorded one', () => {
    for (const [digest, unrecorded] of [
      [
        (origin: (typeof DRAFT_ORIGIN_VALUES)[number]) => skillDraftDigest({ ...SKILL, origin }),
        SKILL_DIGEST_BEFORE_ORIGIN,
      ],
      [
        (origin: (typeof DRAFT_ORIGIN_VALUES)[number]) =>
          procedureDraftDigest({ ...PROCEDURE, origin }),
        PROCEDURE_DIGEST_BEFORE_ORIGIN,
      ],
    ] as const) {
      const digests = DRAFT_ORIGIN_VALUES.map(digest);
      expect(new Set(digests).size).toBe(DRAFT_ORIGIN_VALUES.length);
      expect(digests).not.toContain(unrecorded);
    }
  });
});
