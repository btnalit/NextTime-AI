import { describe, expect, it } from 'vitest';
import {
  excerpt,
  formatDuration,
  formatRelative,
  humanizeKind,
  redactSensitive,
  shortId,
} from './format.js';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

describe('format', () => {
  it('shortId keeps 8 characters', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567');
    expect(shortId('abc')).toBe('abc');
  });

  it('formatRelative buckets by age and tolerates bad input', () => {
    expect(formatRelative('2026-09-03T11:59:50.000Z', NOW)).toBe('just now');
    expect(formatRelative('2026-09-03T11:55:00.000Z', NOW)).toBe('5m ago');
    expect(formatRelative('2026-09-03T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(formatRelative('2026-09-01T12:00:00.000Z', NOW)).toBe('2d ago');
    expect(formatRelative(null, NOW)).toBe('—');
    expect(formatRelative('not a date', NOW)).toBe('—');
  });

  it('formatDuration renders s / m s / h m', () => {
    expect(formatDuration('2026-09-03T11:59:48.000Z', null, NOW)).toBe('12s');
    expect(formatDuration('2026-09-03T11:56:56.000Z', '2026-09-03T12:00:00.000Z')).toBe('3m 04s');
    expect(formatDuration('2026-09-03T10:58:00.000Z', null, NOW)).toBe('1h 02m');
  });

  it('humanizeKind matches the kernel label convention', () => {
    expect(humanizeKind('docker.container_restart')).toBe('docker container restart');
  });

  it('excerpt truncates and redactSensitive masks credential-like keys deeply', () => {
    expect(excerpt('x'.repeat(200), 20)?.length).toBe(20);
    expect(
      redactSensitive({ a: 1, nested: { apiKey: 's', list: [{ password: 'p', ok: 2 }] } }),
    ).toEqual({
      a: 1,
      nested: { apiKey: '[redacted]', list: [{ password: '[redacted]', ok: 2 }] },
    });
  });
});
