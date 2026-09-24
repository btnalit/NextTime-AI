import type { ResolvedRefKind, ResolvedRefWire } from '@nexttime/shared';
import { useEffect, useRef, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { cn } from '../../lib/cn.js';
import { shortId } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';

/**
 * components/kit/ref-chip (S8 W1-A6, audit S10 "id 永不裸露", docs/console-completion-plan.md §5.9
 * principle 3): the kit replacement for `components/ui/RefChip` — a reference to any of the nine
 * `resolve_refs` kinds (graph Object incl. Gatekeeper/Operation, Principal, WorkerDefinition,
 * ActionRequest, Task, Chat, Workspace) rendered as kind label + name + truncated id + copy, never
 * a bare id. Two ways to get a name:
 *
 *   - **Caller-supplied** (`name` prop) — the fast path for a page that already loaded a directory
 *     (`list_principals`, `list_worker_definitions`, …) and resolved the name itself; no network
 *     call.
 *   - **Self-resolving** (`http` prop, `name` omitted) — the chip calls `useResolveRefs` itself.
 *     Every `RefChip` on a page passing `http` this way, across every kind, shares one
 *     `resolve_refs` batch per render tick (see that hook's own doc comment) — dropping one into a
 *     row that used to show a bare id is a one-line fix, not a page-level data-loading change.
 *
 * Neither given (no `name`, no `http`) — or `resolve_refs` ran and the id was not in its result
 * (unknown, invisible, or purged) — renders the degrade state: short id + "未知 / 已删除", never a
 * bare full UUID text node. `href`, when given, links the resolved name to the entity's own page;
 * the chip never computes a route itself (every route lives in `lib/router.ts`, kept there).
 */

const KIND_LABEL: Readonly<Record<ResolvedRefKind, { readonly zh: string; readonly en: string }>> =
  {
    object: { zh: '对象', en: 'Object' },
    principal: { zh: '主体', en: 'Principal' },
    gatekeeper: { zh: '门', en: 'Gatekeeper' },
    operation: { zh: '操作', en: 'Operation' },
    workerDefinition: { zh: 'Worker', en: 'Worker definition' },
    actionRequest: { zh: '动作', en: 'Action request' },
    task: { zh: '任务', en: 'Task' },
    chat: { zh: '对话', en: 'Chat' },
    workspace: { zh: '工作区', en: 'Workspace' },
  };

export interface RefChipProps {
  readonly kind: ResolvedRefKind;
  readonly id: string;
  /** The display name — omit to self-resolve via `http` (see the module doc comment); `null`/`''`
   *  is treated the same as omitted. */
  readonly name?: string | null;
  readonly typeName?: string;
  /** When given (with a name, from either source) the name links to the entity's own page. */
  readonly href?: string;
  readonly size?: 's' | 'm';
  /** Self-resolves this chip's own `name` through the batched `useResolveRefs` hook when `name`
   *  is not already given. Omit for a purely presentational chip (tests, a page with no session). */
  readonly http?: CapabilityCaller;
  readonly testId?: string;
}

export function RefChip({
  kind,
  id,
  name,
  typeName,
  href,
  size = 'm',
  http,
  testId,
}: RefChipProps) {
  const t = useT();
  const needsResolve = (name === undefined || name === null || name === '') && http !== undefined;
  const { get } = useResolveRefs(needsResolve ? http : undefined, needsResolve ? [id] : EMPTY_IDS);
  const resolved = needsResolve ? get(id) : undefined;
  const effectiveName = name ?? resolved?.name;
  const effectiveTypeName = typeName ?? resolved?.typeName;
  const bare = effectiveName === undefined || effectiveName === null || effectiveName === '';
  const label = KIND_LABEL[kind];

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-m border px-1.5 py-0.5 text-12',
        bare
          ? 'border-border bg-surface-2 text-text-3'
          : 'border-border-strong bg-surface-1 text-text',
        size === 's' ? 'h-6' : 'h-7',
      )}
      data-ref-kind={kind}
      data-ref-id={id}
      data-testid={testId}
      title={bare ? `${label.en} ${id}` : `${label.en} ${effectiveName} · ${id}`}
    >
      <span className="shrink-0 text-text-3" aria-label={label.en}>
        {label.zh}
      </span>
      {bare ? (
        <span
          className="truncate font-mono"
          data-testid={testId ? `${testId}-fallback` : undefined}
          data-volatile=""
        >
          {shortId(id)} {t('· 未知 / 已删除', 'Unknown / deleted')}
        </span>
      ) : href !== undefined ? (
        <a className="truncate text-accent hover:underline" href={href}>
          {effectiveName}
        </a>
      ) : (
        <span className="truncate">{effectiveName}</span>
      )}
      {effectiveTypeName !== undefined && !bare ? (
        <span className="shrink-0 text-text-3">({effectiveTypeName})</span>
      ) : null}
      <CopyIdButton id={id} label={label.en} />
    </span>
  );
}

/** Copy-to-clipboard for the full id — kept inline (not `components/ui/CopyId`) so this file
 *  imports nothing from `components/ui/*` (S8 §5e risk ①, `scripts/guards/css-tokens.mjs`).
 *  `h-9 w-9` unconditionally, regardless of the chip's own `size`: the audit's own S6 floor ("≥
 *  36px hit area") is about the *tap target*, not the chip's visual height — a small chip with a
 *  small-looking icon still needs a full 36px square to actually hit it on a touch screen. */
function CopyIdButton({ id, label }: { readonly id: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className="-my-1 -mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-m text-text-3 hover:bg-surface-3 hover:text-text"
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      aria-label={copied ? 'Copied' : `Copy ${label} id`}
      title={id}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M5 12.5 9.5 17 19 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M8 8h11v11H8zM5 16V5h11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

// -------------------------------------------------------------------------------------------
// useResolveRefs: batches `resolve_refs` lookups across every `RefChip` (and any other caller)
// rendered in the same tick, one `caller` at a time.
// -------------------------------------------------------------------------------------------

const EMPTY_IDS: readonly string[] = [];
const MAX_BATCH_SIZE = 200;

interface PendingBatch {
  readonly ids: Set<string>;
  readonly listeners: Map<string, Set<() => void>>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One session cache and one pending-batch queue per `CapabilityCaller` instance — mirrors
 *  `hooks/useCapability.ts`'s own `cacheByCaller` WeakMap, so a signed-out/signed-in swap (a new
 *  `caller`) starts cold rather than leaking a name across principals. `null` = resolved, not
 *  found (render the fallback); absent = never asked, or still pending. */
const cacheByCaller = new WeakMap<CapabilityCaller, Map<string, ResolvedRefWire | null>>();
const batchByCaller = new WeakMap<CapabilityCaller, PendingBatch>();

function getCache(caller: CapabilityCaller): Map<string, ResolvedRefWire | null> {
  let cache = cacheByCaller.get(caller);
  if (!cache) {
    cache = new Map();
    cacheByCaller.set(caller, cache);
  }
  return cache;
}

function getBatch(caller: CapabilityCaller): PendingBatch {
  let batch = batchByCaller.get(caller);
  if (!batch) {
    batch = { ids: new Set(), listeners: new Map(), timer: null };
    batchByCaller.set(caller, batch);
  }
  return batch;
}

function notify(batch: PendingBatch, id: string): void {
  const listeners = batch.listeners.get(id);
  if (!listeners) return;
  batch.listeners.delete(id);
  for (const listener of listeners) listener();
}

async function flush(caller: CapabilityCaller): Promise<void> {
  const batch = getBatch(caller);
  batch.timer = null;
  if (batch.ids.size === 0) return;
  const ids = [...batch.ids].slice(0, MAX_BATCH_SIZE);
  for (const id of ids) batch.ids.delete(id);
  const cache = getCache(caller);
  try {
    const result = await caller.call<{ items: readonly ResolvedRefWire[] }>('resolve_refs', {
      ids,
    });
    const byId = new Map(result.items.map((item) => [item.id, item]));
    for (const id of ids) cache.set(id, byId.get(id) ?? null);
  } catch {
    // Best-effort: leave these ids uncached (not `null`) on a transient failure — a later
    // request for the same id (a remount, a retry) tries `resolve_refs` again instead of being
    // stuck permanently on the degrade state for the rest of the session.
  }
  for (const id of ids) notify(batch, id);
  if (batch.ids.size > 0) scheduleFlush(caller);
}

function scheduleFlush(caller: CapabilityCaller): void {
  const batch = getBatch(caller);
  if (batch.timer !== null) return;
  batch.timer = setTimeout(() => {
    void flush(caller);
  }, 0);
}

export interface UseResolveRefsResult {
  /** `undefined` while pending (never asked yet, or the batch has not returned); the resolved
   *  `ResolvedRefWire` on success; `null` once `resolve_refs` ran and this id was not in its
   *  result (unknown, invisible, or the wrong kind for what the caller expected) — render the
   *  fallback state for both `undefined` and `null`, same as `RefChip` itself does. */
  readonly get: (id: string) => ResolvedRefWire | null | undefined;
}

/**
 * Batches `resolve_refs` lookups for `ids` across every hook instance (every `RefChip`, or a
 * page calling this directly) rendered against the same `caller` in the same tick: each mount
 * registers its own ids into a shared per-`caller` queue and schedules a `setTimeout(0)` flush —
 * every other instance's mount effect that runs before that timer fires (React batches effects
 * from the same commit) adds to the *same* queue, so the whole tick's worth of ids goes out as
 * one `resolve_refs` call, bounded to 200 ids (its own ceiling) per call. Resolved ids are cached
 * for the rest of this `caller`'s session (`cacheByCaller`) — a later render asking for an
 * already-cached id never re-requests it. `caller: undefined` (no session, a presentational-only
 * render) returns everything `undefined` and issues no calls.
 */
export function useResolveRefs(
  caller: CapabilityCaller | undefined,
  ids: readonly string[],
): UseResolveRefsResult {
  const idsKey = ids.join(',');
  const mounted = useRef(true);
  const [, forceRender] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!caller || idsKey === '') return;
    const cache = getCache(caller);
    const batch = getBatch(caller);
    // Re-derived from `idsKey` (the effect's real dependency), not the outer `ids` closure — an
    // effect that closed over `ids` directly would need it in the dependency array, which would
    // re-run on every render (a fresh array literal, same content) instead of only when the
    // batch of ids actually changes.
    const uniqueIds = [...new Set(idsKey.split(','))].filter((id) => id !== '' && !cache.has(id));
    if (uniqueIds.length === 0) return;
    const rerender = () => {
      if (mounted.current) forceRender((n) => n + 1);
    };
    for (const id of uniqueIds) {
      batch.ids.add(id);
      let listeners = batch.listeners.get(id);
      if (!listeners) {
        listeners = new Set();
        batch.listeners.set(id, listeners);
      }
      listeners.add(rerender);
    }
    scheduleFlush(caller);
    return () => {
      for (const id of uniqueIds) batch.listeners.get(id)?.delete(rerender);
    };
  }, [caller, idsKey]);

  return {
    get: (id: string) => (caller ? getCache(caller).get(id) : undefined),
  };
}
