import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('application/identity/password', () => {
  it('hashes and verifies; two hashes of the same password differ (random salt)', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$16384$8$1$')).toBe(true);
    await expect(verifyPassword('correct horse battery', a)).resolves.toBe(true);
    await expect(verifyPassword('correct horse battery', b)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const h = await hashPassword('right');
    await expect(verifyPassword('wrong', h)).resolves.toBe(false);
    await expect(verifyPassword('', h)).resolves.toBe(false);
  });

  it('treats malformed or foreign hashes as a failed verification, never a throw', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$whatever')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$abc$8$1$AAAA$BBBB')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$16384$8$1$$')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$16384$8$1$c2FsdA==$dG9vc2hvcnQ=')).resolves.toBe(
      false,
    );
  });

  it('verifies a hash produced with different (older) cost parameters', async () => {
    const h = await hashPassword('pw');
    const parts = h.split('$');
    // Re-derive with N=1024 to simulate an older cost, using the same salt.
    const { scryptSync } = await import('node:crypto');
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const derived = scryptSync('pw', salt, 32, { N: 1024, r: 8, p: 1 });
    const older = [
      'scrypt',
      '1024',
      '8',
      '1',
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
    await expect(verifyPassword('pw', older)).resolves.toBe(true);
  });
});
