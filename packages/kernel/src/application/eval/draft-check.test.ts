import { DRAFT_CHECK_LIMITS } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { changedLineCount, checkSkillDraft } from './draft-check.js';

/**
 * application/eval/draft-check: the checks a Skill draft passes before an evaluation of it starts
 * (S10 E3-2b). The seal check (`contaminated`) reads the workspace's suites, so it is covered by
 * gateway/draft-evaluations.integration.test.ts; here the client reports no suite, so it never
 * fires.
 */

const noSuites = {
  query: async () => ({ rows: [{ suites: 0, holdout: 0 }] }),
} as unknown as PoolClient;

const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

const baseline = {
  name: 'restart-helper',
  description: 'Restarts a host after asking.',
  markdown: '# Restart\n\nAsk before restarting.\nReport what restarted.',
};

const check = (draft: typeof baseline, against: typeof baseline | null = baseline) =>
  checkSkillDraft(noSuites, 'ws', draft, against);

describe('changedLineCount', () => {
  it('counts lines added plus lines removed, keeping the longest common run', () => {
    expect(changedLineCount(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(changedLineCount(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(2);
    expect(changedLineCount(['a', 'b', 'c'], ['a', 'b', 'c', 'd'])).toBe(1);
    expect(changedLineCount(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(4);
    expect(changedLineCount([], ['a', 'b'])).toBe(2);
    expect(changedLineCount(['a', 'b'], [])).toBe(2);
  });
});

describe('checkSkillDraft', () => {
  it('passes a small edit', async () => {
    expect(
      await check({ ...baseline, markdown: `${baseline.markdown}\nName the host you restarted.` }),
    ).toEqual([]);
  });

  it('names what each failed check counted, never the text it found', async () => {
    const problems = await check({
      ...baseline,
      markdown: `${baseline.markdown}\nexport API_TOKEN="${FAKE}"\nUse 0b6a1f9e-3c4d-4e5f-8a9b-0c1d2e3f4a5b and 0B6A1F9E-3C4D-4E5F-8A9B-0C1D2E3F4A5C.`,
    });
    expect(problems).toEqual([
      { check: 'credential_like', count: 1, limit: null },
      { check: 'internal_id', count: 2, limit: null },
    ]);
    expect(JSON.stringify(problems)).not.toContain(FAKE);
  });

  it('refuses a draft that says what its baseline says', async () => {
    expect(await check({ ...baseline })).toEqual([
      { check: 'unchanged', count: null, limit: null },
    ]);
  });

  it('counts the name and the description as lines of the edit budget', async () => {
    const body = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag} step ${i}`).join('\n');
    const old = { ...baseline, markdown: body(150, 'old') };
    // 150 removed + 150 added + the description changed (1 removed + 1 added).
    const problems = await check(
      { ...baseline, description: 'Restarts a host.', markdown: body(150, 'new') },
      old,
    );
    expect(problems).toEqual([
      { check: 'edit_budget', count: 302, limit: DRAFT_CHECK_LIMITS.maxChangedLines },
    ]);
    // A new Skill counts every line it has.
    expect(await check({ ...baseline, markdown: body(199, 'new') }, null)).toEqual([
      { check: 'edit_budget', count: 201, limit: DRAFT_CHECK_LIMITS.maxChangedLines },
    ]);
    expect(await check({ ...baseline, markdown: body(198, 'new') }, null)).toEqual([]);
  });

  it('refuses an oversized draft without diffing it', async () => {
    const markdown = 'x'.repeat(DRAFT_CHECK_LIMITS.maxChars);
    const problems = await check({ ...baseline, markdown }, null);
    expect(problems).toEqual([
      {
        check: 'oversized',
        count: DRAFT_CHECK_LIMITS.maxChars + baseline.name.length + baseline.description.length,
        limit: DRAFT_CHECK_LIMITS.maxChars,
      },
    ]);
  });
});
