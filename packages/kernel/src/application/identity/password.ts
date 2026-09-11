/**
 * Password hashing for platform users (S4.1, design doc §7.11 "登录"): `node:crypto` scrypt —
 * no new dependency. Encoded as `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>` so the cost
 * parameters travel with the hash and can be raised later without a flag day (a login that
 * verifies against an older-cost hash is the natural place to re-hash).
 *
 * These hashes are the platform's *own* identity store — not an external credential in the I9
 * sense (I9 is about other systems' credentials: provider keys, gate credentials).
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384; // 2^14 — ~50 ms on a small VM; OWASP's floor for interactive logins
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

/** Minimum accepted password length (S4.1). Enforced at the application boundary, not here. */
export const MIN_PASSWORD_LENGTH = 8;

function scryptAsync(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_LENGTH,
      { N: n, r, p, maxmem: 128 * n * r * 2 },
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** Constant-time verification. A malformed or foreign-format hash verifies as `false`, never
 *  throws — a corrupted row must read as "wrong password", not as a 500 on the login route. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || r < 1 || p < 1 || n > 1 << 20) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    expected = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  const derived = await scryptAsync(password, salt, n, r, p);
  return timingSafeEqual(derived, expected);
}
