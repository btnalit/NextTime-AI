import * as shared from '@nexttime/shared';

/**
 * e2e/00-gates/copy-patterns.ts: the "does this look like an implementation detail leaking into
 * user-visible copy" patterns `content.spec.ts`'s copy guard checks every surface's rendered text
 * against (F5 "文案守卫", development-tasks.md §5e; audit rows S10/S14). Five kinds, each with a
 * `PatternId` used as the ratchet baseline's second key (`copy-guard-baseline.json`:
 * `surfaceId -> patternId -> [{sample, count}]`).
 */

export type PatternId = 'uuid' | 'raw-enum' | 'internal-codename' | 'env-var' | 'runbook-path';

export interface CopyPattern {
  readonly id: PatternId;
  readonly regex: RegExp;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Derived from `@nexttime/shared`'s wire enums rather than hand-typed (task instruction) — every
 * `*_VALUES` `as const` array (enums.ts, transitions.ts's own status re-exports) and every Zod
 * `z.enum([...])`'s `.options` (wire/*.ts, e.g. `ConnectorModeWireSchema` — `platform_preset`/
 * `self_serve`). Restricted to snake_case (multi-word, contains `_`) values only: a single-word
 * value like `owner`/`member`/`entry` is *also* the intentional English half of this app's
 * bilingual role/kind labels (StatusChip, §5.9) — flagging every one of those as a "raw enum leak"
 * would make the ratchet baseline almost entirely false positives and hide the real snake_case
 * leaks (`waiting_approval`, `platform_preset`, …) the audit rows actually named. A single-word
 * enum value leaking unmapped (audit S14's specific "owner / entry" instances) is a StatusChip
 * mapping gap for that page to fix directly — not something a page-agnostic text scan can tell
 * apart from an intentional bilingual label without the page's own rendering context.
 */
function deriveEnumTokens(): readonly string[] {
  const tokens = new Set<string>();
  for (const value of Object.values(shared)) {
    let candidates: readonly unknown[] | undefined;
    if (Array.isArray(value)) {
      candidates = value;
    } else if (
      value !== null &&
      typeof value === 'object' &&
      'options' in value &&
      Array.isArray((value as { options?: unknown }).options)
    ) {
      candidates = (value as { options: readonly unknown[] }).options;
    }
    if (candidates === undefined) continue;
    if (!candidates.every((item) => typeof item === 'string')) continue;
    for (const item of candidates as readonly string[]) {
      if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(item)) tokens.add(item);
    }
  }
  return [...tokens].sort();
}

export const ENUM_TOKENS = deriveEnumTokens();

function enumRegex(): RegExp {
  // Longest-first so e.g. a hypothetical `foo_bar_baz` is matched whole rather than as `foo_bar`.
  const sorted = [...ENUM_TOKENS].sort((a, b) => b.length - a.length);
  const alternation = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\b(?:${alternation})\\b`, 'g');
}

const INTERNAL_CODENAME_PATTERNS = [
  /\bP-[A-Z][A-Za-z0-9]*\b/g, // P-B2a, P-A1, P-C
  /\b[SWI]\d{1,3}(?:-[A-Z]\d*)?\b/g, // S7-E, W1-A, W1-B, I16, S10
  /遗留\s?\d+/g, // 遗留 N
] as const;

const ENV_VAR_PATTERNS = [
  /\bNEXTTIME_[A-Z0-9_]+\b/g,
  /\bPI_DRIFT_FILE\b/g,
  /\bFAKE_LLM_[A-Z0-9_]+\b/g,
  // Generic ALL_CAPS_SNAKE shape (>=2 segments) — catches an env-var-shaped name this list didn't
  // enumerate by hand, at the cost of also matching a legitimate all-caps constant if one is ever
  // rendered verbatim (acceptable: it would still be worth a human look, and the ratchet baseline
  // absorbs anything already on screen today without failing CI).
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g,
] as const;

const RUNBOOK_PATH_RE = /docs\/runbooks\/[\w./-]+/g;

/** One entry per `PatternId` — `content.spec.ts` runs every regex against a surface's visible
 *  text and records each match under its pattern id. */
export function allPatterns(): readonly CopyPattern[] {
  return [
    { id: 'uuid', regex: UUID_RE },
    { id: 'raw-enum', regex: enumRegex() },
    ...INTERNAL_CODENAME_PATTERNS.map((regex) => ({ id: 'internal-codename' as const, regex })),
    ...ENV_VAR_PATTERNS.map((regex) => ({ id: 'env-var' as const, regex })),
    { id: 'runbook-path', regex: RUNBOOK_PATH_RE },
  ];
}
