import { shortId } from './format.js';

/**
 * lib/same-name: telling apart two rows that share a display name (two members both called
 * 张三, two gates both called `orders`). A name alone is not enough wherever someone picks or
 * grants by it — the owner could grant the wrong person (#559 acceptance) — so every picker and
 * list that names members or gates appends the short id to the names that collide, and only to
 * those: a unique name stays as it is.
 *
 * Two renderings, one rule:
 * - `<option>` text cannot hold an element, so `withSameNameId` appends ` · <shortId>` as text.
 * - Anywhere else, `kit/same-name-id`'s `SameNameId` renders the suffix as its own masked element
 *   (`data-volatile`), so the screenshot gate hides the per-run id while the fixed-width mono text
 *   keeps the layout identical run to run.
 */

/** The ids whose name another row (a different id) also carries. Rows without a name are skipped. */
export function sameNameIds<T>(
  rows: readonly T[] | undefined,
  id: (row: T) => string,
  name: (row: T) => string | null | undefined,
): ReadonlySet<string> {
  const byName = new Map<string, Set<string>>();
  for (const row of rows ?? []) {
    const n = name(row);
    if (n === undefined || n === null || n === '') continue;
    const ids = byName.get(n) ?? new Set<string>();
    ids.add(id(row));
    byName.set(n, ids);
  }
  const out = new Set<string>();
  for (const ids of byName.values()) if (ids.size > 1) for (const each of ids) out.add(each);
  return out;
}

/** `name`, plus ` · <shortId>` when `id` is in `same` — for `<option>` text and plain strings. */
export function withSameNameId(name: string, id: string, same: ReadonlySet<string>): string {
  return same.has(id) ? `${name} · ${shortId(id)}` : name;
}
