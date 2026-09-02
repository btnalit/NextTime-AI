import { readFile } from 'node:fs/promises';
import { HANDLE_SIGNING_ALG, importHandlePublicKey } from '@nexttime/shared';
import { generateKeyPair, importPKCS8 } from 'jose';
import type { CryptoKey } from 'jose';

/**
 * governance/capability/keys: the Ed25519 signing keypair used to issue and verify Capability
 * Handles (design doc §11 "EdDSA"; §5.1.4; docs/development-tasks.md S1.9). Two sources:
 *
 *   - `loadHandleKeyPair()` reads PEM files named by `HANDLE_PRIVATE_KEY_FILE` /
 *     `HANDLE_PUBLIC_KEY_FILE` (secrets/kernel.env, written by scripts/host-env-init.sh; the
 *     actual keypair is generated on the target host by scripts/gen-handle-keys.sh, S1.9). This
 *     is the production path — the kernel process never generates its own signing key at runtime.
 *   - `generateEphemeralHandleKeyPair()` generates a keypair in memory, for tests only
 *     (docs/development-tasks.md S1.9 "unit (ephemeral keys)"). Never touches the filesystem.
 *
 * `HANDLE_PUBLIC_KEY_FILE` is this module's own concern for loading the *kernel's* keypair (it
 * needs both halves to sign and to locally verify its own tokens, e.g. before recording a
 * `capability_handles` row). It is a separate concern from `config/handle.pub` (§10.2, S1.9 task
 * brief: "内核公钥导出到 ${NEXTTIME_DATA}/config/handle.pub 供 llm-proxy 本地验签") — the copy
 * `llm-proxy` reads is written by scripts/gen-handle-keys.sh directly from the same key material,
 * not re-derived by this module at runtime.
 *
 * `HANDLE_SIGNING_ALG` and the public-key import are re-exported/delegated from
 * `@nexttime/shared`'s `handle-token` module (S1.7 "共享 Handle-token 原语") rather than defined
 * here, so the kernel and `llm-proxy` can never drift on which algorithm or PEM-import path a
 * Handle's public half uses. Only the private-key half (`importPKCS8`, signing) stays kernel-only
 * — `llm-proxy` and the shared module never see a private key.
 */
export { HANDLE_SIGNING_ALG };

/** The Ed25519 curve `generateKeyPair`/PEM-import must produce — the only curve EdDSA Handles use. */
const HANDLE_KEY_CURVE = 'Ed25519' as const;

export interface HandleKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

/** Thrown when the Handle signing keypair cannot be loaded from configuration. */
export class HandleKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleKeyConfigError';
  }
}

/**
 * Loads the kernel's Handle signing keypair from the PEM files named by
 * `HANDLE_PRIVATE_KEY_FILE` / `HANDLE_PUBLIC_KEY_FILE` in `env` (defaults to `process.env`).
 * Fails fast with `HandleKeyConfigError` if either variable is unset, matching the fail-fast
 * style of `DatabaseConfigError` (packages/kernel/src/adapters/db/pool.ts) rather than letting a
 * missing key surface later as an opaque file-read or `jose` import error.
 */
export async function loadHandleKeyPair(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<HandleKeyPair> {
  const privateKeyFile = env.HANDLE_PRIVATE_KEY_FILE;
  const publicKeyFile = env.HANDLE_PUBLIC_KEY_FILE;

  if (!privateKeyFile || !publicKeyFile) {
    throw new HandleKeyConfigError(
      'HANDLE_PRIVATE_KEY_FILE and HANDLE_PUBLIC_KEY_FILE must both be set to load the Handle ' +
        'signing keypair (see scripts/gen-handle-keys.sh, docs/development-tasks.md S1.9)',
    );
  }

  const [privatePem, publicPem] = await Promise.all([
    readFile(privateKeyFile, 'utf8'),
    readFile(publicKeyFile, 'utf8'),
  ]);

  const [privateKey, publicKey] = await Promise.all([
    importPKCS8(privatePem, HANDLE_SIGNING_ALG),
    importHandlePublicKey(publicPem),
  ]);

  return { privateKey, publicKey };
}

/**
 * Generates an Ed25519 keypair in memory for tests — never reads or writes the filesystem, and
 * is never used by the production kernel process (that always loads a persisted keypair via
 * `loadHandleKeyPair`, so that a Handle issued before a restart still verifies afterward).
 */
export async function generateEphemeralHandleKeyPair(): Promise<HandleKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
    crv: HANDLE_KEY_CURVE,
    extractable: true,
  });
  return { privateKey, publicKey };
}
