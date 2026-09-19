import { useMemo } from 'react';
import { CopyId } from './CopyId.js';

/** The five reference kinds of docs/console-completion-plan.md §5.9 "RefChip". */
export type RefKind = 'principal' | 'gatekeeper' | 'workerDefinition' | 'object' | 'actionRequest';

const KIND_LABEL: Readonly<Record<RefKind, { readonly zh: string; readonly en: string }>> = {
  principal: { zh: '主体', en: 'Principal' },
  gatekeeper: { zh: '门', en: 'Gatekeeper' },
  workerDefinition: { zh: 'Worker', en: 'Worker definition' },
  object: { zh: '对象', en: 'Object' },
  actionRequest: { zh: '动作', en: 'Action request' },
};

export interface RefChipProps {
  readonly kind: RefKind;
  readonly id: string;
  /** The display name. Missing → the grey bare-id fallback (§5.9 principle 3). */
  readonly name?: string | null;
  /** When given the name links to the object's page. */
  readonly href?: string;
  readonly size?: 's' | 'm';
  readonly testId?: string;
}

/**
 * components/ui/RefChip (S6-A0, §5.8 "id → 名称" / §5.9 principle 3 "id 永不裸露"): a reference
 * to a Principal / Gatekeeper / WorkerDefinition / graph Object / ActionRequest rendered as
 * name + type label + truncated id + copy (`CopyId`). With `href` the name is a link into the
 * object's page. Without a `name` it degrades to the grey bare-id chip — visibly a fallback, so a
 * missing mapping is noticed rather than mistaken for a name. Pure presentation: it never calls a
 * capability itself; callers resolve names with `useRefNames` over a list they already hold.
 */
export function RefChip({ kind, id, name, href, size = 'm', testId }: RefChipProps) {
  const label = KIND_LABEL[kind];
  const bare = name === undefined || name === null || name === '';
  const classes = [
    'ref-chip',
    `ref-chip-${kind}`,
    size === 's' ? 'ref-chip-s' : '',
    bare ? 'ref-chip-bare' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={classes}
      data-ref-kind={kind}
      data-ref-id={id}
      data-testid={testId}
      title={bare ? `${label.en} ${id}` : `${label.en} ${name} · ${id}`}
    >
      <span className="ref-chip-kind" aria-label={label.en}>
        {label.zh}
      </span>
      {bare ? null : href !== undefined ? (
        <a className="ref-chip-name truncate" href={href}>
          {name}
        </a>
      ) : (
        <span className="ref-chip-name truncate">{name}</span>
      )}
      <CopyId id={id} label={label.en} />
    </span>
  );
}

/** Anything a `list_*` capability returns that carries `items`, or a plain array of rows. */
export type RefNameSource<T> = { readonly items: readonly T[] } | readonly T[] | undefined | null;

/** The name field per kind of row — `list_principals` (`displayName`), `list_gatekeepers` /
 *  `search{objectType:Gatekeeper}` (`name`), `list_worker_definitions` (`definition.name`). */
export function defaultRefName(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  if (typeof record.displayName === 'string' && record.displayName !== '')
    return record.displayName;
  if (typeof record.name === 'string' && record.name !== '') return record.name;
  const definition = record.definition;
  if (definition && typeof definition === 'object') {
    const name = (definition as Record<string, unknown>).name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return undefined;
}

/**
 * Builds the id → name map a page feeds its `RefChip`s from a list envelope it already loaded
 * (`useCapabilityList(http, 'list_principals')`, `list_gatekeepers`, `list_worker_definitions`,
 * …). Memoized on the source identity; a row without a resolvable name is simply absent, so the
 * chip falls back to the bare id. `pick` overrides the default name resolution for other shapes.
 */
export function useRefNames<T extends { readonly id: string }>(
  source: RefNameSource<T>,
  pick: (row: T) => string | undefined = defaultRefName,
): ReadonlyMap<string, string> {
  return useMemo(() => {
    const rows: readonly T[] =
      source === undefined || source === null
        ? []
        : Array.isArray(source)
          ? source
          : (source as { items: readonly T[] }).items;
    const map = new Map<string, string>();
    for (const row of rows) {
      const name = pick(row);
      if (name !== undefined && !map.has(row.id)) map.set(row.id, name);
    }
    return map;
  }, [source, pick]);
}
