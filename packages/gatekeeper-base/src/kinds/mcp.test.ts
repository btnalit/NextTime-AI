import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { TransportInvokeError } from '../errors.js';
import { McpTransport, importMcpTools } from './mcp.js';

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
