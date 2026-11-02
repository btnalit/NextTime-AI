import { describe, expect, it } from 'vitest';
import { hrefs } from './lib/router.js';
import { isDefaultLanding } from './routes.js';

/** `isDefaultLanding` decides whether a platform administrator's sign-in may move them to 平台概览:
 *  only when the hash names no page of its own. */
describe('isDefaultLanding', () => {
  it('is true for an empty hash, a bare #, a stale #/login and an unknown route', () => {
    for (const hash of ['', '#', '#/', hrefs.login(), '#/nowhere', '#/nowhere?x=1']) {
      expect(isDefaultLanding(hash)).toBe(true);
    }
  });

  it('is false for the chats page, with or without its own query (UX P3-5 on #943)', () => {
    expect(isDefaultLanding(hrefs.chats())).toBe(false);
    expect(isDefaultLanding(hrefs.chatsOpenAdminAgent())).toBe(false);
    expect(isDefaultLanding(hrefs.platformAdminAgent())).toBe(false);
  });
});
