import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
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
});
