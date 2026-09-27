import { describe, expect, it } from 'vitest';
import {
  CORRELATION_ID_ENV,
  CORRELATION_ID_HEADER,
  correlationHeaders,
  isValidCorrelationId,
  mintCorrelationId,
  resolveCorrelationId,
} from './index.js';

describe('correlation id', () => {
  it('names one header and one env var', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
    expect(CORRELATION_ID_ENV).toBe('NEXTTIME_CORRELATION_ID');
  });

  it('accepts short url-safe ids, including a UUID (a Turn id)', () => {
    expect(isValidCorrelationId('7f0c7c1e-8a44-4b6b-9f59-1b7bbcf0a3d2')).toBe(true);
    expect(isValidCorrelationId('turn_ABC-123')).toBe(true);
    expect(isValidCorrelationId('a'.repeat(64))).toBe(true);
  });

  it('rejects anything that is not a short url-safe token', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'short',
      'a'.repeat(65),
      'has space in it',
      'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln', // a JWT (dots) — never a correlation id
      'quote"injection',
      'line\nbreak-injection',
      '../../../etc/passwd',
    ]) {
      expect(isValidCorrelationId(bad)).toBe(false);
    }
  });

  it('mints valid, distinct ids', () => {
    const a = mintCorrelationId();
    const b = mintCorrelationId();
    expect(isValidCorrelationId(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('adopts a valid inbound header and replaces an invalid or missing one', () => {
    expect(resolveCorrelationId('turn-0000-1111')).toBe('turn-0000-1111');
    expect(resolveCorrelationId(['first-valid-id', 'second-valid-id'])).toBe('first-valid-id');
    const minted = resolveCorrelationId('bad id with spaces');
    expect(minted).not.toBe('bad id with spaces');
    expect(isValidCorrelationId(minted)).toBe(true);
    expect(isValidCorrelationId(resolveCorrelationId(undefined))).toBe(true);
  });

  it('builds outbound headers only for a valid id', () => {
    expect(correlationHeaders('turn-0000-1111')).toEqual({ 'x-correlation-id': 'turn-0000-1111' });
    expect(correlationHeaders(undefined)).toEqual({});
    expect(correlationHeaders('no good')).toEqual({});
  });
});
