import { describe, expect, it } from 'vitest';
import {
  ConnectionParamsCarryCredentialsError,
  assertConnectionParamsCarryNoCredentials,
} from './credentials.js';

/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

function refusal(params: { target: string; endpoint?: string }): unknown {
  try {
    assertConnectionParamsCarryNoCredentials('create_connection', params);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('assertConnectionParamsCarryNoCredentials (legacy 186)', () => {
  it.each([
    ['a plain name', 'grafana'],
    ['a URL', 'https://grafana.example.invalid/dashboards'],
    ['a user name alone', 'ssh://deploy@db-1.example.invalid'],
    ['user@host', 'deploy@db-1'],
    ['words about a token', 'the token service, rotated weekly'],
  ])('keeps a target that is %s', (_name, target) => {
    expect(refusal({ target })).toBeUndefined();
  });

  it.each([
    ['a URL password', `https://ops:${FAKE}@grafana.example.invalid`],
    ['a secret query parameter', `https://grafana.example.invalid/?token=${FAKE}`],
    ['an api_key pair', `grafana api_key=${FAKE}`],
    ['a Bearer value', `Bearer ${FAKE}`],
  ])('refuses a target carrying %s, naming the field and never the value', (_name, target) => {
    const err = refusal({ target });
    expect(err).toBeInstanceOf(ConnectionParamsCarryCredentialsError);
    expect(err).toMatchObject({
      code: 'credentials_in_connection_params',
      details: { field: 'target' },
    });
    expect((err as Error).message).toMatch(/^create_connection: target /);
    expect((err as Error).message).not.toContain(FAKE);
  });

  it.each([
    ['a plain base URL', 'https://gate.owner.example'],
    ['a base URL with a path', 'https://gate.owner.example/v1/'],
    ['text that is not a URL (left to the outbound-target check)', 'not a url'],
  ])('keeps an endpoint that is %s', (_name, endpoint) => {
    expect(refusal({ target: 'x', endpoint })).toBeUndefined();
  });

  it.each([
    ['a user name and password', `https://ops:${FAKE}@gate.owner.example`, 'user name or password'],
    ['a user name alone', 'https://ops@gate.owner.example', 'user name or password'],
    ['a query string', `https://gate.owner.example/?token=${FAKE}`, 'query string'],
    ['a bare ?', 'https://gate.owner.example/?', 'query string'],
    ['a fragment', `https://gate.owner.example/#${FAKE}`, 'fragment'],
    ['a bare #', 'https://gate.owner.example/#', 'fragment'],
  ])('refuses an endpoint with %s', (_name, endpoint, problem) => {
    const err = refusal({ target: 'x', endpoint });
    expect(err).toBeInstanceOf(ConnectionParamsCarryCredentialsError);
    expect(err).toMatchObject({ details: { field: 'endpoint' } });
    expect((err as Error).message).toContain(problem);
    expect((err as Error).message).not.toContain(FAKE);
  });
});
