import { describe, expect, it } from 'vitest';
import {
  ConnectionParamsCarryCredentialsError,
  assertConnectionParamsCarryNoCredentials,
  findConnectionParamsCredential,
  redactConnectionAddress,
} from './credentials.js';

/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

function refusal(params: { target: string; endpoint?: string; manifestSource?: string }): unknown {
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
    ['an Azure SAS signature', `https://store.blob.example.invalid/c?sv=2022-11-02&sig=${FAKE}`],
    ['a key in the query', `https://maps.example.invalid/api?key=${FAKE}`],
    ['an AWS SigV4 signature', `https://b.s3.example.invalid/o?X-Amz-Signature=${FAKE}`],
    ['an AWS credential scope', `https://b.s3.example.invalid/o?X-Amz-Credential=${FAKE}`],
    ['a Google V4 signature', `https://s.example.invalid/o?X-Goog-Signature=${FAKE}`],
    ['a token in the fragment', `https://app.example.invalid/cb#access_token=${FAKE}`],
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

  it.each([
    ['an OpenAPI URL', 'https://api.owner.example/openapi.json'],
    ['a plain query', 'https://api.owner.example/openapi.json?version=3'],
    ['a format query', 'https://api.owner.example/openapi?format=json'],
    ['an MCP endpoint', 'http://mcp-host:8080/mcp'],
  ])('keeps a manifest source that is %s', (_name, manifestSource) => {
    expect(refusal({ target: 'x', manifestSource })).toBeUndefined();
  });

  it.each([
    [
      'a user name and password',
      `https://ops:${FAKE}@api.owner.example/openapi.json`,
      'user name or password',
    ],
    ['a user name alone', 'https://ops@api.owner.example/openapi.json', 'user name or password'],
    ['a token in the query', `https://api.owner.example/openapi.json?token=${FAKE}`, 'credential'],
    ['an access_token pair', `https://api.owner.example/mcp?access_token=${FAKE}`, 'credential'],
    ['an api_key pair', `https://api.owner.example/openapi.json?v=3&api_key=${FAKE}`, 'credential'],
    ['a key pair', `https://api.owner.example/openapi.json?key=${FAKE}`, 'credential'],
    ['a signed URL', `https://b.s3.example/spec.json?X-Amz-Signature=${FAKE}`, 'credential'],
    ['a SAS signature', `https://s.blob.example/spec.json?sp=r&sig=${FAKE}`, 'credential'],
  ])(
    'refuses a manifest source with %s, naming the field and never the value',
    (_name, manifestSource, problem) => {
      const err = refusal({ target: 'x', manifestSource });
      expect(err).toBeInstanceOf(ConnectionParamsCarryCredentialsError);
      expect(err).toMatchObject({ details: { field: 'manifestSource' } });
      expect((err as Error).message).toContain(problem);
      expect((err as Error).message).not.toContain(FAKE);
    },
  );
});

describe('redactConnectionAddress (core 0045 copies, #620 review M2)', () => {
  /** Synthetic, JWT-shaped (`.gitleaks.toml` allows this signature segment). */
  const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';

  it.each([
    ['target', 'grafana'],
    ['target', 'ssh://deploy@db-1.example.invalid'],
    ['target', 'https://api.example.invalid/openapi.json?format=json'],
    ['endpoint', 'https://gate.example.invalid:8443/base'],
  ] as const)('leaves a clean %s exactly as it is: %s', (field, address) => {
    expect(redactConnectionAddress(field, address)).toBe(address);
  });

  it.each([
    ['endpoint', `https://ops:${FAKE}@gate.example.invalid/x`, 'https://gate.example.invalid/x'],
    ['endpoint', `https://gate.example.invalid/?token=${FAKE}`, 'https://gate.example.invalid/'],
    ['endpoint', 'https://gate.example.invalid/x#frag', 'https://gate.example.invalid/x'],
    ['endpoint', 'https://gate.example.invalid/x?', 'https://gate.example.invalid/x'],
    [
      'target',
      `https://ops:${FAKE}@grafana.example.invalid/d?token=${FAKE}`,
      'https://grafana.example.invalid/d',
    ],
    ['target', `grafana.example.invalid/api?auth=${FAKE}`, 'grafana.example.invalid/api'],
    ['target', `grafana with Bearer ${JWT}`, 'grafana with Bearer [redacted]'],
  ] as const)('cuts the credential out of %s %s', (field, address, expected) => {
    const redacted = redactConnectionAddress(field, address);
    expect(redacted).toBe(expected);
    expect(redacted).not.toContain(FAKE);
    expect(redacted).not.toContain(JWT);
    expect(findConnectionParamsCredential({ [field]: redacted })).toBeNull();
    // A second pass changes nothing (the scrub's idempotence).
    expect(redactConnectionAddress(field, redacted)).toBe(redacted);
  });
});
