import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HANDLE_SIGNING_ALG } from '@nexttime/shared';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAuth } from './config.js';
import {
  HandleAuthError,
  extractHandleToken,
  loadHandlePublicKey,
  verifyInboundHandle,
} from './handle-auth.js';

async function ephemeralKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
    crv: 'Ed25519',
    extractable: true,
  });
  return { privateKey, publicKey };
}

async function signHandle(
  privateKey: CryptoKey,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    ws: randomUUID(),
    sid: randomUUID(),
    obo: randomUUID(),
    scope: { capabilities: [], resources: {} },
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + 300,
    ...overrides,
  };
  return new SignJWT(claims).setProtectedHeader({ alg: HANDLE_SIGNING_ALG }).sign(privateKey);
}

describe('extractHandleToken', () => {
  const bearerAuth: ProviderAuth = { header: 'authorization', scheme: 'Bearer' };
  const xApiKeyAuth: ProviderAuth = { header: 'x-api-key' };

  it('extracts a bearer token from the configured header, stripping the scheme', () => {
    const token = extractHandleToken({ authorization: 'Bearer abc.def.ghi' }, bearerAuth);
    expect(token).toBe('abc.def.ghi');
  });

  it('extracts a raw token from x-api-key with no scheme', () => {
    const token = extractHandleToken({ 'x-api-key': 'abc.def.ghi' }, xApiKeyAuth);
    expect(token).toBe('abc.def.ghi');
  });

  it('throws HandleAuthError("missing") when the header is absent', () => {
    expect(() => extractHandleToken({}, bearerAuth)).toThrow(HandleAuthError);
    try {
      extractHandleToken({}, bearerAuth);
    } catch (err) {
      expect(err).toBeInstanceOf(HandleAuthError);
      expect((err as HandleAuthError).reason).toBe('missing');
    }
  });

  it('throws HandleAuthError("missing") when the header does not start with the configured scheme', () => {
    expect(() => extractHandleToken({ authorization: 'Basic abc' }, bearerAuth)).toThrow(
      HandleAuthError,
    );
  });

  it('throws HandleAuthError("missing") for an array header value with no usable entry', () => {
    expect(() =>
      extractHandleToken({ authorization: [] as unknown as string }, bearerAuth),
    ).toThrow(HandleAuthError);
  });
});

describe('verifyInboundHandle', () => {
  it('returns claims for a valid, unrevoked token', async () => {
    const { privateKey, publicKey } = await ephemeralKeyPair();
    const token = await signHandle(privateKey);

    const claims = await verifyInboundHandle(token, { publicKey, isRevoked: () => false });
    expect(claims.jti).toBeDefined();
  });

  it('throws HandleAuthError("expired") for an expired token', async () => {
    const { privateKey, publicKey } = await ephemeralKeyPair();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signHandle(privateKey, { iat: nowSeconds - 120, exp: nowSeconds - 60 });

    await expect(
      verifyInboundHandle(token, { publicKey, isRevoked: () => false }),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('throws HandleAuthError("invalid") for a tampered token', async () => {
    const { privateKey, publicKey } = await ephemeralKeyPair();
    const token = await signHandle(privateKey);
    const segments = token.split('.');
    const payload = segments[1] as string;
    segments[1] = `${payload[0] === 'A' ? 'B' : 'A'}${payload.slice(1)}`;
    const tampered = segments.join('.');

    await expect(
      verifyInboundHandle(tampered, { publicKey, isRevoked: () => false }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('throws HandleAuthError("invalid") for garbage input', async () => {
    const { publicKey } = await ephemeralKeyPair();
    await expect(
      verifyInboundHandle('not-a-jwt', { publicKey, isRevoked: () => false }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('throws HandleAuthError("revoked") when isRevoked reports true for the claims jti', async () => {
    const { privateKey, publicKey } = await ephemeralKeyPair();
    const token = await signHandle(privateKey);

    await expect(
      verifyInboundHandle(token, { publicKey, isRevoked: () => true }),
    ).rejects.toMatchObject({ reason: 'revoked' });
  });
});

describe('loadHandlePublicKey', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('loads a public key that verifies a token signed by the matching private key', async () => {
    const { privateKey, publicKey } = await ephemeralKeyPair();
    const pem = await exportSPKI(publicKey);
    dir = mkdtempSync(path.join(tmpdir(), 'nexttime-llm-proxy-handle-pub-test-'));
    const file = path.join(dir, 'handle.pub');
    writeFileSync(file, pem, 'utf8');

    const loaded = await loadHandlePublicKey(file);
    const token = await signHandle(privateKey);
    const claims = await verifyInboundHandle(token, { publicKey: loaded, isRevoked: () => false });
    expect(claims.jti).toBeDefined();
  });
});
