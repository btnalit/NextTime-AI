import { describe, expect, it } from 'vitest';
import {
  IdentityError,
  LOGIN_PATTERN,
  assertPasswordStrength,
  derivedLogin,
  normalizeLogin,
} from './users.js';

/**
 * application/identity/users.test: pure unit coverage (no DB) for the login-normalization,
 * derived-login and password-strength helpers S4.1 relies on everywhere else in this module
 * (insertUser, ensureUserForHumanPrincipal, checkPassword, ...). DB-backed behavior (insertUser,
 * checkPassword's throttle, membership listing, ...) is covered by the DB-gated integration
 * suites instead (interfaces/http/auth-routes.integration.test.ts).
 */

describe('normalizeLogin', () => {
  it('lower-cases a valid mixed-case login', () => {
    expect(normalizeLogin('Alice.B_1')).toBe('alice.b_1');
  });

  it.each([
    ['', 'empty string'],
    ['a', 'too short (1 char, pattern requires at least 3)'],
    ['-abc', 'starts with a non-alphanumeric character'],
    ['a b', 'contains a space'],
    ['a'.repeat(65), 'too long (65 chars, pattern caps at 64)'],
  ])('rejects %j (%s)', (login) => {
    expect(() => normalizeLogin(login)).toThrow(IdentityError);
  });
});

describe('derivedLogin', () => {
  it('slugifies a display name and appends the first 8 hex chars of the principal id', () => {
    expect(derivedLogin('  Alice  B ', '0123456789abcdef')).toBe('alice-b-01234567');
  });

  it('falls back to "user" when displayName is null', () => {
    expect(derivedLogin(null, '0123456789abcdef')).toBe('user-01234567');
  });

  it('caps the slug so a very long display name still yields a login within LOGIN_PATTERN bounds', () => {
    const longDisplayName = 'Test User '.repeat(20); // 200 chars
    const login = derivedLogin(longDisplayName, '0123456789abcdef');
    expect(login.length).toBeLessThanOrEqual(64);
    expect(LOGIN_PATTERN.test(login)).toBe(true);
  });

  it('trims the dashes a display name starts or ends with, in linear time', () => {
    expect(derivedLogin('--Alice--', '0123456789abcdef')).toBe('alice-01234567');
    const started = performance.now();
    expect(derivedLogin(`x${'-'.repeat(200_000)}y`, '0123456789abcdef')).toBe('x-y-01234567');
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('assertPasswordStrength', () => {
  it('rejects a 7-character password', () => {
    expect(() => assertPasswordStrength('1234567')).toThrow(IdentityError);
  });

  it('accepts an 8-character password', () => {
    expect(() => assertPasswordStrength('12345678')).not.toThrow();
  });

  it('R-13: applies the platform minimum when the caller passes one', () => {
    expect(() => assertPasswordStrength('a'.repeat(11), 12)).toThrow(IdentityError);
    expect(() => assertPasswordStrength('a'.repeat(12), 12)).not.toThrow();
  });

  it('R-13: a configured minimum below the floor never lowers it; 256 is the ceiling', () => {
    expect(() => assertPasswordStrength('1234567', 4)).toThrow(IdentityError);
    expect(() => assertPasswordStrength('a'.repeat(257))).toThrow(IdentityError);
    expect(() => assertPasswordStrength('a'.repeat(256))).not.toThrow();
  });
});
