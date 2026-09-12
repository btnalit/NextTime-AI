import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  GATE_HOST_TOKEN_AUD,
  GATE_HOST_TOKEN_TTL_SECONDS,
  GATE_HOST_TOKEN_TYP,
  GATE_SHARED_CREDENTIAL_SLOT,
  GateHostTokenInvalid,
  mintGateHostToken,
  verifyGateHostToken,
} from './gate-host-token.js';
import { HANDLE_SIGNING_ALG, HandleTokenInvalid, verifyHandleToken } from './handle-token.js';

/**
 * gate-host-token.test: unit tests only, no filesystem/DB — mirrors handle-token.test.ts's own
 * ephemeral-keypair pattern (S1.7 precedent, this module's own doc comment: "deliberately not a
 * Handle").
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

describe('mintGateHostToken / verifyGateHostToken', () => {
  it('round-trips: mint then verify returns the claims', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const { token, expiresAt } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });

    const claims = await verifyGateHostToken(token, publicKey, { expectedGateId: 'demo-mcp' });
    expect(claims).toMatchObject({
      aud: GATE_HOST_TOKEN_AUD,
      gate: 'demo-mcp',
      obo: GATE_SHARED_CREDENTIAL_SLOT,
      sub: 'admin-1',
    });
    expect(claims.exp - claims.iat).toBe(GATE_HOST_TOKEN_TTL_SECONDS);
    expect(expiresAt.getTime()).toBe(claims.exp * 1000);
  });

  it('verifyHandleToken rejects a gate-host token (wrong claims shape, not a Handle)', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const { token } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });

    await expect(verifyHandleToken(token, publicKey)).rejects.toThrow(HandleTokenInvalid);
  });

  it('rejects a token whose gate claim differs from expectedGateId', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const { token } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });

    await expect(
      verifyGateHostToken(token, publicKey, { expectedGateId: 'other-gate' }),
    ).rejects.toThrow(GateHostTokenInvalid);
  });

  it('rejects a Handle-shaped token (no aud/typ)', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const handleClaims = {
      ws: '00000000-0000-4000-8000-000000000000',
      sid: '00000000-0000-4000-8000-000000000001',
      obo: '00000000-0000-4000-8000-000000000002',
      scope: { capabilities: [], resources: {} },
      jti: '00000000-0000-4000-8000-000000000003',
      iat: nowSeconds,
      exp: nowSeconds + 300,
    };
    const token = await new SignJWT(handleClaims)
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    await expect(
      verifyGateHostToken(token, publicKey, { expectedGateId: 'demo-mcp' }),
    ).rejects.toThrow(GateHostTokenInvalid);
  });

  it('rejects an expired token', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const nowMs = Date.now() - 10 * 60_000;
    const { token } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
      nowMs,
    });

    await expect(
      verifyGateHostToken(token, publicKey, { expectedGateId: 'demo-mcp' }),
    ).rejects.toThrow(GateHostTokenInvalid);
  });

  it('rejects a token signed with another key', async () => {
    const { privateKey } = await generateEphemeralKeyPair();
    const { publicKey: otherPublicKey } = await generateEphemeralKeyPair();
    const { token } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });

    await expect(
      verifyGateHostToken(token, otherPublicKey, { expectedGateId: 'demo-mcp' }),
    ).rejects.toThrow(GateHostTokenInvalid);
  });

  it('caps ttlSeconds at 300 even when a larger value is requested', async () => {
    const { privateKey } = await generateEphemeralKeyPair();
    const { token } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
      ttlSeconds: 3600,
    });

    const [, payloadSegment] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadSegment as string, 'base64url').toString('utf8'));
    expect(payload.exp - payload.iat).toBe(GATE_HOST_TOKEN_TTL_SECONDS);
  });

  it('mints a token whose header carries the gate-host typ, distinct from a Handle', async () => {
    const { privateKey } = await generateEphemeralKeyPair();
    const { token } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: GATE_SHARED_CREDENTIAL_SLOT,
      subject: 'admin-1',
    });
    const [headerSegment] = token.split('.');
    const header = JSON.parse(Buffer.from(headerSegment as string, 'base64url').toString('utf8'));
    expect(header.typ).toBe(GATE_HOST_TOKEN_TYP);
    expect(header.alg).toBe(HANDLE_SIGNING_ALG);
  });
});
