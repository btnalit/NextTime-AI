import { randomUUID } from 'node:crypto';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import {
  EXPLORER_SESSION_COOKIE,
  EXPLORER_SESSION_TTL_SECONDS,
  EXPLORER_SESSION_TYP,
  ExplorerSessionInvalid,
  clearSessionCookie,
  mintExplorerSessionToken,
  parseCookieHeader,
  serializeSessionCookie,
  verifyExplorerSessionToken,
} from './session.js';

/** interfaces/explorer-contract/session.test.ts: the pure token + cookie helpers (no DB, no
 *  Fastify). The route-level behavior — cookie accepted by the nine read routes, rejected by
 *  `/api/cap/*` — lives in explorer-contract.integration.test.ts. */
describe('explorer session token', () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let otherPublicKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    otherPublicKey = (await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' })).publicKey;
  });

  const ids = () => ({
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    sessionId: randomUUID(),
  });

  it('mints a token that verifies back to the same (ws, sub, sid) with the default TTL', async () => {
    const ref = ids();
    const nowMs = 1_800_000_000_000;
    const minted = await mintExplorerSessionToken({ privateKey, ...ref, nowMs });
    expect(minted.expiresAt.getTime()).toBe(nowMs + EXPLORER_SESSION_TTL_SECONDS * 1000);

    const claims = await verifyExplorerSessionToken(minted.token, publicKey);
    expect(claims).toEqual({
      ws: ref.workspaceId,
      sub: ref.principalId,
      sid: ref.sessionId,
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + EXPLORER_SESSION_TTL_SECONDS,
    });
  });

  it('rejects an expired token', async () => {
    const minted = await mintExplorerSessionToken({
      privateKey,
      ...ids(),
      nowMs: Date.now() - 2 * 60 * 60 * 1000,
      ttlSeconds: 60,
    });
    await expect(verifyExplorerSessionToken(minted.token, publicKey)).rejects.toBeInstanceOf(
      ExplorerSessionInvalid,
    );
  });

  it('rejects a token signed by another key, and a tampered token', async () => {
    const minted = await mintExplorerSessionToken({ privateKey, ...ids() });
    await expect(verifyExplorerSessionToken(minted.token, otherPublicKey)).rejects.toBeInstanceOf(
      ExplorerSessionInvalid,
    );
    const [header, payload, signature] = minted.token.split('.');
    const tampered = `${header}.${payload?.slice(0, -2)}AA.${signature}`;
    await expect(verifyExplorerSessionToken(tampered, publicKey)).rejects.toBeInstanceOf(
      ExplorerSessionInvalid,
    );
  });

  it('rejects a Handle-shaped JWT signed with the very same key (no typ, Handle claims)', async () => {
    const ref = ids();
    const handleLike = await new SignJWT({
      ws: ref.workspaceId,
      sid: ref.sessionId,
      obo: ref.principalId,
      scope: { capabilities: ['search'], resources: {} },
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);
    await expect(verifyExplorerSessionToken(handleLike, publicKey)).rejects.toBeInstanceOf(
      ExplorerSessionInvalid,
    );
  });

  it('rejects the right typ with a wrong claims shape (extra or missing fields)', async () => {
    const ref = ids();
    const base = {
      ws: ref.workspaceId,
      sub: ref.principalId,
      sid: ref.sessionId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const withExtra = await new SignJWT({ ...base, scope: { capabilities: [], resources: {} } })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG, typ: EXPLORER_SESSION_TYP })
      .sign(privateKey);
    await expect(verifyExplorerSessionToken(withExtra, publicKey)).rejects.toBeInstanceOf(
      ExplorerSessionInvalid,
    );
    const { sid: _sid, ...missingSid } = base;
    const withoutSid = await new SignJWT(missingSid)
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG, typ: EXPLORER_SESSION_TYP })
      .sign(privateKey);
    await expect(verifyExplorerSessionToken(withoutSid, publicKey)).rejects.toBeInstanceOf(
      ExplorerSessionInvalid,
    );
  });
});

describe('explorer session cookie helpers', () => {
  it('parseCookieHeader: RFC 6265 shape, first occurrence wins, junk ignored', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
    expect(
      parseCookieHeader(
        `a=1; ${EXPLORER_SESSION_COOKIE}=tok.en.x; a=2; =novalue; noequals; b= spaced `,
      ),
    ).toEqual({ a: '1', [EXPLORER_SESSION_COOKIE]: 'tok.en.x', b: 'spaced' });
  });

  it('serializeSessionCookie / clearSessionCookie carry the same locked-down attributes', () => {
    const set = serializeSessionCookie('tok.en.x', 3600);
    expect(set).toBe(
      `${EXPLORER_SESSION_COOKIE}=tok.en.x; Max-Age=3600; Path=/api; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(serializeSessionCookie('t', -5)).toContain('Max-Age=0;');
    expect(clearSessionCookie()).toBe(
      `${EXPLORER_SESSION_COOKIE}=; Max-Age=0; Path=/api; HttpOnly; Secure; SameSite=Strict`,
    );
  });
});
