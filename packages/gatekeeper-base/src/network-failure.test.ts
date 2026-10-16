import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TransportInvokeError } from './errors.js';
import { networkFailureCode, networkFailureDelivery } from './network-failure.js';

/**
 * Legacy 287: `networkFailureDelivery` against the errors Node's own `fetch` really throws — real
 * sockets on loopback, no fakes — so the line between "nothing was sent" and "it may have been
 * delivered" follows the runtime, not a guess at its error shapes. The shapes the loopback cannot
 * produce deterministically (a name that does not resolve, a certificate the handshake refuses,
 * happy-eyeballs' aggregate) are Node's documented `code` / `syscall` values.
 */

async function fetchError(url: string, init: RequestInit = {}): Promise<unknown> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: '{"op":"x"}',
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    await response.text();
  } catch (err) {
    return err;
  }
  throw new Error(`expected ${url} to fail`);
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

describe('networkFailureDelivery (real sockets)', () => {
  let refusedPort: number;
  /** Reads the whole request, then drops the connection without answering. */
  const dropAfterRequest = http.createServer((req) => {
    req.resume();
    req.on('end', () => req.socket.destroy());
  });
  /** Sends the status line and part of the body, then drops the connection. */
  const dropMidAnswer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
      res.write('{"ok":');
      setTimeout(() => req.socket.destroy(), 10);
    });
  });
  /** Never answers. */
  const silent = http.createServer(() => {});
  let dropAfterRequestPort: number;
  let dropMidAnswerPort: number;
  let silentPort: number;

  beforeAll(async () => {
    const closed = net.createServer();
    refusedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    dropAfterRequestPort = await listen(dropAfterRequest);
    dropMidAnswerPort = await listen(dropMidAnswer);
    silentPort = await listen(silent);
  });

  afterAll(async () => {
    silent.closeAllConnections();
    for (const server of [dropAfterRequest, dropMidAnswer, silent]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a refused connection was not sent', async () => {
    const err = await fetchError(`http://127.0.0.1:${refusedPort}/gate/apply`);
    expect(networkFailureDelivery(err)).toBe('not_sent');
    expect(networkFailureCode(err)).toBe('ECONNREFUSED');
  });

  it('a connection dropped after the request was read may have been delivered', async () => {
    const err = await fetchError(`http://127.0.0.1:${dropAfterRequestPort}/gate/apply`);
    expect(networkFailureDelivery(err)).toBe('maybe_delivered');
    expect(networkFailureCode(err)).toBe('UND_ERR_SOCKET');
  });

  it('a connection dropped while the answer was read may have been delivered', async () => {
    const err = await fetchError(`http://127.0.0.1:${dropMidAnswerPort}/gate/apply`);
    expect(networkFailureDelivery(err)).toBe('maybe_delivered');
  });

  it('a caller that stopped waiting may have been delivered', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const aborted = await fetchError(`http://127.0.0.1:${silentPort}/gate/apply`, {
      signal: controller.signal,
    });
    expect(networkFailureDelivery(aborted)).toBe('maybe_delivered');
    const timedOut = await fetchError(`http://127.0.0.1:${silentPort}/gate/apply`, {
      signal: AbortSignal.timeout(50),
    });
    expect(networkFailureDelivery(timedOut)).toBe('maybe_delivered');
    expect(networkFailureCode(timedOut)).toBeUndefined();
  });

  it('reads the cause a transport wrapped it in', async () => {
    const err = await fetchError(`http://127.0.0.1:${refusedPort}/x`);
    const wrapped = new TransportInvokeError('http transport: request failed', { cause: err });
    expect(networkFailureDelivery(wrapped)).toBe('not_sent');
  });
});

describe('networkFailureDelivery (Node error shapes)', () => {
  const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });
  const sysError = (code: string, syscall?: string) =>
    Object.assign(new Error(`${syscall ?? ''} ${code}`), { code, syscall });

  it.each([
    ['a name that does not resolve', sysError('ENOTFOUND', 'getaddrinfo')],
    ['a resolver that is down', sysError('EAI_AGAIN', 'getaddrinfo')],
    [
      "undici's connect timeout",
      Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    ],
    ['an unreachable host while connecting', sysError('EHOSTUNREACH', 'connect')],
    ['a connect that timed out', sysError('ETIMEDOUT', 'connect')],
    ['a certificate the handshake refused', sysError('DEPTH_ZERO_SELF_SIGNED_CERT')],
    ['an expired certificate', sysError('CERT_HAS_EXPIRED')],
    ['a host name the certificate does not cover', sysError('ERR_TLS_CERT_ALTNAME_INVALID')],
    ['a handshake that timed out', sysError('ERR_TLS_HANDSHAKE_TIMEOUT')],
    ['no shared protocol version', sysError('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION')],
    ["the server's handshake failure", sysError('ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE')],
    [
      'a server that wants a client certificate',
      sysError('ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'),
    ],
  ])('%s was not sent', (_label, cause) => {
    expect(networkFailureDelivery(fetchFailed(cause))).toBe('not_sent');
  });

  it("happy eyeballs' aggregate of refused connects was not sent", () => {
    const aggregate = Object.assign(
      new AggregateError([
        sysError('ECONNREFUSED', 'connect'),
        sysError('ECONNREFUSED', 'connect'),
      ]),
      { code: 'ECONNREFUSED' },
    );
    expect(networkFailureDelivery(fetchFailed(aggregate))).toBe('not_sent');
  });

  it.each([
    ['a reset on an open socket', sysError('ECONNRESET', 'read')],
    ['a broken pipe', sysError('EPIPE', 'write')],
    ['an open socket that timed out', sysError('ETIMEDOUT', 'read')],
    ['a host that became unreachable mid-call', sysError('EHOSTUNREACH', 'read')],
    ['a TLS socket closed before the handshake (no syscall to tell)', sysError('ECONNRESET')],
    ["undici's header timeout", Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' })],
    // Legacy 287 review (#493 M2, #501 P2-1): TLS errors outside the handshake allow-list.
    ['a bad record MAC', sysError('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC')],
    ["the peer's bad record MAC alert", sysError('ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC')],
    ['a renegotiation attack', sysError('ERR_TLS_SESSION_ATTACK')],
    ['a refused renegotiation', sysError('ERR_TLS_RENEGOTIATION_DISABLED')],
    // The record layer's checks: raised by a peer that does not speak TLS, and by plain text
    // written into an established session. Which one a given OpenSSL raises differs by version.
    ['a record too long to be TLS', sysError('ERR_SSL_PACKET_LENGTH_TOO_LONG')],
    ['a record that is not TLS', sysError('ERR_SSL_WRONG_VERSION_NUMBER')],
    // #501 P2-2: undici's answer-side errors.
    ['a malformed answer', sysError('HPE_INVALID_CONSTANT')],
    ['an answer that does not decompress', sysError('Z_DATA_ERROR')],
    ['an answer over the size limit', sysError('UND_ERR_RESPONSE_EXCEEDED_MAX_SIZE')],
    ['a request body shorter than announced', sysError('UND_ERR_REQ_CONTENT_LENGTH_MISMATCH')],
  ])('%s may have been delivered', (_label, cause) => {
    expect(networkFailureDelivery(fetchFailed(cause))).toBe('maybe_delivered');
  });

  it('a doubt anywhere in the chain wins over a refusal', () => {
    const mixed = Object.assign(new Error('x'), {
      code: 'ECONNRESET',
      cause: sysError('ECONNREFUSED', 'connect'),
    });
    expect(networkFailureDelivery(mixed)).toBe('maybe_delivered');
  });

  it.each([
    ["a target's own answer", new TransportInvokeError('http transport: POST /x responded 500')],
    ['a body that is not JSON', new SyntaxError('Unexpected token < in JSON')],
    ['an exit code', Object.assign(new Error('Command failed'), { code: 1 })],
    ['a missing binary', sysError('ENOENT', 'spawn ssh')],
    ['not an error at all', 'boom'],
    ['nothing', undefined],
  ])('%s carries no network signal', (_label, err) => {
    expect(networkFailureDelivery(err)).toBeUndefined();
  });

  it('stops at a cause cycle', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(networkFailureDelivery(a)).toBeUndefined();
  });

  it('repeats only a code, never an address or a message', () => {
    expect(networkFailureCode(fetchFailed(sysError('ECONNREFUSED', 'connect')))).toBe(
      'ECONNREFUSED',
    );
    expect(networkFailureCode(Object.assign(new Error('x'), { code: '192.0.2.1:22' }))).toBe(
      undefined,
    );
    expect(networkFailureCode(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBeUndefined();
  });
});

/** A throwaway self-signed certificate for the real-handshake cases, made by the `openssl` CLI at
 *  test time (never a key in the repository); the cases are skipped where it is missing. */
function selfSignedCertificate(): { key: string; cert: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'nt-tls-'));
  try {
    const made = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    if (made.status !== 0) return undefined;
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const certificate = selfSignedCertificate();

describe.skipIf(certificate === undefined)('networkFailureDelivery (real TLS handshakes)', () => {
  const tlsServer = https.createServer(certificate ?? {}, (req, res) => {
    req.resume();
    req.on('end', () => res.end('{}'));
  });
  const plainServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end('{}'));
  });
  let tlsPort: number;
  let plainPort: number;

  beforeAll(async () => {
    tlsPort = await listen(tlsServer);
    plainPort = await listen(plainServer);
  });

  afterAll(async () => {
    for (const server of [tlsServer, plainServer]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a certificate the client refuses was not sent', async () => {
    const err = await fetchError(`https://127.0.0.1:${tlsPort}/gate/apply`);
    expect(networkFailureCode(err)).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(networkFailureDelivery(err)).toBe('not_sent');
  });

  // The code differs by OpenSSL version (`ERR_SSL_PACKET_LENGTH_TOO_LONG` with 3.5,
  // `ERR_SSL_WRONG_VERSION_NUMBER` with others): neither is handshake-only.
  it('TLS spoken to a plain HTTP port reads as maybe delivered — its code is not handshake-only', async () => {
    const err = await fetchError(`https://127.0.0.1:${plainPort}/gate/apply`);
    expect(networkFailureCode(err)).toMatch(/^ERR_SSL_/);
    expect(networkFailureDelivery(err)).toBe('maybe_delivered');
  });
});
