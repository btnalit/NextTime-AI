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

  it('keeps each parameter\'s own "in" on its params_schema property (review lane 5, P2-4)', () => {
    const operations = importOpenApi(document);
    const get = operations.find((op) => op.name === 'stock_list');
    const schema = get?.params_schema as { properties?: Record<string, { 'x-in'?: string }> };
    expect(schema.properties?.sku?.['x-in']).toBe('query');
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

  it('sets redirect:"error" so credential headers never follow a cross-origin redirect (review lane 5, P2-2)', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ qty: 1 }), { status: 200 }),
    );
    const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
    await transport.invoke(observeOperation, { id: 'X1' }, {});
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as NonNullable<typeof call>;
    expect(init?.redirect).toBe('error');
  });

  describe('param "in" routing (review lane 5, P2-4)', () => {
    const postOperation: Operation = {
      name: 'stock.adjust',
      binding: { kind: 'http', method: 'POST', path: '/stock' },
      params_schema: {
        type: 'object',
        properties: {
          qty: { type: 'integer' },
          filter: { type: 'string', 'x-in': 'query' },
          'x-trace-id': { type: 'string', 'x-in': 'header' },
        },
      },
      mode: 'execute',
      blast_radius: 'medium',
      reversibility: false,
      auto_approvable: false,
      await_decision: true,
      reads: [],
      writes: [],
    };

    it('routes an x-in:"query" param to the query string even on a POST', async () => {
      const fetchImpl = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response('{}', { status: 200 }),
      );
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      await transport.invoke(postOperation, { qty: 5, filter: 'active', 'x-trace-id': 't1' }, {});

      const call = fetchImpl.mock.calls[0];
      expect(call).toBeDefined();
      const [url, init] = call as NonNullable<typeof call>;
      expect((url as URL).searchParams.get('filter')).toBe('active');
      expect(JSON.parse((init?.body ?? '{}') as string)).toEqual({ qty: 5 });
      expect((init?.headers as Record<string, string>)['x-trace-id']).toBe('t1');
    });

    it('simulate exposes headerParams without executing', async () => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      const result = await transport.simulate?.(
        postOperation,
        { qty: 5, filter: 'active', 'x-trace-id': 't1' },
        {},
      );
      expect(result?.detail).toMatchObject({ headerParams: { 'x-trace-id': 't1' } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
