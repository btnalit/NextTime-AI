import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { TransportInvokeError, TransportOutcomeUnknownError } from '../errors.js';
import { MAX_MCP_TOOLS_LIST_BYTES, McpTransport, importMcpTools } from './mcp.js';

describe('importMcpTools', () => {
  it('maps readOnlyHint tools to observe and the rest to execute', () => {
    const operations = importMcpTools({
      tools: [
        { name: 'kb.list', annotations: { readOnlyHint: true } },
        { name: 'document.upload' },
      ],
    });
    const list = operations.find((op) => op.name === 'kb.list');
    const upload = operations.find((op) => op.name === 'document.upload');

    expect(list?.mode).toBe('observe');
    expect(list?.auto_approvable).toBe(true);
    expect(upload?.mode).toBe('execute');
    expect(upload?.auto_approvable).toBe(false);
    expect(upload?.await_decision).toBe(true);
  });

  it("S8 W2-K1 (CO1/B3): description comes from the tool's own description, falling back to its name — never blank", () => {
    const operations = importMcpTools({
      tools: [
        {
          name: 'kb.list',
          description: 'List knowledge bases',
          annotations: { readOnlyHint: true },
        },
        { name: 'document.upload' },
      ],
    });
    const list = operations.find((op) => op.name === 'kb.list');
    const upload = operations.find((op) => op.name === 'document.upload');
    expect(list?.description).toBe('List knowledge bases');
    expect(upload?.description).toBe('document.upload');
  });
});

const READ_ONLY_TOOL = { name: 'kb_list', annotations: { readOnlyHint: true } };

describe('McpTransport', () => {
  const operation: Operation = {
    name: 'kb.list',
    binding: { kind: 'mcp', tool_name: 'kb_list' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  };

  it('calls tools/call over JSON-RPC and returns the result', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body ?? '{}') as string);
      expect(body.method).toBe('tools/call');
      expect(body.params).toEqual({ name: 'kb_list', arguments: { q: 'x' } });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { items: [] } }), {
        status: 200,
      });
    });
    const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl });
    const result = await transport.invoke(operation, { q: 'x' }, {});
    expect(result.data).toEqual({ items: [] });
  });

  it('never follows a redirect with the credential header (as http.ts, review lane 5 P2-2)', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      const body = JSON.parse((init?.body ?? '{}') as string);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
        status: 200,
      });
    });
    const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl });
    await transport.invoke(operation, {}, { credential: { token: 'configured-on-the-gate' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    // Starlette / FastMCP mounted at `/mcp` (review of #532, item 4).
    ['/mcp/', 307, '"/mcp/"'],
    // Another origin: its origin and path, never the query (a login redirect's can carry a token).
    [
      'https://login.example.test/authorize?code=abc&token=t0k3n#x',
      302,
      '"https://login.example.test/authorize"',
    ],
  ])(
    'says where a redirect to %s pointed instead of "request failed", and does not follow it',
    async (location, status, shown) => {
      const fetchImpl = vi.fn(async () => new Response('moved', { status, headers: { location } }));
      const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl });
      const thrown = await transport.listTools().catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(TransportInvokeError);
      const message = (thrown as Error).message;
      expect(message).toContain(
        `mcp transport: tools/list responded ${status}, a redirect to ${shown}`,
      );
      expect(message).toContain('set the target URL to the final address');
      expect(message).not.toContain('t0k3n');
      expect(message).not.toContain('code=');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('names a redirect with no Location header', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 308 }));
    const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl });
    const thrown = await transport.listTools().catch((err: unknown) => err);
    expect((thrown as Error).message).toContain('responded 308, a redirect to nowhere');
  });

  it('surfaces a JSON-RPC error as TransportInvokeError', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'bad' } }),
          {
            status: 200,
          },
        ),
    );
    const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl });
    await expect(transport.invoke(operation, {}, {})).rejects.toThrow(/bad/);
  });

  it('surfaces a tool-level isError:true result as TransportInvokeError (review lane 5, P2-3)', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body ?? '{}') as string);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { isError: true, content: [{ type: 'text', text: 'tool exploded' }] },
        }),
        { status: 200 },
      );
    });
    const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl });
    await expect(transport.invoke(operation, {}, {})).rejects.toThrow(/tool exploded/);
    await expect(transport.invoke(operation, {}, {})).rejects.toBeInstanceOf(TransportInvokeError);
  });

  it('bounds an unreasonably large isError text to 2KB and marks it untrusted', async () => {
    const hugeText = 'x'.repeat(10_000);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body ?? '{}') as string);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { isError: true, content: [{ type: 'text', text: hugeText }] },
        }),
        { status: 200 },
      );
    });
    const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl });
    let message = '';
    try {
      await transport.invoke(operation, {}, {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('untrusted:');
    expect(message.length).toBeLessThan(hugeText.length);
  });

  // Legacy 961: as http.ts. FAKE values only.
  describe("the answer leaves without this gate's own credential (legacy 961)", () => {
    const TOKEN = 'FAKE-gate-token-0123/abc+def=';
    const credential = { token: TOKEN };
    const answering = (answer: (id: unknown) => unknown) =>
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse((init?.body ?? '{}') as string);
        return new Response(JSON.stringify(answer(request.id)), { status: 200 });
      });

    it('masks a result that echoes the request, and logs only the count', async () => {
      const log = vi.fn();
      const fetchImpl = answering((id) => ({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `authorization: Bearer ${TOKEN}` }],
          [encodeURIComponent(TOKEN)]: true,
        },
      }));
      const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl, log });
      const result = await transport.invoke(operation, {}, { credential });
      expect(result.data).toEqual({
        content: [{ type: 'text', text: 'authorization: [redacted]' }],
        '[redacted]': true,
      });
      expect(log.mock.calls).toEqual([
        [
          "mcp transport: tools/call: the target's answer held this gate's own credential 2 times; masked before the answer left the gate (legacy 961)",
        ],
      ]);
    });

    it('masks a JSON-RPC error message before it is cut to 2 KB, so no part of the token is left', async () => {
      // The token straddles the 2 KB cut: cut first, then masked, its first half would stay.
      const message = `${'x'.repeat(2048 - 10)}${TOKEN} and more`;
      const fetchImpl = answering((id) => ({ jsonrpc: '2.0', id, error: { code: -1, message } }));
      const transport = new McpTransport({
        endpoint: 'https://example.test/mcp',
        fetchImpl,
        log: () => {},
      });
      const thrown = await transport
        .invoke(operation, {}, { credential })
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(TransportInvokeError);
      expect((thrown as Error).message).toContain('[redacted]');
      expect((thrown as Error).message).not.toContain('FAKE-gate');
    });

    it('masks an isError result text, and a tools/list answer', async () => {
      const transport = new McpTransport({
        endpoint: 'https://example.test/mcp',
        fetchImpl: answering((id) => ({
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: `bad token ${TOKEN}` }] },
        })),
        log: () => {},
      });
      const thrown = await transport
        .invoke(operation, {}, { credential })
        .catch((err: unknown) => err);
      expect((thrown as Error).message).toContain('bad token [redacted]');
      expect((thrown as Error).message).not.toContain('FAKE-gate');

      const listing = new McpTransport({
        endpoint: 'https://example.test/mcp',
        fetchImpl: answering((id) => ({
          jsonrpc: '2.0',
          id,
          result: { tools: [{ name: 'kb_list', description: `uses ${TOKEN}` }] },
        })),
        log: () => {},
      });
      const tools = await listing.listTools(credential);
      expect(tools.tools[0]?.description).toBe('uses [redacted]');
    });

    it('masks it where a redirect pointed', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response('', {
            status: 307,
            headers: { location: `https://login.example.test/t/${TOKEN}` },
          }),
      );
      const transport = new McpTransport({
        endpoint: 'https://example.test/mcp',
        fetchImpl,
        log: () => {},
      });
      const thrown = await transport.listTools(credential).catch((err: unknown) => err);
      expect((thrown as Error).message).toContain(
        'a redirect to "https://login.example.test/t/[redacted]"',
      );
    });

    it('leaves the answer as it was without a credential', async () => {
      const log = vi.fn();
      const transport = new McpTransport({
        endpoint: 'https://example.test/mcp',
        fetchImpl: answering((id) => ({ jsonrpc: '2.0', id, result: { echo: TOKEN } })),
        log,
      });
      const result = await transport.invoke(operation, {}, {});
      expect(result.data).toEqual({ echo: TOKEN });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('legacy 797 (#501 review of #1374): a tools/list answer is read up to 16 MiB', () => {
    /** An answer that sends `chunk` on every read, for as long as it is read. */
    function endless(chunk: Uint8Array, headers: Record<string, string> = {}) {
      const state = { pulls: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            state.pulls += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return { response: new Response(body, { status: 200, headers }), state };
    }
    const tooLarge =
      'mcp transport: tools/list: the target answered (status 200) but its answer is larger than 16 MiB — it had the request and may have run it';

    it('an answer that passes the limit is cut off, cancelled and fails as outcome unknown', async () => {
      expect(MAX_MCP_TOOLS_LIST_BYTES).toBe(16 * 1024 * 1024);
      const { response, state } = endless(new Uint8Array(1024 * 1024).fill(0x20));
      const transport = new McpTransport({
        endpoint: 'https://example.test/mcp',
        fetchImpl: vi.fn(async () => response),
      });
      const thrown = await transport.listTools().catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(TransportOutcomeUnknownError);
      expect((thrown as Error).message).toBe(tooLarge);
      expect(state.cancelled).toBe(true);
      expect(state.pulls).toBeLessThan(20);
    });

    it('one that declares a larger length is not read at all', async () => {
      const { response, state } = endless(new Uint8Array(1024), {
        'content-length': String(MAX_MCP_TOOLS_LIST_BYTES + 1),
      });
      const transport = new McpTransport({
        endpoint: 'https://example.test/mcp',
        fetchImpl: vi.fn(async () => response),
      });
      await expect(transport.listTools()).rejects.toThrow(tooLarge);
      expect(state.cancelled).toBe(true);
      expect(state.pulls).toBe(0);
    });

    it('an answer within it reads as before, a leading UTF-8 BOM included', async () => {
      const json = new TextEncoder().encode(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [READ_ONLY_TOOL] } }),
      );
      const answers = [json, new Uint8Array([0xef, 0xbb, 0xbf, ...json])];
      for (const answer of answers) {
        const transport = new McpTransport({
          endpoint: 'https://example.test/mcp',
          fetchImpl: vi.fn(async () => new Response(answer, { status: 200 })),
        });
        await expect(transport.listTools()).resolves.toEqual({ tools: [READ_ONLY_TOOL] });
      }
    });

    it('an answer that is not JSON fails as before', async () => {
      const transport = new McpTransport({
        endpoint: 'https://example.test/mcp',
        fetchImpl: vi.fn(async () => new Response('<html>', { status: 200 })),
      });
      const thrown = await transport.listTools().catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(TransportOutcomeUnknownError);
      expect((thrown as Error).message).toContain(
        'mcp transport: tools/list: the target answered (status 200) but its answer is not JSON',
      );
    });
  });

  it('does not treat a normal (isError absent) result as an error', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { items: [] } }), {
          status: 200,
        }),
    );
    const transport = new McpTransport({ endpoint: 'https://example.test/mcp', fetchImpl });
    await expect(transport.invoke(operation, {}, {})).resolves.toEqual({
      data: { items: [] },
    });
  });
});
