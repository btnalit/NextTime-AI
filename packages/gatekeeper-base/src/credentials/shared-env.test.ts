import { describe, expect, it } from 'vitest';
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
});
