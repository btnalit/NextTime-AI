import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

/** Matches one `@fontsource` `@font-face`'s two-source `src` declaration — `format('woff2')`
 *  first, `format('woff')` second, exactly the shape every `@fontsource/*` package ships (see this
 *  plugin's own doc comment). Captures the `woff2` file's own `url(...)` value so it can be
 *  re-expressed relative to the generated `fonts.css` in the replacement. */
const WOFF2_PLUS_WOFF_SRC =
  /src:\s*url\(([^)]+?\.woff2)\)\s*format\('woff2'\),\s*url\([^)]+?\.woff\)\s*format\('woff'\);/g;

/** Every `@import "…";` line's specifier, in file order — `fonts.src.css` is the single source of
 *  truth for which weights/subsets load; this plugin never hard-codes that list itself. */
function importSpecifiers(cssSource: string): readonly string[] {
  return [...cssSource.matchAll(/@import\s+["']([^"']+)["'];/g)].map((match) => match[1] as string);
}

function generateFontsCss(fontsSrcCssPath: string): string {
  const source = readFileSync(fontsSrcCssPath, 'utf8');
  const firstImportIndex = source.indexOf('@import');
  const header = firstImportIndex >= 0 ? source.slice(0, firstImportIndex) : source;
  const outDir = dirname(fontsSrcCssPath); // fonts.css sits next to fonts.src.css

  const bodies = importSpecifiers(source).map((specifier) => {
    const entryPath = require.resolve(specifier);
    const entryDir = dirname(entryPath);
    const css = readFileSync(entryPath, 'utf8');
    return css.replace(WOFF2_PLUS_WOFF_SRC, (_match, woff2Ref: string) => {
      const woff2AbsPath = join(entryDir, woff2Ref.trim());
      const woff2RelPath = relative(outDir, woff2AbsPath).split('\\').join('/');
      return `src: url('${woff2RelPath}') format('woff2');`;
    });
  });

  return [
    '/* GENERATED — do not edit. Source: styles/fonts.src.css, generator:',
    ' * vite-plugins/woff2-only-fonts.ts (S8 W3 F1, leftover 49). Regenerated on every `vite',
    ' * build` / `vite dev` start; gitignored. */',
    '',
    header.trim(),
    '',
    bodies.join('\n'),
  ].join('\n');
}

/**
 * woff2OnlyFonts (S8 W3 F1, leftover 49): every `@fontsource/*` CSS file `styles/fonts.src.css`
 * `@import`s declares BOTH a `.woff2` and a `.woff` `src` for each `@font-face` (`format('woff2')`
 * first, `format('woff')` as a fallback). Vite bundles whichever files a CSS `url()` references, so
 * both land in `dist/assets/` even though no browser this console targets lacks woff2 support —
 * that fallback is roughly half of the ~12 MB of self-hosted font files in `dist` (Noto Sans SC
 * alone ships 102 unicode-range slices per weight).
 *
 * Approach: write the real `fonts.css` file to disk in `buildStart`, rather than intercepting the
 * import inside Vite's own plugin pipeline (a `load`/`transform` hook keyed on `fonts.css`'s
 * module id, tried first and reverted — see this file's git history). `fonts.css` is reached only
 * through a nested CSS `@import` chain (`base.css` → `fonts.css`; `base.css` itself is only
 * `@import`ed from `styles.css`, the one file `main.tsx` actually imports via a JS `import`
 * statement): Vite's own CSS plugin inlines every nested `@import` with `postcss-import`, which
 * reads each imported file straight off disk (`fs.readFile`) as part of *one* transform call on
 * the top-level entry module — it never asks Vite's plugin container to `load()` the nested file
 * as its own module, so a `load`/`transform` hook keyed on `fonts.css`'s id is never invoked for
 * it. Writing the file's real bytes to disk before that pipeline ever runs sidesteps the question
 * entirely: whatever postcss-import reads is already woff2-only, regardless of which internal
 * mechanism resolves the nested `@import`.
 *
 * The generator itself (`generateFontsCss`) reads `fonts.src.css`'s own `@import` list (so that
 * file, not this plugin, stays the single source of truth for which weights/subsets load), reads
 * each resolved `@fontsource` package's real CSS from `node_modules`, and rewrites every
 * `src: url(…woff2) format('woff2'), url(…woff) format('woff');` down to the `woff2` half only —
 * `font-family`/`font-weight`/`font-style`/`font-display`/`unicode-range` (the CJK slicing) are
 * copied through untouched, so exactly the same glyph ranges and weights still load, just without
 * the unused fallback file ever being written or referenced.
 */
export function woff2OnlyFonts(): Plugin {
  let root = process.cwd();
  return {
    name: 'nexttime-woff2-only-fonts',
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      const fontsSrcCssPath = join(root, 'src/styles/fonts.src.css');
      const fontsCssPath = join(dirname(fontsSrcCssPath), 'fonts.css');
      writeFileSync(fontsCssPath, generateFontsCss(fontsSrcCssPath));
    },
  };
}
