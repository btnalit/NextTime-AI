import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { HttpTransport, importOpenApi } from './http.js';

describe('importOpenApi', () => {
  const document = {
    paths: {
      '/stock': {
        get: { operationId: 'stock_list', parameters: [{ name: 'sku', in: 'query' as const }] },
        post: { operationId: 'stock_adjust' },
      },
      '/stock/{id}': {
        delete: {},
      },
    },
  };

  it('imports GET as observe and POST as execute with default blast radii by verb', () => {
    const operations = importOpenApi(document);
    const get = operations.find((op) => op.name === 'stock_list');
    const post = operations.find((op) => op.name === 'stock_adjust');
    const del = operations.find(
      (op) => op.binding.kind === 'http' && op.binding.method === 'DELETE',
    );

    expect(get?.mode).toBe('observe');
    expect(get?.blast_radius).toBe('low');
    expect(get?.auto_approvable).toBe(true);

    expect(post?.mode).toBe('execute');
    expect(post?.blast_radius).toBe('medium');
    expect(post?.auto_approvable).toBe(false);
    expect(post?.await_decision).toBe(true);

    expect(del?.mode).toBe('execute');
    expect(del?.blast_radius).toBe('high');
  });
});

describe('HttpTransport', () => {
  const observeOperation: Operation = {
    name: 'stock.get',
    binding: { kind: 'http', method: 'GET', path: '/stock/{id}' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  };

  it('substitutes path params and puts the rest on the query string for GET', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ qty: 3 }), { status: 200 }),
    );
    const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });

    const result = await transport.invoke(observeOperation, { id: 'X1', verbose: 'true' }, {});

    expect(result.data).toEqual({ qty: 3 });
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url] = call as NonNullable<typeof call>;
    expect(url.toString()).toBe('https://example.test/stock/X1?verbose=true');
  });

  it('throws TransportInvokeError on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
    await expect(transport.invoke(observeOperation, { id: 'X1' }, {})).rejects.toThrow(
      /responded 500/,
    );
  });

  it('simulate describes the resolved request without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
    const result = await transport.simulate?.(observeOperation, { id: 'X1' }, {});
    expect(result?.description).toContain('GET');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
