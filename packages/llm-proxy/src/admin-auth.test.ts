import { randomUUID } from 'node:crypto';
import { HANDLE_SIGNING_ALG, mintGateHostToken, mintLlmAdminToken } from '@nexttime/shared';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { describe, expect, it } from 'vitest';
import { AdminAuthError, authenticateAdminRequest } from './admin-auth.js';

/**
 * admin-auth.test: every way into `/admin/*` that must fail — no CSRF header (403), no / empty
 * bearer (401), a Handle (401), a gate-host token (401), an expired admin token (401
 * `token_expired`), a token from another key (401) — and the one that succeeds.
 */

async function keys(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  return generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519', extractable: true });
}

const CSRF = { 'x-requested-with': 'nexttime' };

async function expectFailure(
  call: Promise<unknown>,
  expected: { status: number; code: string; reason: AdminAuthError['reason'] },
) {
  const thrown = await call.then(
    () => {
      throw new Error('expected AdminAuthError');
    },
    (err: unknown) => err,
  );
  expect(thrown).toBeInstanceOf(AdminAuthError);
  expect(thrown as AdminAuthError).toMatchObject(expected);
}

describe('authenticateAdminRequest', () => {
  it('accepts a valid admin token with the CSRF header and returns its claims', async () => {
    const { privateKey, publicKey } = await keys();
    const jti = randomUUID();
    const { token } = await mintLlmAdminToken({ privateKey, subject: 'user-1', jti });
    const claims = await authenticateAdminRequest(
      { ...CSRF, authorization: `Bearer ${token}` },
      { publicKey },
    );
    expect(claims).toMatchObject({ sub: 'user-1', jti, aud: 'llm-admin' });
  });

  it('403s without the X-Requested-With header, even with a valid token', async () => {
    const { privateKey, publicKey } = await keys();
    const { token } = await mintLlmAdminToken({ privateKey, subject: 'user-1', jti: randomUUID() });
    await expectFailure(
      authenticateAdminRequest({ authorization: `Bearer ${token}` }, { publicKey }),
      { status: 403, code: 'csrf_header_required', reason: 'csrf' },
    );
  });

  it('401s with no bearer token, or an empty one', async () => {
    const { publicKey } = await keys();
    await expectFailure(authenticateAdminRequest({ ...CSRF }, { publicKey }), {
      status: 401,
      code: 'unauthorized',
      reason: 'missing',
    });
    await expectFailure(
      authenticateAdminRequest({ ...CSRF, authorization: 'Bearer ' }, { publicKey }),
      {
        status: 401,
        code: 'unauthorized',
        reason: 'missing',
      },
    );
  });

  it('401s a Handle token (a Worker / entry agent can never reach the admin routes)', async () => {
    const { privateKey, publicKey } = await keys();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const handle = await new SignJWT({
      ws: randomUUID(),
      sid: randomUUID(),
      obo: randomUUID(),
      scope: { capabilities: [], resources: {} },
      jti: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + 300,
    })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);
    await expectFailure(
      authenticateAdminRequest({ ...CSRF, authorization: `Bearer ${handle}` }, { publicKey }),
      { status: 401, code: 'unauthorized', reason: 'invalid' },
    );
  });

  it('401s a gate-host token (different aud / typ)', async () => {
    const { privateKey, publicKey } = await keys();
    const { token } = await mintGateHostToken({
      privateKey,
      gateId: 'demo-gate',
      onBehalfOf: '__shared__',
      subject: 'user-1',
    });
    await expectFailure(
      authenticateAdminRequest({ ...CSRF, authorization: `Bearer ${token}` }, { publicKey }),
      { status: 401, code: 'unauthorized', reason: 'invalid' },
    );
  });

  it('401s an expired admin token with the distinct token_expired code', async () => {
    const { privateKey, publicKey } = await keys();
    const { token } = await mintLlmAdminToken({
      privateKey,
      subject: 'user-1',
      jti: randomUUID(),
      nowMs: Date.now() - 20 * 60_000,
    });
    await expectFailure(
      authenticateAdminRequest({ ...CSRF, authorization: `Bearer ${token}` }, { publicKey }),
      { status: 401, code: 'token_expired', reason: 'expired' },
    );
  });

  it('401s a token signed by another key', async () => {
    const { privateKey } = await keys();
    const { publicKey } = await keys();
    const { token } = await mintLlmAdminToken({ privateKey, subject: 'user-1', jti: randomUUID() });
    await expectFailure(
      authenticateAdminRequest({ ...CSRF, authorization: `Bearer ${token}` }, { publicKey }),
      { status: 401, code: 'unauthorized', reason: 'invalid' },
    );
  });
});
