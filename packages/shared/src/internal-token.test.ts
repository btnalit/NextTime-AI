import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERNAL_TOKEN_FILE,
  INTERNAL_TOKEN_FILE_ENV,
  INTERNAL_TOKEN_MIN_LENGTH,
  InternalTokenError,
  internalAuthorizationHeader,
  normalizeInternalToken,
  resolveInternalTokenFile,
} from './internal-token.js';

describe('resolveInternalTokenFile', () => {
  it('defaults to the compose secret mount path', () => {
    expect(resolveInternalTokenFile({})).toBe(DEFAULT_INTERNAL_TOKEN_FILE);
    expect(resolveInternalTokenFile({ [INTERNAL_TOKEN_FILE_ENV]: '' })).toBe(
      DEFAULT_INTERNAL_TOKEN_FILE,
    );
  });

  it('honours the env override', () => {
    expect(resolveInternalTokenFile({ [INTERNAL_TOKEN_FILE_ENV]: '/custom/token' })).toBe(
      '/custom/token',
    );
  });
});

describe('normalizeInternalToken', () => {
  const token = randomBytes(32).toString('hex');

  it('trims the trailing newline a shell-written file carries', () => {
    expect(normalizeInternalToken(`${token}\n`, '/x')).toBe(token);
    expect(normalizeInternalToken(`  ${token}\r\n`, '/x')).toBe(token);
  });

  it('rejects an empty file, naming the path but not the contents', () => {
    expect(() => normalizeInternalToken('\n', '/run/secrets/internal_token')).toThrow(
      InternalTokenError,
    );
    expect(() => normalizeInternalToken('', '/run/secrets/internal_token')).toThrow(
      /\/run\/secrets\/internal_token/,
    );
  });

  it('rejects a multi-line or whitespace-containing value', () => {
    expect(() => normalizeInternalToken(`${token}\nsecond-line`, '/x')).toThrow(InternalTokenError);
    expect(() => normalizeInternalToken(`${token.slice(0, 20)} ${token.slice(20)}`, '/x')).toThrow(
      /one line/,
    );
  });

  it(`rejects a token shorter than ${INTERNAL_TOKEN_MIN_LENGTH} characters without echoing it`, () => {
    const short = 'changeme';
    let caught: unknown;
    try {
      normalizeInternalToken(short, '/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalTokenError);
    expect((caught as Error).message).not.toContain(short);
    expect((caught as Error).message).toContain(String(INTERNAL_TOKEN_MIN_LENGTH));
  });
});

describe('internalAuthorizationHeader', () => {
  it('formats a Bearer header', () => {
    expect(internalAuthorizationHeader('abc')).toBe('Bearer abc');
  });
});
