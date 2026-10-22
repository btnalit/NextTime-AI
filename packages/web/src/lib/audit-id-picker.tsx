import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Combobox } from '../components/kit/combobox.js';
import { ErrorBanner } from '../components/kit/error-banner.js';
import { Field } from '../components/kit/field.js';
import { type PickerOption, type PickerSource, optionMatches } from './audit-pickers.js';
import type { CapabilityCaller } from './clients.js';
import { isForbiddenError } from './errors.js';
import { shortId } from './format.js';
import { useT } from './i18n.js';

/**
 * lib/audit-id-picker: an id field that offers what already exists — one free-entry
 * `kit/combobox` (legacy 153 ①). The box stays the value (a pasted id or a deep link's pre-filled
 * id always works), and its list offers candidates from a `PickerSource` (`lib/audit-pickers.ts`):
 * picking one fills the box, and a "已选" line names the picked id. Typing narrows the list — server-side for a searchable
 * source (debounced), in the browser otherwise. A refused source (403) falls back to the
 * source's `fallback` with a note, or to the plain box with a one-line note.
 */

interface LoadResult {
  readonly options: readonly PickerOption[];
  /** The primary source was refused and `fallback` answered instead. */
  readonly degraded: boolean;
  /** Whether the answering source filters server-side. */
  readonly searchable: boolean;
}

/** Loads per signed-in caller, kept for `CACHE_TTL_MS` — two pickers on one page asking the same
 *  capability with the same query share one call, and a later visit still sees fresh rows. A
 *  failed load is dropped at once so a retry re-asks. */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly at: number;
  readonly pending: Promise<LoadResult>;
}

const cacheByCaller = new WeakMap<CapabilityCaller, Map<string, CacheEntry>>();

async function loadWithFallback(
  http: CapabilityCaller,
  source: PickerSource,
  query: string,
): Promise<LoadResult> {
  try {
    const options = await source.load(http, query);
    return { options, degraded: false, searchable: source.searchable };
  } catch (err) {
    if (!source.fallback || !isForbiddenError(err)) throw err;
    const options = await source.fallback.load(http, '');
    return { options, degraded: true, searchable: false };
  }
}

function cachedLoad(
  http: CapabilityCaller,
  source: PickerSource,
  query: string,
): Promise<LoadResult> {
  let byKey = cacheByCaller.get(http);
  if (!byKey) {
    byKey = new Map();
    cacheByCaller.set(http, byKey);
  }
  const key = `${source.key}::${query}`;
  const now = Date.now();
  const existing = byKey.get(key);
  if (existing && now - existing.at < CACHE_TTL_MS) return existing.pending;
  const pending = loadWithFallback(http, source, query);
  const entry: CacheEntry = { at: now, pending };
  byKey.set(key, entry);
  pending.catch(() => {
    if (byKey?.get(key) === entry) byKey.delete(key);
  });
  return pending;
}

function forgetSource(http: CapabilityCaller, source: PickerSource): void {
  const byKey = cacheByCaller.get(http);
  if (!byKey) return;
  for (const key of byKey.keys()) if (key.startsWith(`${source.key}::`)) byKey.delete(key);
}

export type PickerState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly result: LoadResult }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error'; readonly error: unknown };

/** The candidates `source` offers for `query` (ignored by a non-searchable source). */
export function usePickerOptions(
  http: CapabilityCaller,
  source: PickerSource | null,
  query: string,
): { readonly state: PickerState; readonly reload: () => void } {
  const [state, setState] = useState<PickerState>({ status: source ? 'loading' : 'idle' });
  const [attempt, setAttempt] = useState(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const sourceKey = source?.key ?? null;
  const effectiveQuery = source?.searchable ? query.trim() : '';

  useEffect(() => {
    void attempt;
    const current = sourceRef.current;
    if (sourceKey === null || !current) {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    setState({ status: 'loading' });
    cachedLoad(http, current, effectiveQuery).then(
      (result) => {
        if (live) setState({ status: 'ready', result });
      },
      (error: unknown) => {
        if (!live) return;
        setState(isForbiddenError(error) ? { status: 'forbidden' } : { status: 'error', error });
      },
    );
    return () => {
      live = false;
    };
  }, [http, sourceKey, effectiveQuery, attempt]);

  const reload = useCallback(() => {
    if (sourceRef.current) forgetSource(http, sourceRef.current);
    setAttempt((n) => n + 1);
  }, [http]);

  return { state, reload };
}

export function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** The short id after the label, unless the label already shows it (a row with no name is
 *  labelled by its id — `4df1c17f` — and need not repeat it, UX P3 on #672). */
function idSuffix(option: PickerOption): string | undefined {
  return option.label.includes(shortId(option.id)) ? undefined : shortId(option.id);
}

export function optionText(option: PickerOption): string {
  const parts = [option.label];
  if (option.detail) parts.push(option.detail);
  const suffix = idSuffix(option);
  if (suffix) parts.push(suffix);
  return parts.join(' · ');
}

export interface AuditIdPickerProps {
  readonly http: CapabilityCaller;
  /** The combobox input's id (its `<label>` points here). */
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** `null`: no candidates yet (`noSourceNote` says why) — the box alone. */
  readonly source: PickerSource | null;
  readonly noSourceNote?: string;
  /** Replaces the default "refused" note when the source (and its fallback) is refused. */
  readonly refusedNote?: string;
  /** Replaces the default "degraded to the audit log" note. */
  readonly degradedNote?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly mono?: boolean;
  /** The input's `data-testid`; the notes derive from it (`-picked`, `-empty`, …). */
  readonly testId: string;
}

const SEARCH_DEBOUNCE_MS = 250;

export function AuditIdPicker({
  http,
  id,
  label,
  hint,
  value,
  onChange,
  source,
  noSourceNote,
  refusedNote,
  degradedNote,
  placeholder,
  disabled = false,
  mono = true,
  testId,
}: AuditIdPickerProps) {
  const t = useT();
  // What the reader typed — the search text. Picking a candidate changes `value`, not this, so
  // the list stays as it was when they picked.
  const [typed, setTyped] = useState('');
  const debounced = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  const { state, reload } = usePickerOptions(http, source, debounced);

  // Every option seen so far, so a picked (or deep-linked) id keeps its name after the list
  // moves on to another search.
  const knownRef = useRef(new Map<string, PickerOption>());
  const loaded = state.status === 'ready' ? state.result.options : undefined;
  if (loaded) for (const option of loaded) knownRef.current.set(option.id, option);
  const picked = value === '' ? undefined : knownRef.current.get(value);

  // The picked (or deep-linked) id stays among the options so the list can show it selected.
  const options = useMemo(() => {
    const rows = loaded ?? [];
    const all =
      picked && !rows.some((option) => option.id === picked.id) ? [picked, ...rows] : rows;
    return all.map((option) => ({
      value: option.id,
      label: option.label,
      secondary: [option.detail, idSuffix(option)]
        .filter((part) => part !== undefined && part !== '')
        .join(' · '),
    }));
  }, [loaded, picked]);
  // The typed text, unless it is a picked id (that is not a search).
  const text = typed.trim();

  return (
    <Field id={id} label={label} hint={hint}>
      {/* Legacy 153 ①: one field — the box is the value (a pasted id or a deep link's id always
       *  works), and its list offers the candidates. It used to be a text box over a `<select>`. */}
      <Combobox
        id={id}
        allowFreeEntry
        options={source ? options : []}
        value={value}
        onChange={(next) => {
          onChange(next);
          // A picked candidate is not a search: the list stays as it was when it was picked.
          if (!knownRef.current.has(next)) setTyped(next);
        }}
        loading={state.status === 'loading'}
        placeholder={
          placeholder ??
          (source
            ? t('粘贴 ID，或输入关键字筛选', 'Paste an id or type to filter')
            : t('粘贴 ID', 'Paste an id'))
        }
        disabled={disabled}
        mono={mono}
        emptyText={
          state.status === 'forbidden'
            ? t('无权读取候选。', 'Suggestions unavailable.')
            : state.status === 'error'
              ? t('候选加载失败。', 'Could not load suggestions.')
              : text !== '' && !knownRef.current.has(text)
                ? t(
                    '没有匹配的候选；将按输入的值查询。',
                    'No matching suggestions — the typed value is used as is.',
                  )
                : t(
                    '还没有可选的记录；可直接粘贴 ID。',
                    'Nothing to pick yet — paste an id instead.',
                  )
        }
        testId={testId}
      />
      {!source && noSourceNote ? (
        <p className="field-hint" data-testid={`${testId}-no-source`}>
          {noSourceNote}
        </p>
      ) : null}
      {picked ? (
        <p className="field-hint" data-testid={`${testId}-picked`}>
          {t(`已选：${optionText(picked)}`, `Selected: ${optionText(picked)}`)}
        </p>
      ) : null}
      {state.status === 'ready' && state.result.degraded ? (
        <p className="field-hint" data-testid={`${testId}-degraded`}>
          {degradedNote ??
            t(
              '无权读取完整列表；候选来自审计记录中最近出现的 ID。',
              'The full list is not readable for your role; suggestions come from recent audit rows.',
            )}
        </p>
      ) : null}
      {state.status === 'forbidden' ? (
        <p className="field-hint" data-testid={`${testId}-refused`}>
          {refusedNote ??
            t(
              '当前角色无权读取候选列表，请直接粘贴 ID。',
              'Your role cannot read the suggestion list — paste an id instead.',
            )}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法加载候选', 'Could not load suggestions')}
          onRetry={reload}
          testId={`${testId}-error`}
        />
      ) : null}
    </Field>
  );
}
