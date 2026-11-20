/**
 * lib/chunk-reload (legacy 880): what to do when a page's code chunk fails to load.
 *
 * A route is a `React.lazy` chunk (routes.tsx), fetched the first time someone opens that page.
 * The fetch can fail with nothing wrong on the server: Chromium aborts every request in flight
 * when the machine's network changes (`net::ERR_NETWORK_CHANGED` — a laptop moving between Wi-Fi
 * and cable, a VPN coming up; on the CI runner, docker recreating the kernel container), and a
 * release can replace the hashed file this tab's `index.html` still names. Either way the browser
 * remembers the failed module for the rest of the page's life — a second `import()` of the same
 * chunk, or of any chunk that imports the failed one, rejects at once without fetching again
 * (checked in Chromium: a cache-busting query on the page chunk does not help, its dependencies
 * keep their URLs). So retrying inside the page cannot work; only a reload does.
 *
 * `reloadForChunkError` reloads once, by itself, when that is safe: the server is answering again
 * (a fresh `fetch` of this page, which the module cache does not touch) and this tab has not just
 * done the same — the marker below keeps a chunk that fails on every load from reloading in a loop.
 * Otherwise the caller shows its 「刷新页面」 fallback, and the person decides.
 *
 * A reload must never throw away something a person typed. By the time a route boundary has
 * caught the failure, the page it wraps is gone (the boundary replaced it with its fallback), and
 * the one chunk loaded *inside* a page — the chat's Markdown — has its own boundary that falls back
 * to plain text without leaving the page (`chat/MessageBody`). As a guard for whatever else is
 * still on screen, `hasUnsentInput` looks at every field left in the document: any text in one,
 * or a file picked, and the page is not reloaded by itself — the person gets 「刷新页面」 instead.
 */

const MARKER_KEY = 'nexttime.chunkReloadAt';
/** A reload this recent that still ends in a failed chunk is not tried again by itself. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;
/** The probe gives up quickly: a server that takes this long is not one to reload into. */
const PROBE_TIMEOUT_MS = 5_000;

/** The messages browsers and Vite's preload helper give a chunk that did not load: Chromium,
 *  Firefox, Safari, then Vite's `__vitePreload` (CSS of a chunk). */
const CHUNK_ERROR_PATTERNS: readonly RegExp[] = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function lastReloadAt(): number | null {
  try {
    const raw = sessionStorage.getItem(MARKER_KEY);
    const at = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function markReload(at: number): boolean {
  try {
    sessionStorage.setItem(MARKER_KEY, String(at));
    return true;
  } catch {
    // No marker means no loop guard: do not reload by ourselves at all.
    return false;
  }
}

async function serverAnswers(fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(window.location.pathname, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const TEXT_FIELDS =
  'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"])';

/** Whether any field still in `root` holds text, or a picked file — something a reload would
 *  lose. Selects, checkboxes and the like are not counted: a reload puts their state back from
 *  the server or loses nothing a person typed. */
export function hasUnsentInput(root: ParentNode = document): boolean {
  for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_FIELDS)) {
    if (field instanceof HTMLInputElement && field.type === 'file') {
      if ((field.files?.length ?? 0) > 0) return true;
      continue;
    }
    if (field.value.trim() !== '') return true;
  }
  for (const editable of root.querySelectorAll<HTMLElement>(
    '[contenteditable]:not([contenteditable="false"])',
  )) {
    if ((editable.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

export interface ChunkReloadDeps {
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly reload?: () => void;
  readonly online?: () => boolean;
  readonly unsentInput?: () => boolean;
}

/** Reloads the page once for a chunk that failed to load, when nothing typed is left on the
 *  page, the server answers and this tab has not reloaded for the same reason within
 *  `CHUNK_RELOAD_WINDOW_MS`. Resolves `true` once the reload is under way, `false` when the
 *  caller should show its fallback instead. */
export async function reloadForChunkError(deps: ChunkReloadDeps = {}): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const online = deps.online ?? (() => navigator.onLine !== false);
  if (!online()) return false;
  if ((deps.unsentInput ?? hasUnsentInput)()) return false;
  const last = lastReloadAt();
  if (last !== null && now() - last >= 0 && now() - last < CHUNK_RELOAD_WINDOW_MS) return false;
  if (!(await serverAnswers(deps.fetchImpl ?? ((input, init) => fetch(input, init))))) return false;
  // Typed while the server was being checked.
  if ((deps.unsentInput ?? hasUnsentInput)()) return false;
  if (!markReload(now())) return false;
  (deps.reload ?? (() => window.location.reload()))();
  return true;
}
