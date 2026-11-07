import { afterEach } from 'vitest';

// Legacy 662: chat and editor drafts live in sessionStorage (`lib/drafts.ts`) and editors restore
// them on mount, so a test must not inherit the last one's — every jsdom test starts with an
// empty tab. (`node`-environment suites have no `sessionStorage`.)
afterEach(() => {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  } catch {
    // No storage in this environment.
  }
});
