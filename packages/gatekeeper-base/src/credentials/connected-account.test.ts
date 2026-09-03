import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialResolutionError } from '../errors.js';
import { ConnectedAccountCredentialResolver, ConnectedAccountStore } from './connected-account.js';

describe('ConnectedAccountStore', () => {
  let dir: string;
  let keyFilePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gatekeeper-connected-account-'));
    keyFilePath = join(dir, 'store.key');
    await writeFile(keyFilePath, 'a-passphrase-not-32-bytes-long');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a credential per on_behalf_of, encrypted at rest', async () => {
    const store = new ConnectedAccountStore({ dataDir: dir, keyFilePath });
    await store.set('user-a', { token: 'secret-a' });
    await store.set('user-b', { token: 'secret-b' });

    expect(await store.get('user-a')).toEqual({ token: 'secret-a' });
    expect(await store.get('user-b')).toEqual({ token: 'secret-b' });
    expect(await store.get('user-c')).toBeUndefined();
  });

  it('resolver returns the right credential per on_behalf_of and throws when none is stored', async () => {
    const store = new ConnectedAccountStore({ dataDir: dir, keyFilePath });
    await store.set('user-a', { token: 'secret-a' });
    const resolver = new ConnectedAccountCredentialResolver(store);

    await expect(resolver.resolve('user-a')).resolves.toEqual({ token: 'secret-a' });
    await expect(resolver.resolve('user-missing')).rejects.toBeInstanceOf(
      CredentialResolutionError,
    );
    await expect(resolver.resolve(undefined)).rejects.toBeInstanceOf(CredentialResolutionError);
  });

  it('the on-disk file never contains the plaintext credential', async () => {
    const store = new ConnectedAccountStore({ dataDir: dir, keyFilePath });
    await store.set('user-a', { token: 'super-secret-value' });
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(dir, 'connected-accounts.json'), 'utf8');
    expect(raw).not.toContain('super-secret-value');
  });

  it('delete removes a stored credential without touching others, and is idempotent', async () => {
    const store = new ConnectedAccountStore({ dataDir: dir, keyFilePath });
    await store.set('user-a', { token: 'secret-a' });
    await store.set('user-b', { token: 'secret-b' });

    await store.delete('user-a');
    expect(await store.get('user-a')).toBeUndefined();
    expect(await store.get('user-b')).toEqual({ token: 'secret-b' });

    // Idempotent: deleting again (or a Principal that was never stored) does not throw.
    await expect(store.delete('user-a')).resolves.toBeUndefined();
    await expect(store.delete('user-never-stored')).resolves.toBeUndefined();
  });
});
