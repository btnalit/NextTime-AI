import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { describe, expect, it } from 'vitest';
import { mintGateHostToken, verifyGateHostToken } from './gate-host-token.js';
import { HANDLE_SIGNING_ALG, HandleTokenInvalid, verifyHandleToken } from './handle-token.js';
import {
  LLM_ADMIN_TOKEN_AUD,
  LLM_ADMIN_TOKEN_TTL_SECONDS,
  LLM_ADMIN_TOKEN_TYP,
  LlmAdminTokenInvalid,
  mintLlmAdminToken,
  verifyLlmAdminToken,
} from './llm-admin-token.js';

/**
 * llm-admin-token.test: unit tests only — mirrors gate-host-token.test.ts (the same "signed with
 * the Handle key but deliberately not a Handle" construction). The cross-acceptance cases are the
 * ones that matter: a Handle is never an admin token, an admin token is never a Handle, and the
 * two 5-minute platform tokens (gate host / llm admin) do not accept each other either.
 */

const JTI = '11111111-2222-4333-8444-555555555555';

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

describe('mintLlmAdminToken / verifyLlmAdminToken', () => {
  it('round-trips: mint then verify returns the claims', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const { token, expiresAt } = await mintLlmAdminToken({
      privateKey,
      subject: 'admin-1',
      jti: JTI,
    });

    const claims = await verifyLlmAdminToken(token, publicKey);
    expect(claims).toMatchObject({ aud: LLM_ADMIN_TOKEN_AUD, sub: 'admin-1', jti: JTI });
    expect(claims.exp - claims.iat).toBe(LLM_ADMIN_TOKEN_TTL_SECONDS);
    expect(expiresAt.getTime()).toBe(claims.exp * 1000);
  });

  it('verifyHandleToken rejects an admin token (wrong claims shape, not a Handle)', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const { token } = await mintLlmAdminToken({ privateKey, subject: 'admin-1', jti: JTI });

    await expect(verifyHandleToken(token, publicKey)).rejects.toThrow(HandleTokenInvalid);
  });

  it('rejects a Handle-shaped token (no aud / typ) with reason invalid', async () => {
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

    const thrown = await verifyLlmAdminToken(token, publicKey).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(LlmAdminTokenInvalid);
    expect((thrown as LlmAdminTokenInvalid).reason).toBe('invalid');
  });

  it('does not accept a gate-host token, and the gate host does not accept an admin token', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const gate = await mintGateHostToken({
      privateKey,
      gateId: 'demo-mcp',
      onBehalfOf: '__shared__',
      subject: 'admin-1',
    });
    await expect(verifyLlmAdminToken(gate.token, publicKey)).rejects.toThrow(LlmAdminTokenInvalid);

    const admin = await mintLlmAdminToken({ privateKey, subject: 'admin-1', jti: JTI });
    await expect(
      verifyGateHostToken(admin.token, publicKey, { expectedGateId: 'demo-mcp' }),
    ).rejects.toThrow();
  });

  it('rejects an expired token with reason expired', async () => {
    const { privateKey, publicKey } = await generateEphemeralKeyPair();
    const { token } = await mintLlmAdminToken({
      privateKey,
      subject: 'admin-1',
      jti: JTI,
      nowMs: Date.now() - 10 * 60_000,
    });

    const thrown = await verifyLlmAdminToken(token, publicKey).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(LlmAdminTokenInvalid);
    expect((thrown as LlmAdminTokenInvalid).reason).toBe('expired');
  });

  it('rejects a token signed with another key', async () => {
    const { privateKey } = await generateEphemeralKeyPair();
    const { publicKey: otherPublicKey } = await generateEphemeralKeyPair();
    const { token } = await mintLlmAdminToken({ privateKey, subject: 'admin-1', jti: JTI });

    await expect(verifyLlmAdminToken(token, otherPublicKey)).rejects.toThrow(LlmAdminTokenInvalid);
  });

  it('caps ttlSeconds at 300 even when a larger value is requested', async () => {
    const { privateKey } = await generateEphemeralKeyPair();
    const { token } = await mintLlmAdminToken({
      privateKey,
      subject: 'admin-1',
      jti: JTI,
      ttlSeconds: 3600,
    });

    const [, payloadSegment] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadSegment as string, 'base64url').toString('utf8'));
    expect(payload.exp - payload.iat).toBe(LLM_ADMIN_TOKEN_TTL_SECONDS);
  });

  it('mints a token whose header carries the llm-admin typ, distinct from a Handle', async () => {
    const { privateKey } = await generateEphemeralKeyPair();
    const { token } = await mintLlmAdminToken({ privateKey, subject: 'admin-1', jti: JTI });
    const [headerSegment] = token.split('.');
    const header = JSON.parse(Buffer.from(headerSegment as string, 'base64url').toString('utf8'));
    expect(header.typ).toBe(LLM_ADMIN_TOKEN_TYP);
    expect(header.alg).toBe(HANDLE_SIGNING_ALG);
  });

  it('refuses to mint with a non-uuid jti (the audit correlation key must be well-formed)', async () => {
    const { privateKey } = await generateEphemeralKeyPair();
    await expect(
      mintLlmAdminToken({ privateKey, subject: 'admin-1', jti: 'not-a-uuid' }),
    ).rejects.toThrow();
  });
});
