import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Legacy 637 guard: a `<fieldset>` is plain by default (`styles/base.css`) and a group that should
 * read as a box takes `.fieldset-box` (`styles/ui.css`). A page that resets the user agent's border
 * inline again, or draws its own box with Tailwind border utilities, brings back the second and
 * third look this legacy item removed.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));

/** A fieldset's opening tag, on one line or several (up to its first `>` that ends the tag). */
const FIELDSET_TAG = /<fieldset\b(?:=>|[^>])*>/g;
/** An inline `style` on the tag, or a Tailwind border / padding utility in its className. */
const OWN_LOOK = /\bstyle=\{|className="[^"]*\b(?:border|rounded-[a-z]+|p-\d)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

function ownLooks(text: string): string[] {
  return (text.match(FIELDSET_TAG) ?? []).filter((tag) => OWN_LOOK.test(tag));
}

describe('fieldsets (legacy 637)', () => {
  it('no fieldset styles its own border, padding or margin', () => {
    const offenders = sourceFiles(SRC).flatMap((path) =>
      ownLooks(readFileSync(path, 'utf8')).map(
        (tag) => `${relative(SRC, path).split('\\').join('/')}: ${tag.replace(/\s+/g, ' ')}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('the pattern catches an inline reset and a hand-drawn box, on one line or several', () => {
    expect(ownLooks('<fieldset className="field" style={{ border: 0, padding: 0 }}>')).toHaveLength(
      1,
    );
    expect(
      ownLooks(
        '<fieldset\n  className="stack-s rounded-m border border-border p-3"\n  tabIndex={-1}\n>',
      ),
    ).toHaveLength(1);
    expect(ownLooks('<fieldset className="stack-s fieldset-box" data-testid="x">')).toEqual([]);
    expect(
      ownLooks('<fieldset\n  className="stack-s"\n  aria-label={typeof a === "string" ? a : b}\n>'),
    ).toEqual([]);
  });
});
