/**
 * lib/session: the API key store (docs/development-tasks.md S1.8 deliverable 1: "stored in
 * sessionStorage only — never localStorage, never cookies"). `sessionStorage` clears itself when
 * the tab closes, which is the whole point — a "forget key" action (`clearApiKey`) is the only
 * other way it goes away.
 *
 * Wrapped in try/catch: `sessionStorage` throws in some embedded/private-browsing contexts
 * (design doc has no S1 requirement to support those, but failing open to "not logged in" rather
 * than throwing out of `main.tsx` is strictly safer).
 */

const STORAGE_KEY = 'nexttime.apiKey';

export function loadApiKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveApiKey(apiKey: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, apiKey);
  } catch {
    // Best-effort — see module doc comment.
  }
}

export function clearApiKey(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort — see module doc comment.
  }
}
