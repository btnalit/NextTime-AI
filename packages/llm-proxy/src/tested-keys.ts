import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-file.js';
import { Mutex } from './mutex.js';

/**
 * tested-keys: which key each provider's last test ran with (legacy 202, 203), so a test result
 * is shown only while the provider still uses that key.
 *
 * A console key set or cleared drops the last test (admin-api.ts `forgetTest`), but two changes
 * slipped past that:
 *   - an env or key-file key (`api_key_env`) rotated by editing `secrets/` and restarting — the
 *     persisted `last_test` in providers.json kept saying the old key worked (202);
 *   - a `/test` still running when the console key changed — its result landed after the drop
 *     and was recorded as if the new key had passed (203).
 * Both are the same question: "was this result tested with the key in use now?". So every
 * recorded result is paired with a digest of the key it ran with and the result's own
 * `tested_at`, and catalog.ts shows a result only when that pair matches the result and the key
 * the provider would use now. A result whose key differs reads 未测试, like a fresh key's.
 *
 * What the file holds: per provider id, a scrypt digest of the key under a random salt of its own,
 * and the `tested_at` of the result it describes — never the key. Mode 0600 like keys.json
 * (key-store.ts), in the same state directory, and in every backup archive of it
 * (docs/runbooks/backup-restore.md).
 *
 * What a digest exposes: a console key is in keys.json next to this file anyway. An env or
 * key-file key (`api_key_env`) lives in `secrets/` — outside the state directory and the archives
 * — so its digest here is the only trace of it there, and a weak one (a short passphrase on a
 * self-hosted gateway) could be guessed offline against it. A random vendor key cannot. scrypt
 * makes each guess cost tens of milliseconds instead of microseconds (KEY_DIGEST), and the salt
 * per entry makes every entry a separate search.
 *
 * Cost at run time: `resolve()` checks every provider on every call, the proxy's routing
 * included, so a verdict is kept in memory per provider, with the key it was reached for (a key
 * this process already holds), and scrypt runs only when the key or the result changes — once
 * per tested provider at startup, and once per test, off the event loop.
 *
 * Why its own file, not a field on providers.json's `last_test`: that schema is `.strict()`, so
 * an older llm-proxy would refuse to start on a store carrying a new field — a rollback must not
 * depend on it. An older version ignores this file.
 *
 * States per provider:
 *   - no entry — the provider was never tested on this version: its result, if any, was recorded
 *     by an older one, so its key is unknown, and it is shown as before. (A result an older
 *     version records after a rollback, for a provider that has an entry, does not match that
 *     entry's `tested_at` and is not shown.)
 *   - `{ key: null, testedAt: null }` — tracked, no result's key known yet: written before a
 *     provider's first result on this version (`track`), so a crash between the result write and
 *     its entry leaves a result that is not shown, rather than one that reads as recorded before
 *     this file.
 *   - `{ key: { salt, digest }, testedAt }` — the result with that `tested_at` ran with that key.
 *
 * A missing file is an empty one. An unreadable or invalid file is logged and read as empty
 * (every result shown as before) rather than failing startup over a status display; the next
 * write replaces it.
 */

export const TESTED_KEYS_VERSION = 1;
export const TESTED_KEYS_FILE_NAME = 'tested-keys.json';
const TESTED_KEYS_FILE_MODE = 0o600;

/** scrypt parameters of a key's digest (part of `TESTED_KEYS_VERSION`: changing them is a new
 *  version). 32 MiB and about 0.1 s per digest on a current core; OWASP's password-storage floor
 *  is four times that, which suits a login checked once a session — here a digest is checked on
 *  a provider's first resolve after startup, synchronously, before the proxy serves. */
export const KEY_DIGEST = {
  N: 2 ** 15,
  r: 8,
  p: 1,
  keyLength: 32,
  saltBytes: 16,
  maxmem: 64 * 1024 * 1024,
} as const;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const KeyDigestSchema = z
  .object({
    salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
type KeyDigest = z.infer<typeof KeyDigestSchema>;

const TestedKeyEntrySchema = z
  .object({
    key: KeyDigestSchema.nullable(),
    testedAt: z.string().nullable(),
  })
  .strict();
type TestedKeyEntry = z.infer<typeof TestedKeyEntrySchema>;

const TestedKeysFileSchema = z
  .object({
    version: z.literal(TESTED_KEYS_VERSION),
    providers: z.record(z.string(), TestedKeyEntrySchema),
  })
  .strict();
type TestedKeysFile = z.infer<typeof TestedKeysFileSchema>;

/** Where the file goes: next to `keys.json`, in the same read-write state directory. */
export function testedKeysFile(keyStoreFile: string): string {
  return join(dirname(keyStoreFile), TESTED_KEYS_FILE_NAME);
}

/** Whether a recorded result was tested with the key in use now: `same`, `other` (another key,
 *  or none now, or the result has no entry of its own) or `unknown` (recorded before this file). */
export type TestedKeyMatch = 'same' | 'other' | 'unknown';

export class TestedKeys {
  private readonly filePath: string;
  private readonly log: (line: string) => void;
  private state: TestedKeysFile = emptyFile();
  private readonly mutex = new Mutex();
  /** Per provider, a verdict on the current entry and the key it is for — memory only. `record`
   *  installs one with the entry it writes, so a verdict never outlives its entry (`track` leaves
   *  an entry that matches nothing before a verdict is read). */
  private readonly verdicts = new Map<string, { readonly key: string; readonly same: boolean }>();

  constructor(filePath: string, log: (line: string) => void = (line) => console.log(line)) {
    this.filePath = filePath;
    this.log = log;
  }

  async load(): Promise<void> {
    this.verdicts.clear();
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.warnUnread(code ?? 'unreadable');
      this.state = emptyFile();
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.warnUnread('invalid_json');
      this.state = emptyFile();
      return;
    }
    const parsed = TestedKeysFileSchema.safeParse(json);
    if (!parsed.success) {
      this.warnUnread('invalid_shape');
      this.state = emptyFile();
      return;
    }
    this.state = parsed.data;
  }

  /** Whether this file has an entry for `id` at all (see the module doc's states). */
  tracks(id: string): boolean {
    return Object.hasOwn(this.state.providers, id);
  }

  /** Whether the result recorded at `testedAt` ran with `currentKey` (the key the provider would
   *  use now; `undefined` when it has none). */
  match(id: string, testedAt: string, currentKey: string | undefined): TestedKeyMatch {
    if (!this.tracks(id)) return 'unknown';
    const entry = this.state.providers[id] as TestedKeyEntry;
    // A tracked entry with no key (and no `testedAt`) matches no result.
    if (entry.testedAt !== testedAt || entry.key === null || currentKey === undefined) {
      return 'other';
    }
    const known = this.verdicts.get(id);
    if (known?.key === currentKey) return known.same ? 'same' : 'other';
    // The entry's key is `known.key`; any other key is not it.
    if (known?.same) return 'other';
    const same = digestMatches(entry.key, currentKey);
    this.verdicts.set(id, { key: currentKey, same });
    return same ? 'same' : 'other';
  }

  /** Records that the result stamped `testedAt` ran with `key`. */
  async record(id: string, testedAt: string, key: string): Promise<void> {
    const salt = randomBytes(KEY_DIGEST.saltBytes);
    const digest = await scryptAsync(key, salt, KEY_DIGEST.keyLength, scryptOptions());
    await this.write(
      id,
      { key: { salt: salt.toString('base64url'), digest: digest.toString('hex') }, testedAt },
      { key, same: true },
    );
  }

  /** Starts tracking `id` with no result's key known (see the module doc's states). */
  async track(id: string): Promise<void> {
    await this.write(id, { key: null, testedAt: null });
  }

  /** The in-memory state changes first, so this process reads the new entry even when the file
   *  cannot be written. Never throws: a failed write is logged and leaves the previous file, which
   *  after a restart describes an older result — not shown, since its `tested_at` differs — or
   *  none (a provider recorded before this file: shown as before). */
  private async write(
    id: string,
    entry: TestedKeyEntry,
    verdict?: { readonly key: string; readonly same: boolean },
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      this.state = { ...this.state, providers: { ...this.state.providers, [id]: entry } };
      if (verdict) this.verdicts.set(id, verdict);
      try {
        await writeFileAtomic(
          this.filePath,
          `${JSON.stringify(this.state, null, 2)}\n`,
          TESTED_KEYS_FILE_MODE,
        );
      } catch (err) {
        this.log(
          JSON.stringify({
            level: 'warn',
            msg: 'llm-proxy: tested-keys.json could not be written — this process still knows which key each test ran with; after a restart the previous file is read',
            file: this.filePath,
            providerId: id,
            reason: (err as NodeJS.ErrnoException | undefined)?.code ?? 'write_failed',
          }),
        );
      }
    });
  }

  /** `reason` is an errno code or a fixed word — never the parser's message, which can quote the
   *  file. */
  private warnUnread(reason: string): void {
    this.log(
      JSON.stringify({
        level: 'warn',
        msg: 'llm-proxy: tested-keys.json could not be read — test results recorded before this start are shown without checking which key they ran with; the next test or key change rewrites the file',
        file: this.filePath,
        reason,
      }),
    );
  }
}

function emptyFile(): TestedKeysFile {
  return { version: TESTED_KEYS_VERSION, providers: {} };
}

function scryptOptions(): { N: number; r: number; p: number; maxmem: number } {
  return { N: KEY_DIGEST.N, r: KEY_DIGEST.r, p: KEY_DIGEST.p, maxmem: KEY_DIGEST.maxmem };
}

function digestMatches(stored: KeyDigest, key: string): boolean {
  const computed = scryptSync(
    key,
    Buffer.from(stored.salt, 'base64url'),
    KEY_DIGEST.keyLength,
    scryptOptions(),
  );
  return timingSafeEqual(computed, Buffer.from(stored.digest, 'hex'));
}
