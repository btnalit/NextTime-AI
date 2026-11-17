import { describe, expect, it } from 'vitest';
import { describeRedirect, isRedirectStatus, redirectTargetForDisplay } from './redirect.js';

describe('isRedirectStatus', () => {
  it('is every 3xx but 304', () => {
    for (const status of [300, 301, 302, 303, 307, 308, 399]) {
      expect(isRedirectStatus(status)).toBe(true);
    }
    for (const status of [200, 204, 299, 304, 400, 500]) {
      expect(isRedirectStatus(status)).toBe(false);
    }
  });
});

describe('redirectTargetForDisplay', () => {
  const REQUEST = 'https://api.example.com/v1/models';

  it('shows the path of a same-origin target and the origin and path of another', () => {
    expect(redirectTargetForDisplay('/v2/models', REQUEST)).toBe('"/v2/models"');
    expect(redirectTargetForDisplay('https://api.example.com/v2/models', REQUEST)).toBe(
      '"/v2/models"',
    );
    expect(redirectTargetForDisplay('https://login.example.net/authorize', REQUEST)).toBe(
      '"https://login.example.net/authorize"',
    );
    expect(redirectTargetForDisplay('http://api.example.com/v1/models', REQUEST)).toBe(
      '"http://api.example.com/v1/models"',
    );
  });

  it('never shows the query, fragment or userinfo', () => {
    const shown = redirectTargetForDisplay(
      'https://user:pass@login.example.net/cb?token=abc#frag',
      REQUEST,
    );
    expect(shown).toBe('"https://login.example.net/cb"');
  });

  it('says so when there is no Location header or it does not parse, and bounds a long one', () => {
    expect(redirectTargetForDisplay(null, REQUEST)).toBe('nowhere (no Location header)');
    expect(redirectTargetForDisplay('http://[', REQUEST)).toBe('an unparseable Location header');
    const long = redirectTargetForDisplay(`/${'a'.repeat(400)}`, REQUEST);
    expect(long).toBe(JSON.stringify(`/${'a'.repeat(299)}…`));
  });

  it("runs a caller's scrub before the bound, so a secret across it is hidden whole (#1344 review by #501)", () => {
    const secret = 'SECRET-0123456789-abcdef';
    const location = `/${'b'.repeat(289)}/${secret}/x`;
    const hide = (shown: string): string => shown.split(secret).join('***');
    expect(redirectTargetForDisplay(location, REQUEST, hide)).toBe(
      JSON.stringify(`/${'b'.repeat(289)}/***/x`),
    );
    // Without it the bound cuts the secret first: its leading part is what shows.
    expect(redirectTargetForDisplay(location, REQUEST)).toBe(
      JSON.stringify(`/${'b'.repeat(289)}/SECRET-01…`),
    );
    // The scrub sees the origin too when the target is another origin, never the query.
    const seen: string[] = [];
    redirectTargetForDisplay('https://other.example.net/p?q=1', REQUEST, (shown) => {
      seen.push(shown);
      return shown;
    });
    expect(seen).toEqual(['https://other.example.net/p']);
  });
});

describe('describeRedirect', () => {
  it('names what answered, the status, where it pointed, who refused and what to fix', () => {
    const response = { status: 307, headers: new Headers({ location: '/mcp/' }) };
    expect(
      describeRedirect('mcp transport: tools/list', response, 'http://mcp.test/mcp', {
        follower: 'The gate does not follow redirects',
        fix: 'set the target URL to the final address',
      }),
    ).toBe(
      'mcp transport: tools/list responded 307, a redirect to "/mcp/". The gate does not follow redirects: set the target URL to the final address.',
    );
  });

  it("passes the caller's scrub on to the target", () => {
    const response = { status: 301, headers: new Headers({ location: '/k/abc/models' }) };
    const advice = { follower: 'f', fix: 'x' };
    expect(
      describeRedirect('GET /v1/models', response, 'http://api.test/v1/models', advice, (shown) =>
        shown.replace('abc', '***'),
      ),
    ).toBe('GET /v1/models responded 301, a redirect to "/k/***/models". f: x.');
  });
});
