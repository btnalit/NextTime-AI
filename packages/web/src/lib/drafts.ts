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

/** One draft's ceiling, in characters. Past it the draft is not kept (and an older copy goes):
 *  a whole tab's store shares the origin's few megabytes with the API key. */
export const MAX_DRAFT_CHARS = 200_000;

/** Legacy 667: all of a tab's drafts together, in characters; past it the oldest go first. Twenty
 *  drafts at the one-draft ceiling would be 4M characters — about 8 MB as the browser stores
 *  them, past what `sessionStorage` allows, so a write would fail and keep nothing new. */
export const MAX_DRAFTS_TOTAL_CHARS = 1_000_000;

/** The key a draft is filed under: who typed it, and where — a chat id, or an editor's own
 *  target (legacy 662: `skill:new`, `procedure:version:<id>@<n>`, `goal:<id>`, …). */
export function draftScope(principalId: string, target: string): string {
  return `${principalId}/${target}`;
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
  // Legacy 667: when the store will not take it (the origin's quota, shared with the session
  // key), the oldest drafts go until it does — never the old store left as it was, which would
  // bring back a draft just sent or discarded.
  const kept = { ...drafts };
  for (;;) {
    try {
      if (Object.keys(kept).length === 0) sessionStorage.removeItem(DRAFTS_STORAGE_KEY);
      else sessionStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(kept));
      return;
    } catch {
      const oldest = Object.keys(kept)[0];
      if (oldest === undefined) return; // Best-effort — see module doc comment.
      delete kept[oldest];
    }
  }
}

function totalChars(drafts: Record<string, string>): number {
  let total = 0;
  for (const text of Object.values(drafts)) total += text.length;
  return total;
}

export function loadDraft(scope: string): string | null {
  return readAll()[scope] ?? null;
}

/** Files `text` under `scope`, newest last; blank text removes the draft instead. */
export function saveDraft(scope: string, text: string): void {
  const drafts = readAll();
  if (!(scope in drafts) && text.trim() === '') return;
  delete drafts[scope];
  if (text.trim() !== '' && text.length <= MAX_DRAFT_CHARS) {
    drafts[scope] = text;
    const scopes = Object.keys(drafts);
    for (const old of scopes.slice(0, Math.max(0, scopes.length - MAX_DRAFTS))) {
      delete drafts[old];
    }
    // The newest is under the one-draft ceiling, so it always fits once older ones go.
    for (const old of Object.keys(drafts)) {
      if (old === scope || totalChars(drafts) <= MAX_DRAFTS_TOTAL_CHARS) break;
      delete drafts[old];
    }
  }
  writeAll(drafts);
}

/** Legacy 662: a structured draft (an editor's whole form), kept as JSON under `scope`. */
export function saveDraftValue(scope: string, value: unknown): void {
  let text: string;
  try {
    text = JSON.stringify({ v: 1, value });
  } catch {
    return;
  }
  saveDraft(scope, text);
}

/** The value `saveDraftValue` kept under `scope`, or `null` — also when what is there is not
 *  something this module wrote (an older console's shape, a chat's plain text). */
export function loadDraftValue(scope: string): unknown {
  const text = loadDraft(scope);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'v' in parsed &&
      parsed.v === 1 &&
      'value' in parsed
    )
      return parsed.value ?? null;
  } catch {
    // Not one of ours.
  }
  return null;
}

/** The draft under `scope`, gone — it was sent, saved or discarded. */
export function forgetDraft(scope: string): void {
  saveDraft(scope, '');
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
