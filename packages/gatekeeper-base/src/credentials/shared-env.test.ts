import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialResolutionError } from '../errors.js';
import { SharedEnvCredentialResolver } from './shared-env.js';

describe('SharedEnvCredentialResolver', () => {
  it('reads GATE_CREDENTIAL_<NAME> and wraps a plain string as {token}', async () => {
    const resolver = new SharedEnvCredentialResolver({
      env: { GATE_CREDENTIAL_DEFAULT: 'abc123' },
    });
    await expect(resolver.resolve(undefined)).resolves.toEqual({ token: 'abc123' });
  });

  it('parses a JSON object value as a structured credential', async () => {
    const resolver = new SharedEnvCredentialResolver({
      env: { GATE_CREDENTIAL_DEFAULT: '{"username":"svc","password":"pw"}' },
    });
    await expect(resolver.resolve(undefined)).resolves.toEqual({ username: 'svc', password: 'pw' });
  });

  it('ignores on_behalf_of — the shared credential applies to every caller', async () => {
    const resolver = new SharedEnvCredentialResolver({ env: { GATE_CREDENTIAL_DEFAULT: 'x' } });
    await expect(resolver.resolve('user-a')).resolves.toEqual({ token: 'x' });
    await expect(resolver.resolve('user-b')).resolves.toEqual({ token: 'x' });
  });

  it('throws when the env var is not set', async () => {
    const resolver = new SharedEnvCredentialResolver({ env: {} });
    await expect(resolver.resolve(undefined)).rejects.toBeInstanceOf(CredentialResolutionError);
  });

  it('supports a named credential other than DEFAULT', async () => {
    const resolver = new SharedEnvCredentialResolver({
      name: 'DOCKER',
      env: { GATE_CREDENTIAL_DOCKER: 'd' },
    });
    await expect(resolver.resolve(undefined)).resolves.toEqual({ token: 'd' });
  });

  // R-24: the credential comes from GATE_CREDENTIAL_<NAME>_FILE first; the env var is a deprecated
  // fallback that keeps an un-migrated host working.
  describe('file first (R-24)', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    function keyFile(content: string): string {
      dir = mkdtempSync(join(tmpdir(), 'gate-credential-'));
      const path = join(dir, 'api_key');
      writeFileSync(path, content);
      return path;
    }

    it('reads the file (trailing newline ignored) and prefers it over the env var, without a warning', async () => {
      const lines: string[] = [];
      const resolver = new SharedEnvCredentialResolver({
        name: 'RAGFLOW_API_KEY',
        env: {
          GATE_CREDENTIAL_RAGFLOW_API_KEY_FILE: keyFile('ragflow-from-file\n'),
          GATE_CREDENTIAL_RAGFLOW_API_KEY: 'ragflow-from-env',
        },
        log: (line) => lines.push(line),
      });
      await expect(resolver.resolve(undefined)).resolves.toEqual({ token: 'ragflow-from-file' });
      expect(lines).toEqual([]);
    });

    it('falls back to the env var when the file is absent, warning once and never logging the value', async () => {
      const lines: string[] = [];
      const resolver = new SharedEnvCredentialResolver({
        name: 'RAGFLOW_API_KEY',
        env: {
          GATE_CREDENTIAL_RAGFLOW_API_KEY_FILE: join(tmpdir(), 'no-such-gate-credential-r24'),
          GATE_CREDENTIAL_RAGFLOW_API_KEY: 'ragflow-from-env',
        },
        log: (line) => lines.push(line),
      });
      await expect(resolver.resolve(undefined)).resolves.toEqual({ token: 'ragflow-from-env' });
      await expect(resolver.resolve(undefined)).resolves.toEqual({ token: 'ragflow-from-env' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('deprecated');
      expect(lines[0]).not.toContain('ragflow-from-env');
    });

    it('an empty file falls back to the env var too', async () => {
      const resolver = new SharedEnvCredentialResolver({
        env: { GATE_CREDENTIAL_DEFAULT_FILE: keyFile('\n'), GATE_CREDENTIAL_DEFAULT: 'x' },
        log: () => undefined,
      });
      await expect(resolver.resolve(undefined)).resolves.toEqual({ token: 'x' });
    });

    it('neither a file nor the env var is a resolution error', async () => {
      const resolver = new SharedEnvCredentialResolver({
        env: { GATE_CREDENTIAL_DEFAULT_FILE: join(tmpdir(), 'no-such-gate-credential-r24') },
      });
      await expect(resolver.resolve(undefined)).rejects.toBeInstanceOf(CredentialResolutionError);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'an unreadable file with no env fallback names the file in the error',
      async () => {
        const path = keyFile('secret');
        chmodSync(path, 0o000);
        const resolver = new SharedEnvCredentialResolver({
          env: { GATE_CREDENTIAL_DEFAULT_FILE: path },
        });
        await expect(resolver.resolve(undefined)).rejects.toThrow(/could not be read/);
      },
    );
  });
});
