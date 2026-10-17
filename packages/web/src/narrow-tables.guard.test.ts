import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Legacy 399 (UX acceptance of #644) guard: a plain `.data-table` turns into cards on a narrow
 * window only when it is also marked `.data-table-cards` (styles/pages.css) and its cells carry
 * `data-label`. Without the class, the table keeps its desktop columns at 390px and the right-hand
 * ones end up behind a sideways scroll (or squeezed to a few characters a line). A new plain table
 * either takes the class or is listed here with the reason it reads fine narrow.
 */
const PLAIN_TABLE_ALLOWED: Readonly<Record<string, string>> = {
  'components/platform/PurgeUsersDialog.tsx':
    'outcome list in a dialog: a name and short status columns',
  'components/platform/PurgeWorkspaceDrawer.tsx': 'a three-column count table in a drawer',
};

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

describe('narrow-screen tables (legacy 399)', () => {
  const files = sourceFiles(SRC).map((path) => ({
    path: relative(SRC, path).split('\\').join('/'),
    text: readFileSync(path, 'utf8'),
  }));

  it('every plain data-table turns into cards on a narrow window, or says why it need not', () => {
    const plain = files
      .filter(({ text }) => /^\s*<table className="data-table"/m.test(text))
      .map(({ path }) => path)
      .filter((path) => !(path in PLAIN_TABLE_ALLOWED));
    expect(plain).toEqual([]);
  });

  it('a table marked for cards labels its cells', () => {
    const unlabeled = files
      .filter(({ text }) => text.includes('data-table-cards'))
      .filter(({ text }) => !text.includes('data-label='))
      .map(({ path }) => path);
    expect(unlabeled).toEqual([]);
  });

  it('the allow-list names only files that still have a plain table', () => {
    const stale = Object.keys(PLAIN_TABLE_ALLOWED).filter(
      (path) =>
        !files.some(
          (file) => file.path === path && /^\s*<table className="data-table"/m.test(file.text),
        ),
    );
    expect(stale).toEqual([]);
  });
});
