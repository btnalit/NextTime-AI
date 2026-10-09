import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { TransportInvokeError } from '../errors.js';
import { HttpTransport, encodePathSegment, importOpenApi, resolveBindingUrl } from './http.js';

describe('importOpenApi', () => {
  const document = {
    paths: {
      '/stock': {
        get: {
          operationId: 'stock_list',
          summary: 'List stock items',
          parameters: [{ name: 'sku', in: 'query' as const }],
        },
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

  it('S8 W2-K1 (CO1/B3): description prefers summary, then description, then a synthesized fallback — never blank', () => {
    const operations = importOpenApi(document);
    const get = operations.find((op) => op.name === 'stock_list');
    const post = operations.find((op) => op.name === 'stock_adjust');
    const del = operations.find(
      (op) => op.binding.kind === 'http' && op.binding.method === 'DELETE',
    );
    expect(get?.description).toBe('List stock items');
    expect(post?.description).toBe('POST /stock');
    expect(del?.description).toBe('DELETE /stock/{id}');
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

  // R-22 (review 2026-10-02): a path parameter can never climb out of its template.
  describe('path parameters stay one segment (R-22)', () => {
    const documentsOperation: Operation = {
      ...observeOperation,
      name: 'kb.documents',
      binding: { kind: 'http', method: 'GET', path: '/api/v1/datasets/{dataset_id}/documents' },
    };
    const parseOperation: Operation = {
      ...observeOperation,
      name: 'document.parse',
      mode: 'execute',
      binding: { kind: 'http', method: 'POST', path: '/api/v1/datasets/{dataset_id}/chunks' },
    };

    it.each([
      ['..'],
      ['.'],
      [''],
      ['%2e%2e'],
      ['%2E%2E'],
      ['.%2e'],
      ['%252e%252e'],
      ['a/../b'],
      ['a%2F..%2Fb'],
      ['a%252Fb'],
      ['..\\windows'],
      ['%5c'],
    ])('refuses %j before any request is made', async (value) => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://ragflow.test', fetchImpl });
      await expect(
        transport.invoke(documentsOperation, { dataset_id: value }, {}),
      ).rejects.toBeInstanceOf(TransportInvokeError);
      await expect(
        transport.invoke(parseOperation, { dataset_id: value, document_ids: ['d1'] }, {}),
      ).rejects.toThrow(/single path segment|is required/);
      await expect(
        transport.simulate?.(documentsOperation, { dataset_id: value }, {}),
      ).rejects.toThrow(/path parameter "dataset_id"/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a missing path parameter instead of rendering an empty segment', async () => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://ragflow.test', fetchImpl });
      await expect(transport.invoke(documentsOperation, {}, {})).rejects.toThrow(/is required/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('still encodes an ordinary value as one segment (dots inside a name are fine)', async () => {
      const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
      const transport = new HttpTransport({ baseUrl: 'https://ragflow.test', fetchImpl });
      await transport.invoke(documentsOperation, { dataset_id: 'kb v1.2...final' }, {});
      const [url] = fetchImpl.mock.calls[0] as unknown as [URL];
      expect(url.toString()).toBe(
        'https://ragflow.test/api/v1/datasets/kb%20v1.2...final/documents',
      );
    });

    it('keeps the base URL path prefix for an absolute binding path', async () => {
      const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
      const transport = new HttpTransport({ baseUrl: 'https://host.test/ragflow/', fetchImpl });
      await transport.invoke(documentsOperation, { dataset_id: 'ds1' }, {});
      const [url] = fetchImpl.mock.calls[0] as unknown as [URL];
      expect(url.toString()).toBe('https://host.test/ragflow/api/v1/datasets/ds1/documents');
    });

    it('a leading empty segment can never change the host', async () => {
      const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
      const transport = new HttpTransport({ baseUrl: 'https://host.test', fetchImpl });
      const tenantOperation: Operation = {
        ...observeOperation,
        binding: { kind: 'http', method: 'GET', path: '/{tenant}/items' },
      };
      await expect(transport.invoke(tenantOperation, { tenant: '' }, {})).rejects.toThrow(
        TransportInvokeError,
      );
      // A template that itself starts with "//" stays on the configured host.
      const odd: Operation = {
        ...observeOperation,
        binding: { kind: 'http', method: 'GET', path: '//elsewhere.test/items' },
      };
      await transport.invoke(odd, {}, {});
      const [url] = fetchImpl.mock.calls[0] as unknown as [URL];
      expect(url.host).toBe('host.test');
    });
  });

  describe('encodePathSegment / resolveBindingUrl', () => {
    it('encodePathSegment encodes a plain value and refuses dot segments in any encoding', () => {
      expect(encodePathSegment('id', 'a b')).toBe('a%20b');
      expect(encodePathSegment('id', 42)).toBe('42');
      expect(() => encodePathSegment('id', '..')).toThrow(TransportInvokeError);
      expect(() => encodePathSegment('id', '%2e%2e')).toThrow(TransportInvokeError);
      expect(() => encodePathSegment('id', 'a/../b')).toThrow(TransportInvokeError);
      expect(() => encodePathSegment('id', undefined)).toThrow(/is required/);
    });

    it('resolveBindingUrl joins base path and binding path and keeps a query in the binding', () => {
      expect(resolveBindingUrl('https://h.test', '/a/b').toString()).toBe('https://h.test/a/b');
      expect(resolveBindingUrl('https://h.test/base', '/a').toString()).toBe(
        'https://h.test/base/a',
      );
      expect(resolveBindingUrl('https://h.test/base/', 'a?type=local').toString()).toBe(
        'https://h.test/base/a?type=local',
      );
      expect(resolveBindingUrl('https://h.test/base///', '/a').toString()).toBe(
        'https://h.test/base/a',
      );
    });

    it('a binding path or base URL shaped to backtrack is handled in linear time', async () => {
      const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
      const transport = new HttpTransport({
        baseUrl: `https://host.test/${'/'.repeat(200_000)}x`,
        fetchImpl,
      });
      const braces: Operation = {
        ...observeOperation,
        binding: { kind: 'http', method: 'GET', path: `/${'{'.repeat(200_000)}` },
      };
      const started = performance.now();
      await transport.invoke(braces, {}, {});
      expect(performance.now() - started).toBeLessThan(1_000);
    });
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
