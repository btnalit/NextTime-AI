import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { Operation } from '@nexttime/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TransportInvokeError, TransportOutcomeUnknownError } from '../errors.js';
import { HttpTransport } from './http.js';
import { McpTransport } from './mcp.js';

/**
 * Legacy 287 (review of #586: #493 M3, #501 P2-2): the gate→target hop of the http and mcp
 * transports, against real loopback targets. Only a proven "not sent" and the target's own
 * verdict are plain failures; a call that may have reached the target and has no verdict is
 * "outcome unknown" (`TransportOutcomeUnknownError`, which `GatekeeperBase.apply` stores as 409
 * `apply_outcome_unknown` for its key).
 */

const httpOperation: Operation = {
  name: 'stock.adjust',
  binding: { kind: 'http', method: 'POST', path: '/stock' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: false,
  await_decision: true,
  reads: [],
  writes: [],
};

const mcpOperation: Operation = {
  ...httpOperation,
  name: 'kb.add',
  binding: { kind: 'mcp', tool_name: 'kb_add' },
};

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** A raw TCP target that reads the request and answers with `answer` as given — for answers no
 *  well-behaved HTTP server would write. */
function rawTarget(answer: string): net.Server {
  return net.createServer((socket) => {
    socket.once('data', () => {
      socket.end(answer);
    });
  });
}

async function failure(call: Promise<unknown>): Promise<Error> {
  const thrown = await call.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(thrown instanceof Error)) throw new Error('expected the call to fail');
  return thrown;
}

describe('http and mcp transports: a call that failed (legacy 287)', () => {
  let refusedPort: number;
  const servers: net.Server[] = [];
  const ports: Record<string, number> = {};

  /** Each target, by what it does once it has the whole request. */
  const targets: Record<string, net.Server> = {
    /** The target's own verdict. */
    status500: http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(500).end('{"error":"boom"}'));
    }),
    /** Announces 64 bytes of answer and closes after 6. */
    cutShort: http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
        res.write('{"ok":');
        setTimeout(() => req.socket.destroy(), 10);
      });
    }),
    /** A gzip answer whose body is not gzip. */
    badGzip: rawTarget(
      'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-encoding: gzip\r\ncontent-length: 9\r\nconnection: close\r\n\r\nnot-gzip!',
    ),
    /** Not HTTP at all after the status line. */
    malformed: rawTarget('HTTP/1.1 200 OK\r\n\u0000\u0001garbage\r\n\r\n'),
    /** A JSON-RPC server's answers. */
    rpcNotJson: http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200).end('<html>gateway</html>'));
    }),
    rpcNoResult: http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200).end('{"jsonrpc":"2.0","id":1}'));
    }),
    rpcError: http.createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        res.writeHead(200).end('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"no"}}'),
      );
    }),
    rpcGzipOk: http.createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        res
          .writeHead(200, { 'content-encoding': 'gzip' })
          .end(gzipSync('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')),
      );
    }),
  };

  beforeAll(async () => {
    const closed = net.createServer();
    refusedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    for (const [name, server] of Object.entries(targets)) {
      ports[name] = await listen(server);
      servers.push(server);
    }
  });

  afterAll(async () => {
    for (const server of servers) {
      if (server instanceof http.Server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const httpTo = (port: number) =>
    new HttpTransport({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2_000 });
  const mcpTo = (port: number) =>
    new McpTransport({ endpoint: `http://127.0.0.1:${port}/mcp`, timeoutMs: 2_000 });

  describe('http', () => {
    it('a refused connection was not sent: a plain failure', async () => {
      const err = await failure(httpTo(refusedPort).invoke(httpOperation, {}, {}));
      expect(err).toBeInstanceOf(TransportInvokeError);
      expect(err).not.toBeInstanceOf(TransportOutcomeUnknownError);
      expect(err.message).toBe(
        'http transport: POST /stock not sent — could not connect to the target (ECONNREFUSED); nothing reached it',
      );
    });

    it("the target's own non-2xx status is a plain failure", async () => {
      const err = await failure(httpTo(ports.status500 ?? 0).invoke(httpOperation, {}, {}));
      expect(err).not.toBeInstanceOf(TransportOutcomeUnknownError);
      expect(err.message).toBe('http transport: POST /stock responded 500');
    });

    it.each([
      [
        'an answer cut short',
        'cutShort',
        /answered \(status 200\) but its answer could not be read/,
      ],
      [
        'an answer that does not decompress',
        'badGzip',
        /answered \(status 200\) but its answer could not be read/,
      ],
      [
        'a malformed answer',
        'malformed',
        /failed after the request may have reached the target \(HPE_[A-Z_]+\)/,
      ],
    ])('%s is outcome unknown', async (_label, target, message) => {
      const err = await failure(httpTo(ports[target] ?? 0).invoke(httpOperation, {}, {}));
      expect(err).toBeInstanceOf(TransportOutcomeUnknownError);
      expect(err.message).toMatch(message);
      expect(err.message).not.toContain('127.0.0.1');
    });

    it('an error nobody recognises, before an answer, is outcome unknown', async () => {
      const transport = new HttpTransport({
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () => {
          throw new Error('something the classifier has never seen');
        },
      });
      const err = await failure(transport.invoke(httpOperation, {}, {}));
      expect(err).toBeInstanceOf(TransportOutcomeUnknownError);
      expect(err.message).toBe(
        'http transport: POST /stock failed after the request may have reached the target — it may have run',
      );
    });

    it('a timeout after the request was sent is outcome unknown', async () => {
      const silent = http.createServer(() => {});
      const port = await listen(silent);
      try {
        const transport = new HttpTransport({
          baseUrl: `http://127.0.0.1:${port}`,
          timeoutMs: 50,
        });
        const err = await failure(transport.invoke(httpOperation, {}, {}));
        expect(err).toBeInstanceOf(TransportOutcomeUnknownError);
      } finally {
        silent.closeAllConnections();
        await new Promise<void>((resolve) => silent.close(() => resolve()));
      }
    });
  });

  describe('mcp', () => {
    it('a refused connection was not sent: a plain failure', async () => {
      const err = await failure(mcpTo(refusedPort).invoke(mcpOperation, {}, {}));
      expect(err).not.toBeInstanceOf(TransportOutcomeUnknownError);
      expect(err.message).toContain('not sent — could not connect to the target (ECONNREFUSED)');
    });

    it("the server's own answers — a status, a JSON-RPC error — are plain failures", async () => {
      const status = await failure(mcpTo(ports.status500 ?? 0).invoke(mcpOperation, {}, {}));
      expect(status).not.toBeInstanceOf(TransportOutcomeUnknownError);
      expect(status.message).toBe('mcp transport: tools/call responded 500');
      const rpc = await failure(mcpTo(ports.rpcError ?? 0).invoke(mcpOperation, {}, {}));
      expect(rpc).not.toBeInstanceOf(TransportOutcomeUnknownError);
      expect(rpc.message).toContain('mcp transport: tools/call error:');
    });

    it.each([
      [
        'a 200 that is not JSON',
        'rpcNotJson',
        /answered \(status 200\) but its answer is not JSON/,
      ],
      [
        'a 200 with no result',
        'rpcNoResult',
        /answered \(status 200\) but its JSON-RPC response has no result/,
      ],
      ['an answer cut short', 'cutShort', /answered \(status 200\) but its answer is not JSON/],
    ])('%s is outcome unknown', async (_label, target, message) => {
      const err = await failure(mcpTo(ports[target] ?? 0).invoke(mcpOperation, {}, {}));
      expect(err).toBeInstanceOf(TransportOutcomeUnknownError);
      expect(err.message).toMatch(message);
    });

    it('still reads a well-formed answer', async () => {
      const result = await mcpTo(ports.rpcGzipOk ?? 0).invoke(mcpOperation, {}, {});
      expect(result.data).toEqual({ ok: true });
    });
  });
});
