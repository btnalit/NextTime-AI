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

  it('does not mask a base64 or other transform of the value (design doc §4.6)', () => {
    const mask = injectedCredentialMask(BEARER);
    const transformed = Buffer.from(TOKEN).toString('base64');
    expect(mask.apply(transformed)).toEqual({ value: transformed, masked: 0 });
  });

  it('logs how many, never what', () => {
    expect(credentialEchoLine('http transport: GET /me', 1)).toBe(
      "http transport: GET /me: the target's answer held this gate's own credential once; masked before the answer left the gate (legacy 961)",
    );
    expect(credentialEchoLine('mcp transport: tools/call', 3)).toContain('3 times');
  });
});
