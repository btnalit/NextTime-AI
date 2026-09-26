import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * tokens-contrast.test.ts (S8 W1-A8, docs/ui-audit-2026-09-23.md row S5; docs/console-completion-
 * plan.md §5.9 principle 6: "文字对比 ≥ 4.5:1"): parses the live `:root` (light) and
 * `@media (prefers-color-scheme: dark) { :root { … } }` (dark) blocks straight out of `tokens.css`
 * — no hand-copied colour list to drift from the real values — and asserts every text-on-background
 * pair the console actually renders meets WCAG 2.x's 4.5:1 "normal text" contrast minimum, in both
 * themes. A future edit to `tokens.css` that reintroduces a sub-4.5:1 pair fails this test instead
 * of waiting for the next axe/screenshot CI run to notice.
 *
 * Two pair sets, matching how the tokens are actually used (`styles/*.css`):
 *  - `--text` / `--text-2` / `--text-3` are general-purpose — page body, secondary and caption text
 *    rendered on any neutral surface (`--bg`, `--surface-1/2/3`) *and* on `--accent-soft` (the
 *    sidebar's selected-item background, `shell.css`) — so each is checked against every neutral
 *    surface plus every semantic `-soft` background, not only the one surface it happens to sit on
 *    today. This is exactly the gap the audit caught: `--text-3` was only ever verified against
 *    `--surface-1`/white and silently failed at 4.43:1 on `--bg` and 4.16:1 on `--accent-soft`.
 *  - `--ok` / `--warn` / `--danger` / `--info` / `--observe` / `--muted` are governance-semantic —
 *    each is only ever rendered as the text colour of its own chip (its own `-soft` background,
 *    `ui.css`'s `.chip-*` rules) or as plain text/icon colour on a neutral surface, never on a
 *    *different* semantic's `-soft` (a warn-coloured label never sits on a danger chip) — so each
 *    is checked against its own `-soft` plus `--bg`/`--surface-1` only.
 *
 * A dark-theme `-soft` background is a translucent `rgba()` (`ui.css`'s chips render on whatever
 * surface they are placed on), so it is alpha-composited onto `--surface-1` — the surface every
 * chip in the console actually sits on — before computing contrast against it.
 */

const TOKENS_PATH = fileURLToPath(new URL('./tokens.css', import.meta.url));
const DARK_MEDIA_MARKER = '@media (prefers-color-scheme: dark)';

type TokenMap = ReadonlyMap<string, string>;
type Rgb = readonly [number, number, number];

/** Blanks `/* … *\/` block comments (same length, so nothing downstream needs adjusted offsets) —
 *  a rationale comment quoting a real ratio (e.g. "4.43:1 on --bg") must never be mistaken for a
 *  declaration by the regex below. Same technique as `scripts/guards/css-tokens.mjs`. */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** The text between a `{` at `openBraceIndex` and its matching `}` (brace-depth counted, so a
 *  nested `@media { :root { … } }` block is handled correctly from either brace). */
function extractBlock(text: string, openBraceIndex: number): string {
  let depth = 0;
  let start = -1;
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i);
    }
  }
  throw new Error('tokens-contrast.test.ts: unbalanced braces while scanning tokens.css');
}

/** Every `--name: value;` custom property declared directly inside the first `:root { … }` found
 *  in `source`. */
function parseRootBlock(source: string): TokenMap {
  const rootIndex = source.indexOf(':root');
  if (rootIndex === -1) {
    throw new Error('tokens-contrast.test.ts: no :root block found');
  }
  const braceIndex = source.indexOf('{', rootIndex);
  const body = extractBlock(source, braceIndex);
  const tokens = new Map<string, string>();
  const declaration = /--([\w-]+)\s*:\s*([^;]+);/g;
  for (const match of body.matchAll(declaration)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue; // both groups are mandatory (no `?`)
    tokens.set(`--${name}`, value.trim());
  }
  return tokens;
}

function loadThemeTokens(): { light: TokenMap; dark: TokenMap } {
  const css = blankComments(readFileSync(TOKENS_PATH, 'utf8'));
  const darkIndex = css.indexOf(DARK_MEDIA_MARKER);
  if (darkIndex === -1) {
    throw new Error(`tokens-contrast.test.ts: no "${DARK_MEDIA_MARKER}" block found`);
  }
  return {
    light: parseRootBlock(css.slice(0, darkIndex)),
    dark: parseRootBlock(css.slice(darkIndex)),
  };
}

/** `#rgb`/`#rrggbb` or `rgb[a](r, g, b[, a])` → `[r, g, b, a]` (`a` defaults to 1 for an opaque
 *  hex literal or an alpha-less `rgb()`). Every colour token in tokens.css is one of these two
 *  shapes. */
function parseColor(value: string): readonly [number, number, number, number] {
  const hex3or6 = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  const hexGroup = hex3or6?.[1];
  if (hexGroup !== undefined) {
    const digits =
      hexGroup.length === 3
        ? hexGroup
            .split('')
            .map((c) => c + c)
            .join('')
        : hexGroup;
    const n = Number.parseInt(digits, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgbFn = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (rgbFn) {
    const [, r, g, b, a] = rgbFn;
    return [Number(r), Number(g), Number(b), a === undefined ? 1 : Number(a)];
  }
  throw new Error(`tokens-contrast.test.ts: unparseable colour token value "${value}"`);
}

/** Resolves a token's value to an opaque RGB triple, alpha-compositing a translucent `rgba()`
 *  value onto `mountSurface` (every dark-theme `-soft` chip background is translucent — see this
 *  file's module doc comment for why `--surface-1` is the composite base). */
function resolveOpaqueRgb(tokenName: string, tokens: TokenMap, mountSurface: Rgb): Rgb {
  const raw = tokens.get(tokenName);
  if (raw === undefined) {
    throw new Error(`tokens-contrast.test.ts: token ${tokenName} not found`);
  }
  const [r, g, b, a] = parseColor(raw);
  if (a >= 1) return [r, g, b];
  const [mr, mg, mb] = mountSurface;
  return [r * a + mr * (1 - a), g * a + mg * (1 - a), b * a + mb * (1 - a)];
}

function srgbChannelToLinear(c: number): number {
  const normalized = c / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: Rgb): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG 2.x contrast ratio (1:1 .. 21:1) between two opaque colours. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** General-purpose text — checked against every neutral surface and every semantic `-soft`. */
const GENERAL_TEXT_TOKENS = ['--text', '--text-2', '--text-3'] as const;
const ALL_BACKGROUND_TOKENS = [
  '--bg',
  '--surface-1',
  '--surface-2',
  '--surface-3',
  '--accent-soft',
  '--ok-soft',
  '--warn-soft',
  '--danger-soft',
  '--info-soft',
  '--observe-soft',
  '--muted-soft',
] as const;

/** Governance-semantic text — checked only against its own `-soft` and the two neutral page
 *  surfaces it is placed on directly (icon/label colour with no chip background). */
const SEMANTIC_TEXT_TOKENS = [
  '--ok',
  '--warn',
  '--danger',
  '--info',
  '--observe',
  '--muted',
] as const;
const NEUTRAL_SURFACES_FOR_SEMANTIC_TEXT = ['--bg', '--surface-1'] as const;

const { light: lightTokens, dark: darkTokens } = loadThemeTokens();

describe.each([
  ['light', lightTokens],
  ['dark', darkTokens],
] as const)('%s theme token contrast (audit S5, ≥ 4.5:1)', (_themeName, tokens) => {
  const mountSurface = resolveOpaqueRgb('--surface-1', tokens, [255, 255, 255]);

  describe.each(GENERAL_TEXT_TOKENS)(
    '%s on every neutral / semantic-soft background',
    (textToken) => {
      it.each(ALL_BACKGROUND_TOKENS)('meets 4.5:1 on %s', (bgToken) => {
        const fg = resolveOpaqueRgb(textToken, tokens, mountSurface);
        const bg = resolveOpaqueRgb(bgToken, tokens, mountSurface);
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
      });
    },
  );

  // Design system v2: the brand primary button's label on each of its three states.
  it.each(['--primary', '--primary-hover', '--primary-press'])(
    '--text-on-primary meets 4.5:1 on %s',
    (bgToken) => {
      const fg = resolveOpaqueRgb('--text-on-primary', tokens, mountSurface);
      const bg = resolveOpaqueRgb(bgToken, tokens, mountSurface);
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    },
  );

  describe.each(SEMANTIC_TEXT_TOKENS)(
    '%s on its own -soft and the neutral page surfaces',
    (semanticToken) => {
      const pairedBackgrounds = [`${semanticToken}-soft`, ...NEUTRAL_SURFACES_FOR_SEMANTIC_TEXT];
      it.each(pairedBackgrounds)('meets 4.5:1 on %s', (bgToken) => {
        const fg = resolveOpaqueRgb(semanticToken, tokens, mountSurface);
        const bg = resolveOpaqueRgb(bgToken, tokens, mountSurface);
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
      });
    },
  );
});
