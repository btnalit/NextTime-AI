/**
 * lib/drafts (legacy 658): the chat message box's unsent text, kept in this tab's `sessionStorage`
 * so it outlives the box itself. A console session that expires under an open chat unmounts the
 * whole shell on the next write (`useSessionMachine` `sessionInvalid`) and lands on sign-in; the
 * text the person typed would go with it. Kept here, it comes back once they sign in again and
 * the same chat opens — and only for the same caller: a draft is keyed by the principal that
 * typed it and the chat it was typed in, so someone else signing in on this tab never sees it.
 *
 * Same storage rules as `lib/session.ts`: `sessionStorage` only (it goes when the tab closes),
 * best-effort (it throws in some private-browsing contexts, and a draft that cannot be kept is no
 * worse than before), and cleared on an explicit sign-out (`clearDrafts`) — a tab someone signed
 * out of keeps nothing they typed. A sign-in that is not a sign-out's — someone else signing in
 * after a session expired — keeps only the drafts of the principals it signed in as
 * (`keepDraftsOf`): what the last person typed is not only out of sight, it is gone from storage.
 */

const DRAFTS_STORAGE_KEY = 'nexttime.drafts';

/** The most drafts one tab keeps; the oldest goes first. A bound, not a feature: a person rarely
 *  leaves more than a few chats with unsent text, and the store must not grow without end. */
export const MAX_DRAFTS = 20;

/** The key a draft is filed under: who typed it, in which chat. */
export function draftScope(principalId: string, chatId: string): string {
  return `${principalId}/${chatId}`;
}

function readAll(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const drafts: Record<string, string> = {};
    for (const [scope, text] of Object.entries(parsed)) {
      if (typeof text === 'string') drafts[scope] = text;
    }
    return drafts;
  } catch {
    return {};
  }
}

function writeAll(drafts: Record<string, string>): void {
  try {
    if (Object.keys(drafts).length === 0) sessionStorage.removeItem(DRAFTS_STORAGE_KEY);
    else sessionStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Best-effort — see module doc comment.
  }
}

export function loadDraft(scope: string): string | null {
  return readAll()[scope] ?? null;
}

/** Files `text` under `scope`, newest last; blank text removes the draft instead. */
export function saveDraft(scope: string, text: string): void {
  const drafts = readAll();
  if (!(scope in drafts) && text.trim() === '') return;
  delete drafts[scope];
  if (text.trim() !== '') {
    drafts[scope] = text;
    const scopes = Object.keys(drafts);
    for (const old of scopes.slice(0, Math.max(0, scopes.length - MAX_DRAFTS))) {
      delete drafts[old];
    }
  }
  writeAll(drafts);
}

/** Drops every draft not typed by one of `principalIds` — a sign-in keeps only its own. */
export function keepDraftsOf(principalIds: readonly string[]): void {
  const keep = new Set(principalIds);
  const drafts = readAll();
  let changed = false;
  for (const scope of Object.keys(drafts)) {
    if (!keep.has(scope.slice(0, scope.indexOf('/')))) {
      delete drafts[scope];
      changed = true;
    }
  }
  if (changed) writeAll(drafts);
}

/** Every draft of this tab, gone — an explicit sign-out or "forget key". */
export function clearDrafts(): void {
  writeAll({});
}
