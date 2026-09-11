// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { setWorkspaceCookie } from './auth-api.js';

/**
 * auth-api.cookie.test.ts: `setWorkspaceCookie` needs `document`/`window`, so it gets its own
 * jsdom-pragma'd file rather than pulling the rest of auth-api.test.ts (plain `fetch` fakes, no
 * DOM needed) into jsdom too.
 */

function clearCookies(): void {
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

afterEach(clearCookies);

describe('setWorkspaceCookie', () => {
  it('sets nexttime_workspace=<id>; Path=/; SameSite=Strict', () => {
    setWorkspaceCookie('ws-1');
    expect(document.cookie).toContain('nexttime_workspace=ws-1');
  });

  it('clears the cookie when given null', () => {
    setWorkspaceCookie('ws-1');
    expect(document.cookie).toContain('nexttime_workspace=ws-1');
    setWorkspaceCookie(null);
    expect(document.cookie).not.toContain('nexttime_workspace=ws-1');
  });
});
