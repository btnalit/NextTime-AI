import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
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
    ['a TLS protocol error', sysError('ERR_SSL_WRONG_VERSION_NUMBER')],
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
