import { randomUUID } from 'node:crypto';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  CapabilityScopeSchema,
  HANDLE_SIGNING_ALG,
  HandleClaimsSchema,
  HandleTokenExpired,
  HandleTokenInvalid,
  importHandlePublicKey,
  verifyHandleToken,
} from './handle-token.js';

/**
 * handle-token.test: unit tests only, no filesystem/DB — mirrors the "unit (ephemeral keys)"
 * half of packages/kernel/src/governance/capability/handles.test.ts, which is what this module
 * was split out of (S1.7 "共享 Handle-token 原语").
 */

async function generateEphemeralKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}> {
  const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
    crv: 'Ed25519',
    extractable: true,
  });
  return { privateKey, publicKey };
}

function validClaims(overrides: Partial<Record<string, unknown>> = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    ws: randomUUID(),
    sid: randomUUID(),
    obo: randomUUID(),
    scope: { capabilities: ['get_object'], resources: {} },
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + 300,
    ...overrides,
  };
}

describe('CapabilityScopeSchema / HandleClaimsSchema', () => {
  it('accepts a well-formed scope and claims set', () => {
    const scope = { capabilities: ['get_object', 'traverse'], resources: { gatekeeper: ['gk-1'] } };
    expect(CapabilityScopeSchema.parse(scope)).toEqual(scope);

    const claims = validClaims({ scope });
    expect(HandleClaimsSchema.parse(claims)).toEqual(claims);
  });

  it('rejects unknown keys (strict) on both schemas', () => {
    expect(() =>
      CapabilityScopeSchema.parse({ capabilities: [], resources: {}, extra: 1 }),
    ).toThrow();
    expect(() => HandleClaimsSchema.parse({ ...validClaims(), extra: 1 })).toThrow();
  });
});

describe('importHandlePublicKey / verifyHandleToken', () => {
  it('round-trips: a token signed with the private key verifies with the imported public key', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const publicPem = await exportSPKI(publicKey);
    const imported = await importHandlePublicKey(publicPem);

    const claims = validClaims();
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    const verified = await verifyHandleToken(token, imported);
    expect(verified).toEqual(claims);
  });

  it('throws HandleTokenExpired for a token whose exp claim is in the past', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT(validClaims({ iat: nowSeconds - 120, exp: nowSeconds - 60 }))
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    await expect(verifyHandleToken(token, publicKey)).rejects.toThrow(HandleTokenExpired);
  });

  it('throws HandleTokenInvalid for a tampered token (signature no longer matches)', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const token = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    const segments = token.split('.');
    const payload = segments[1] as string;
    const flippedChar = payload[0] === 'A' ? 'B' : 'A';
    segments[1] = `${flippedChar}${payload.slice(1)}`;
    const tampered = segments.join('.');

    await expect(verifyHandleToken(tampered, publicKey)).rejects.toThrow(HandleTokenInvalid);
  });

  it('throws HandleTokenInvalid for garbage input', async () => {
    const { publicKey } = await generateEphemeralKeyPair();
    await expect(verifyHandleToken('not-a-jwt-at-all', publicKey)).rejects.toThrow(
      HandleTokenInvalid,
    );
  });

  it('throws HandleTokenInvalid when the claims payload does not match HandleClaimsSchema', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const token = await new SignJWT({ not: 'a valid handle claims set' })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    await expect(verifyHandleToken(token, publicKey)).rejects.toThrow(HandleTokenInvalid);
  });

  it('never checks revocation — a token with a revoked-looking jti still verifies structurally', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const claims = validClaims();
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    // No isRevoked hook exists on this function by design (module doc comment) — this just
    // documents that expectation so a future change adding one here doesn't silently pass.
    await expect(verifyHandleToken(token, publicKey)).resolves.toEqual(claims);
  });
});
