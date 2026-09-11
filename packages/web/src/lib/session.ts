/**
 * lib/session: sessionStorage-backed stores for the two auth channels (docs/development-tasks.md
 * S1.8 deliverable 1: "stored in sessionStorage only — never localStorage, never cookies").
 * `sessionStorage` clears itself when the tab closes, which is the whole point — a "forget key"/
 * "sign out" action is the only other way either store goes away.
 *
 * Wrapped in try/catch: `sessionStorage` throws in some embedded/private-browsing contexts
 * (design doc has no S1 requirement to support those, but failing open to "not logged in" rather
 * than throwing out of `main.tsx` is strictly safer).
 */

const API_KEY_STORAGE_KEY = 'nexttime.apiKey';

export function loadApiKey(): string | null {
  try {
    return sessionStorage.getItem(API_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveApiKey(apiKey: string): void {
  try {
    sessionStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  } catch {
    // Best-effort — see module doc comment.
  }
}

export function clearApiKey(): void {
  try {
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch {
    // Best-effort — see module doc comment.
  }
}

/**
 * S4.1: the last workspace a cookie-authenticated session selected, in this tab only. The console
 * session cookie itself carries no workspace (a user can hold several memberships); App.tsx uses
 * this to re-select the same workspace across a reload when it is still a valid membership, and
 * falls back to auto-selecting when there is exactly one (see App.tsx's own boot-flow doc
 * comment). Never the source of truth for "which workspace is this session in" — that is always
 * `HttpClient`'s own `auth.workspaceId` / the `nexttime_workspace` selector cookie
 * (`lib/auth-api.ts` `setWorkspaceCookie`) — this is only a UX convenience for reload/re-login.
 */
const SELECTED_WORKSPACE_STORAGE_KEY = 'nexttime.selectedWorkspaceId';

export function loadSelectedWorkspaceId(): string | null {
  try {
    return sessionStorage.getItem(SELECTED_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveSelectedWorkspaceId(workspaceId: string): void {
  try {
    sessionStorage.setItem(SELECTED_WORKSPACE_STORAGE_KEY, workspaceId);
  } catch {
    // Best-effort — see module doc comment.
  }
}
