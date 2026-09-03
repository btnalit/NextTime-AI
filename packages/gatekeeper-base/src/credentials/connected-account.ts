import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CredentialResolutionError } from '../errors.js';
import type { CredentialResolver, ResolvedCredential } from './types.js';

/**
 * ConnectedAccount local store (design doc §5.1.4 ConnectedAccount, §7.5, §11 "credentials only
 * live in the gate"): one credential per `on_behalf_of` Principal, encrypted at rest with
 * AES-256-GCM. The key never leaves the gate process — it is read from `GATE_STORE_KEY_FILE`
 * (a file the operator provisions out-of-band, e.g. a docker secret), never from an env var
 * value directly, so it does not appear in `docker inspect`/process env dumps.
 *
 * Key derivation: the key file's raw bytes are used directly if exactly 32 bytes (a pre-generated
 * AES-256 key); otherwise the file's bytes are SHA-256-hashed to derive a 32-byte key — forgiving
 * of an operator provisioning a passphrase file instead of raw key bytes, at the cost of that
 * passphrase's own entropy being the real security bound in that case (documented, not silently
 * assumed strong).
 *
 * File format: `{records: {[onBehalfOf]: {iv, authTag, ciphertext} (all base64)}}`, one AES-GCM
 * envelope per record (not one envelope for the whole file) so writing one Principal's credential
 * never re-encrypts every other Principal's. Same atomic write-to-temp-then-rename durability
 * profile as `idempotency-store.ts` — see that file's own doc comment for the multi-process
 * caveat, which applies here too.
 */

interface EncryptedRecord {
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

interface StoreFileShape {
  readonly records: Record<string, EncryptedRecord>;
}

const ALGORITHM = 'aes-256-gcm';

async function loadKey(keyFilePath: string): Promise<Buffer> {
  const raw = await readFile(keyFilePath);
  if (raw.length === 32) return raw;
  return createHash('sha256').update(raw).digest();
}

function encrypt(key: Buffer, plaintext: string): EncryptedRecord {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decrypt(key: Buffer, record: EncryptedRecord): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export class ConnectedAccountStore {
  private readonly options: { readonly dataDir: string; readonly keyFilePath: string };
  private readonly filePath: string;
  private keyPromise: Promise<Buffer> | undefined;

  constructor(
    options: { readonly dataDir: string; readonly keyFilePath: string },
    fileName = 'connected-accounts.json',
  ) {
    this.options = options;
    this.filePath = join(options.dataDir, fileName);
  }

  private key(): Promise<Buffer> {
    if (!this.keyPromise) this.keyPromise = loadKey(this.options.keyFilePath);
    return this.keyPromise;
  }

  private async loadFile(): Promise<StoreFileShape> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as StoreFileShape;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: {} };
      throw err;
    }
  }

  /** Returns the decrypted credential for `onBehalfOf`, or `undefined` if none is stored. */
  async get(onBehalfOf: string): Promise<ResolvedCredential | undefined> {
    const key = await this.key();
    const file = await this.loadFile();
    const record = file.records[onBehalfOf];
    if (!record) return undefined;
    const plaintext = decrypt(key, record);
    return JSON.parse(plaintext) as ResolvedCredential;
  }

  /** Stores (overwriting any existing) credential for `onBehalfOf`. */
  async set(onBehalfOf: string, credential: ResolvedCredential): Promise<void> {
    const key = await this.key();
    const file = await this.loadFile();
    const nextRecords = {
      ...file.records,
      [onBehalfOf]: encrypt(key, JSON.stringify(credential)),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ records: nextRecords }, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }

  /** Removes the stored credential for `onBehalfOf`, if any (S2.13: `DELETE /gate/connected-
   *  accounts`). Idempotent — deleting a Principal with no stored credential is a no-op, not an
   *  error, matching `set`'s own "overwriting any existing" tolerance for either starting state. */
  async delete(onBehalfOf: string): Promise<void> {
    const file = await this.loadFile();
    if (!(onBehalfOf in file.records)) return;
    const nextRecords = { ...file.records };
    delete nextRecords[onBehalfOf];
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ records: nextRecords }, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }
}

export class ConnectedAccountCredentialResolver implements CredentialResolver {
  private readonly store: ConnectedAccountStore;

  constructor(store: ConnectedAccountStore) {
    this.store = store;
  }

  async resolve(onBehalfOf: string | undefined): Promise<ResolvedCredential> {
    if (!onBehalfOf) {
      throw new CredentialResolutionError(
        'ConnectedAccount credential resolution requires on_behalf_of',
      );
    }
    const credential = await this.store.get(onBehalfOf);
    if (!credential) {
      throw new CredentialResolutionError(`no ConnectedAccount credential for "${onBehalfOf}"`);
    }
    return credential;
  }
}
