import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT, exportPKCS8, exportSPKI, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HANDLE_SIGNING_ALG,
  HandleKeyConfigError,
  generateEphemeralHandleKeyPair,
  loadHandleKeyPair,
} from './keys.js';

/**
 * governance/capability/keys.test: unit tests only (docs/development-tasks.md S1.9 "unit
 * (ephemeral keys)") — no Postgres, no fixed on-disk key material. `generateEphemeralHandleKeyPair`
 * is exercised directly; `loadHandleKeyPair`'s PEM-file path is exercised against a temp
 * directory this test creates and removes itself, never real deployment key files.
 */

describe('generateEphemeralHandleKeyPair', () => {
  it('produces an Ed25519 private/public CryptoKey pair usable to sign and verify', async () => {
    const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();

    expect(privateKey.type).toBe('private');
    expect(publicKey.type).toBe('public');

    const token = await new SignJWT({ hello: 'world' })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    const { payload } = await jwtVerify(token, publicKey, { algorithms: [HANDLE_SIGNING_ALG] });
    expect(payload.hello).toBe('world');
  });

  it('produces a fresh keypair on every call', async () => {
    const a = await generateEphemeralHandleKeyPair();
    const b = await generateEphemeralHandleKeyPair();

    const [pemA, pemB] = await Promise.all([exportSPKI(a.publicKey), exportSPKI(b.publicKey)]);
    expect(pemA).not.toBe(pemB);
  });
});

describe('loadHandleKeyPair', () => {
  it('throws HandleKeyConfigError when either env var is unset', async () => {
    await expect(loadHandleKeyPair({})).rejects.toThrow(HandleKeyConfigError);
    await expect(
      loadHandleKeyPair({ HANDLE_PRIVATE_KEY_FILE: '/tmp/does-not-matter.key' }),
    ).rejects.toThrow(HandleKeyConfigError);
    await expect(
      loadHandleKeyPair({ HANDLE_PUBLIC_KEY_FILE: '/tmp/does-not-matter.pub' }),
    ).rejects.toThrow(HandleKeyConfigError);
  });

  describe('with PEM files on disk', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'nexttime-handle-keys-test-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('loads a keypair that round-trips a signature made with the original in-memory key', async () => {
      const original = await generateEphemeralHandleKeyPair();
      const [privatePem, publicPem] = await Promise.all([
        exportPKCS8(original.privateKey),
        exportSPKI(original.publicKey),
      ]);

      const privateKeyFile = path.join(dir, 'handle.key');
      const publicKeyFile = path.join(dir, 'handle.pub');
      await writeFile(privateKeyFile, privatePem, 'utf8');
      await writeFile(publicKeyFile, publicPem, 'utf8');

      const loaded = await loadHandleKeyPair({
        HANDLE_PRIVATE_KEY_FILE: privateKeyFile,
        HANDLE_PUBLIC_KEY_FILE: publicKeyFile,
      });

      // Sign with the *original* in-memory private key, verify with the *loaded* public key (and
      // vice versa) — proves the PEM round trip preserved the same key material, not just that
      // loading didn't throw.
      const marker = randomBytes(8).toString('hex');
      const token = await new SignJWT({ marker })
        .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
        .sign(original.privateKey);
      const { payload } = await jwtVerify(token, loaded.publicKey, {
        algorithms: [HANDLE_SIGNING_ALG],
      });
      expect(payload.marker).toBe(marker);

      const tokenFromLoaded = await new SignJWT({ marker })
        .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
        .sign(loaded.privateKey);
      const verifiedWithOriginal = await jwtVerify(tokenFromLoaded, original.publicKey, {
        algorithms: [HANDLE_SIGNING_ALG],
      });
      expect(verifiedWithOriginal.payload.marker).toBe(marker);
    });
  });
});
