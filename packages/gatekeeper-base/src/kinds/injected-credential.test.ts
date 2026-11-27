import { describe, expect, it } from 'vitest';
import {
  MIN_MASKED_LENGTH,
  credentialEchoLine,
  injectedCredentialMask,
} from './injected-credential.js';

// Legacy 961. FAKE values only.
const TOKEN = 'FAKE-gate-token-0123/abc+def=';
const BEARER = { authorization: `Bearer ${TOKEN}` };

describe('injectedCredentialMask (legacy 961)', () => {
  it('masks the header value whole, and the token alone where it is echoed without its scheme', () => {
    const mask = injectedCredentialMask(BEARER);
    const result = mask.apply({
      headers: { Authorization: `Bearer ${TOKEN}` },
      whoami: { token: TOKEN },
      note: `token was ${TOKEN}; again ${TOKEN}`,
    });
    expect(result.value).toEqual({
      headers: { Authorization: '[redacted]' },
      whoami: { token: '[redacted]' },
      note: 'token was [redacted]; again [redacted]',
    });
    expect(result.masked).toBe(4);
  });

  it('masks it percent-encoded, in either case of hex and mixed with plain characters', () => {
    const mask = injectedCredentialMask(BEARER);
    const encoded = encodeURIComponent(TOKEN);
    expect(encoded).not.toBe(TOKEN);
    const lower = encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    const mixed = 'FAKE-gate-token-0123%2Fabc+def%3d';
    const bearerEncoded = `Bearer%20${encoded}`;
    const bearerPlus = `Bearer+${encoded}`;
    const result = mask.apply([encoded, lower, mixed, bearerEncoded, bearerPlus]);
    expect(result.value).toEqual([
      '[redacted]',
      '[redacted]',
      '[redacted]',
      '[redacted]',
      '[redacted]',
    ]);
    expect(result.masked).toBe(5);
  });

  it('masks it in a key too, and keeps a parsed `__proto__` key an own property', () => {
    const mask = injectedCredentialMask(BEARER);
    const parsed = JSON.parse(`{"${TOKEN}": 1, "__proto__": {"polluted": "${TOKEN}"}}`);
    const { value, masked } = mask.apply(parsed as Record<string, unknown>);
    expect(Object.keys(value)).toEqual(['[redacted]', '__proto__']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({
      polluted: '[redacted]',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(masked).toBe(2);
  });

  it('masks each value a header credential set, and the part after a Basic or token scheme', () => {
    const basic = Buffer.from('FAKE-user:FAKE-password').toString('base64');
    const mask = injectedCredentialMask({
      'X-Tenant-Signature': 'FAKE-signature-value',
      authorization: `Basic ${basic}`,
      'x-other': 'token FAKE-github-ish',
    });
    const result = mask.apply(
      `sig=FAKE-signature-value auth=Basic ${basic} again=${basic} gh=FAKE-github-ish`,
    );
    expect(result.value).toBe('sig=[redacted] auth=[redacted] again=[redacted] gh=[redacted]');
    expect(result.masked).toBe(4);
  });

  it('masks the longer of two values whole where one begins the other', () => {
    const mask = injectedCredentialMask({ 'x-key': 'FAKE-key-one', 'x-key-2': 'FAKE-key-one-two' });
    expect(mask.apply('a FAKE-key-one-two b FAKE-key-one c')).toEqual({
      value: 'a [redacted] b [redacted] c',
      masked: 2,
    });
  });

  it('masks the value as fetch sends it, without the blanks around it', () => {
    const mask = injectedCredentialMask({ 'x-api-key': `  ${TOKEN}\t` });
    expect(mask.apply(`key: ${TOKEN}.`).value).toBe('key: [redacted].');
  });

  it(`leaves a value shorter than ${MIN_MASKED_LENGTH} characters, and every other value, as it is`, () => {
    const mask = injectedCredentialMask({ 'x-api-key': 'short' });
    const answer = { items: ['short', 'a short answer'], count: 3, ok: true, none: null };
    const result = mask.apply(answer);
    expect(result.value).toBe(answer);
    expect(result.masked).toBe(0);
  });

  it('copies what it walks and changes nothing in an answer that does not hold the credential', () => {
    const mask = injectedCredentialMask(BEARER);
    const answer = { items: [{ sku: 'X1', qty: 3 }], next: null, total: 1.5 };
    const result = mask.apply(answer);
    expect(result.value).toEqual(answer);
    expect(result.value).not.toBe(answer);
    expect(result.masked).toBe(0);
    expect(mask.apply(undefined)).toEqual({ value: undefined, masked: 0 });
  });

  it('reads a value with regular-expression characters literally', () => {
    const mask = injectedCredentialMask({ 'x-api-key': 'FAKE.*(a|b)+[x]$^{2}\\' });
    expect(mask.apply('FAKE.*(a|b)+[x]$^{2}\\').value).toBe('[redacted]');
    expect(mask.apply('FAKEaaaa(a|b)+[x]$^{2}\\').value).toBe('FAKEaaaa(a|b)+[x]$^{2}\\');
  });

  it('reads a value with a lone surrogate', () => {
    const mask = injectedCredentialMask({ 'x-api-key': 'FAKE-key-\ud800-end' });
    expect(mask.apply('a FAKE-key-\ud800-end b').value).toBe('a [redacted] b');
  });

  it('masks the part after any auth scheme word, not only Bearer, Basic and token', () => {
    const [one, two, three] = [
      'FAKE-echoed-one-0123',
      'FAKE-echoed-two-0123',
      'FAKE-echoed-three-01',
    ];
    const mask = injectedCredentialMask({
      authorization: `ApiKey ${one}`,
      'x-bot': `Bot ${two}`,
      'x-okta': `SSWS ${three}`,
    });
    const result = mask.apply({ one, two, three });
    expect(result.value).toEqual({ one: '[redacted]', two: '[redacted]', three: '[redacted]' });
    expect(result.masked).toBe(3);
  });

  it('masks the value of each name=value part of a header value, unquoted, and leaves a short one', () => {
    const [session, rails, nonce] = [
      'FAKE-session-0123',
      'FAKE-rails-0123-ab',
      'FAKE-nonce-0123-ab',
    ];
    const mask = injectedCredentialMask({
      cookie: `session=${session}; theme=dark`,
      authorization: `Token token="${rails}", nonce="${nonce}"`,
    });
    const result = mask.apply({
      cookies: { session, theme: 'dark' },
      echoed: rails,
      parsed: { rails, nonce },
    });
    expect(result.value).toEqual({
      cookies: { session: '[redacted]', theme: 'dark' },
      echoed: '[redacted]',
      parsed: { rails: '[redacted]', nonce: '[redacted]' },
    });
    expect(result.masked).toBe(4);
  });

  it('masks a number equal to an all-digit value, one that lost precision too, and no other', () => {
    const mask = injectedCredentialMask({
      'x-api-key': '1234567890123',
      'x-account-key': '12345678901234567891',
    });
    const parsed = JSON.parse(
      '{"key": 1234567890123, "account": 12345678901234567891, "near": 1234567890124, "n": 3}',
    );
    const result = mask.apply(parsed as Record<string, unknown>);
    expect(result.value).toEqual({
      key: '[redacted]',
      account: '[redacted]',
      near: 1234567890124,
      n: 3,
    });
    expect(result.masked).toBe(2);
  });

  it('masks it with the escapes a single parse leaves in place: \\/, \\uXXXX and character references', () => {
    const mask = injectedCredentialMask(BEARER);
    // TOKEN is FAKE-gate-token-0123/abc+def=
    const written = [
      'FAKE-gate-token-0123\\/abc+def=', // PHP's json_encode, read as text or inside a JSON string
      'FAKE-gate-token-0123\\u002fabc\\u002Bdef\\u003d', // a second layer of JSON, either case
      'FAKE-gate-token-0123&#x2F;abc&#43;def&#x3D;', // HTML numeric references
      'FAKE&#45;gate&#0045;token&#x002d;0123&#47;abc+def=',
      'FAKE-gate-token-0123%2Fabc\\u002bdef&#61;', // mixed
    ];
    const result = mask.apply(written);
    expect(result.value).toEqual(written.map(() => '[redacted]'));
    expect(result.masked).toBe(written.length);
    const named = injectedCredentialMask({ 'x-api-key': 'FAKE-a&b<c>"d\'e' });
    expect(named.apply('v=FAKE-a&amp;b&lt;c&gt;&quot;d&apos;e;').value).toBe('v=[redacted];');
  });

  it('leaves a letter or digit written as an escape, and an escape that names another character', () => {
    const mask = injectedCredentialMask(BEARER);
    const others = ['\\u0046AKE-gate-token-0123/abc+def=', 'FAKE-gate-token-0123&#46;abc+def='];
    expect(mask.apply(others)).toEqual({ value: others, masked: 0 });
  });

  it('does not mask a base64 or other transform of the value, or a piece cut from it (design doc §4.6)', () => {
    const mask = injectedCredentialMask(BEARER);
    const transformed = Buffer.from(TOKEN).toString('base64');
    expect(mask.apply(transformed)).toEqual({ value: transformed, masked: 0 });
    const piece = `${TOKEN.slice(0, 16)}…`;
    expect(mask.apply(piece)).toEqual({ value: piece, masked: 0 });
  });

  it('logs how many, never what', () => {
    expect(credentialEchoLine('http transport: GET /me', 1)).toBe(
      "http transport: GET /me: the target's answer held this gate's own credential once; masked before the answer left the gate (legacy 961)",
    );
    expect(credentialEchoLine('mcp transport: tools/call', 3)).toContain('3 times');
  });
});
