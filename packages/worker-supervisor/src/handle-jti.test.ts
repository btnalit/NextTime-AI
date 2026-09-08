import { describe, expect, it } from 'vitest';
import { decodeHandleJtiUnsafe } from './handle-jti.js';

function fakeJwt(payload: unknown): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'EdDSA' })}.${encode(payload)}.fake-signature`;
}

describe('decodeHandleJtiUnsafe', () => {
  it('decodes the jti claim from a well-formed 3-segment JWT', () => {
    const token = fakeJwt({ jti: 'abc-123', ws: 'w1' });
    expect(decodeHandleJtiUnsafe(token)).toBe('abc-123');
  });

  it('returns undefined for a plain non-JWT string', () => {
    expect(decodeHandleJtiUnsafe('dummy-handle')).toBeUndefined();
    expect(decodeHandleJtiUnsafe('')).toBeUndefined();
  });

  it('returns undefined for a token with the wrong number of segments', () => {
    expect(decodeHandleJtiUnsafe('a.b')).toBeUndefined();
    expect(decodeHandleJtiUnsafe('a.b.c.d')).toBeUndefined();
  });

  it('returns undefined when the payload segment is not valid base64url JSON', () => {
    expect(decodeHandleJtiUnsafe('a.not-valid-base64-json!!!.c')).toBeUndefined();
  });

  it('returns undefined when the payload has no jti claim, or jti is not a non-empty string', () => {
    expect(decodeHandleJtiUnsafe(fakeJwt({ ws: 'w1' }))).toBeUndefined();
    expect(decodeHandleJtiUnsafe(fakeJwt({ jti: '' }))).toBeUndefined();
    expect(decodeHandleJtiUnsafe(fakeJwt({ jti: 123 }))).toBeUndefined();
    expect(decodeHandleJtiUnsafe(fakeJwt(null))).toBeUndefined();
    expect(decodeHandleJtiUnsafe(fakeJwt('not-an-object'))).toBeUndefined();
  });

  it('never throws on malformed input', () => {
    expect(() => decodeHandleJtiUnsafe('...')).not.toThrow();
    expect(() => decodeHandleJtiUnsafe('a.b.c')).not.toThrow();
  });
});
