import { DRAFT_CHECK_LIMITS, type DraftCheckProblemWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import { sealWithholds } from '../eval-seal/index.js';

/**
 * application/eval/draft-check: the check a Skill draft passes before an evaluation of it starts
 * (S10 E3-2b; docs/s10-evolution-plan-2026-10-04.md §5.5 审查器 level 0 — `@nexttime/shared`
 * draft-evaluation.ts says what each check means). Every check runs; the caller refuses the start
 * when any fails (400 `draft_check_failed`), naming each failed check with what it counted, never
 * the text it found.
 */

export interface SkillText {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
}

/** A platform-shaped id: a UUID, any version, either case. */
const PLATFORM_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The lines a Skill is diffed by: its name, its description (one line, however it wraps) and each
 *  line of its body. */
function lines(skill: SkillText): string[] {
  return [
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    ...skill.markdown.split('\n'),
  ];
}

/** Lines added or removed going from `before` to `after` (their longest common subsequence kept). */
export function changedLineCount(before: readonly string[], after: readonly string[]): number {
  // One row of the LCS table at a time: O(n·m) time, O(m) memory. The size check bounds n and m.
  let previous = new Uint32Array(after.length + 1);
  let current = new Uint32Array(after.length + 1);
  for (let i = 1; i <= before.length; i += 1) {
    for (let j = 1; j <= after.length; j += 1) {
      current[j] =
        before[i - 1] === after[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    [previous, current] = [current, previous];
  }
  const common = previous[after.length] ?? 0;
  return before.length - common + (after.length - common);
}

/**
 * The failed checks of `draft`, against `baseline` (the version it would replace; `null` for a new
 * Skill). Empty when it passes. `client` is the caller's transaction, for the seal.
 */
export async function checkSkillDraft(
  client: PoolClient,
  workspaceId: string,
  draft: SkillText,
  baseline: SkillText | null,
): Promise<readonly DraftCheckProblemWire[]> {
  const problems: DraftCheckProblemWire[] = [];
  const text = { name: draft.name, description: draft.description, markdown: draft.markdown };

  const secrets = findSuspectedSecrets(text).count;
  if (secrets > 0) problems.push({ check: 'credential_like', count: secrets, limit: null });

  const ids = [draft.name, draft.description, draft.markdown].reduce(
    (sum, value) => sum + (value.match(PLATFORM_ID)?.length ?? 0),
    0,
  );
  if (ids > 0) problems.push({ check: 'internal_id', count: ids, limit: null });

  const chars = [...draft.name].length + [...draft.description].length + [...draft.markdown].length;
  const oversized = chars > DRAFT_CHECK_LIMITS.maxChars;
  if (oversized) {
    problems.push({ check: 'oversized', count: chars, limit: DRAFT_CHECK_LIMITS.maxChars });
  }

  if (
    baseline !== null &&
    baseline.name === draft.name &&
    baseline.description === draft.description &&
    baseline.markdown === draft.markdown
  ) {
    problems.push({ check: 'unchanged', count: null, limit: null });
  } else if (!oversized) {
    // An oversized draft is refused already; its diff is not worth the work.
    const changed =
      baseline === null ? lines(draft).length : changedLineCount(lines(baseline), lines(draft));
    if (changed > DRAFT_CHECK_LIMITS.maxChangedLines) {
      problems.push({
        check: 'edit_budget',
        count: changed,
        limit: DRAFT_CHECK_LIMITS.maxChangedLines,
      });
    }
  }

  if (await sealWithholds(client, workspaceId, text)) {
    problems.push({ check: 'contaminated', count: null, limit: null });
  }
  return problems;
}
