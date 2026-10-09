import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  GateOwnedParamRefusedError,
  OperationRefusedError,
  TransportInvokeError,
} from '../errors.js';
import { mapGatekeeperError } from '../server.js';
import {
  HttpTransport,
  encodePathSegment,
  importOpenApi,
  isGateOwnedHeader,
  isGateOwnedQueryParam,
  resolveBindingUrl,
} from './http.js';

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

describe('importOpenApi — what the gate owns is never a param (review of #532)', () => {
  it('leaves out cookies, gate-owned headers and credential query params, and their required', () => {
    const [operation] = importOpenApi({
      paths: {
        '/logs': {
          get: {
            operationId: 'logs_query',
            parameters: [
              { name: 'q', in: 'query', required: true },
              { name: 'page_token', in: 'query' },
              { name: 'api_key', in: 'query', required: true },
              { name: 'Authorization', in: 'header', required: true },
              { name: 'X-Scope-OrgID', in: 'header' },
              { name: 'X-Page-Token', in: 'header' },
              { name: '$skipToken', in: 'query' },
              { name: 'session', in: 'cookie' },
            ],
          },
        },
      },
    });
    const schema = operation?.params_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'q',
      'page_token',
      'X-Page-Token',
      '$skipToken',
    ]);
    expect(schema.required).toEqual(['q']);
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

  /**
   * Legacy 175 follow-up (review of #532): an OpenAPI import marks a header parameter `x-in:
   * "header"`, and the transport sends it as a real request header. A caller-supplied param must
   * never become a header that says who is calling: refused before anything is sent, whatever
   * the value, on observe (no approval) and apply alike, and in simulate.
   */
  describe('auth headers are never caller params', () => {
    /** Synthetic — spelled out from the alphabet. */
    const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

    function withHeaderParam(header: string): Operation {
      return {
        name: 'logs.query',
        binding: { kind: 'http', method: 'GET', path: '/logs' },
        params_schema: {
          type: 'object',
          properties: {
            q: { type: 'string', 'x-in': 'query' },
            [header]: { type: 'string', 'x-in': 'header' },
          },
        },
        mode: 'observe',
        blast_radius: 'low',
        reversibility: false,
        auto_approvable: true,
        await_decision: false,
        reads: [],
        writes: [],
      };
    }

    it.each([
      'Authorization',
      'authorization',
      'AUTHORIZATION',
      'Proxy-Authorization',
      'Cookie',
      'X-API-Key',
      'x-api-key',
      'Api-Key',
      'apikey',
      'X-Auth-Token',
      'X-Auth-Email',
      'X-Access-Token',
      'PRIVATE-TOKEN',
      'X-Amz-Security-Token',
      'Ocp-Apim-Subscription-Key',
      'X-Client-Secret',
      'X-Forwarded-User',
      'X-Remote-User',
      'X-WEBAUTH-USER',
      'Impersonate-User',
      'Impersonate-Group',
      'Sudo',
      'DD-APPLICATION-KEY',
      // On whose account, under the gate's credential.
      'X-Scope-OrgID',
      'OpenAI-Organization',
      'X-Goog-User-Project',
      'X-Tenant-Id',
      'X-MS-CLIENT-PRINCIPAL-ID',
      // Where and how the call goes.
      'Host',
      'Forwarded',
      'X-Forwarded-Host',
      'X-Forwarded-For',
      'X-Original-URL',
      'X-HTTP-Method-Override',
    ])('refuses a %s header param before any request, on invoke and simulate', async (header) => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      const operation = withHeaderParam(header);
      const params = { q: 'level=error', [header]: `Basic ${FAKE}` };
      for (const call of [
        () => transport.invoke(operation, params, {}),
        () => transport.simulate(operation, params, {}),
      ]) {
        const thrown = await call().catch((err: unknown) => err);
        expect(thrown).toBeInstanceOf(GateOwnedParamRefusedError);
        expect(thrown).toBeInstanceOf(OperationRefusedError);
        expect((thrown as Error).message).toContain(`"${header}"`);
        expect((thrown as Error).message).not.toContain(FAKE);
        expect(mapGatekeeperError(thrown)).toMatchObject({
          status: 403,
          code: 'operation_refused',
        });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses the header the gate's own credential injection sets, whatever its name", async () => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      const credential = { headers: { 'X-Tenant-Signature': 'configured-on-the-gate' } };
      const thrown = await transport
        .invoke(
          withHeaderParam('x-tenant-signature'),
          { 'x-tenant-signature': 'v' },
          { credential },
        )
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(GateOwnedParamRefusedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
      'X-Page-Token',
      'X-Next-Page-Token',
      'X-Continuation-Token',
      'Idempotency-Key',
      'X-Request-Id',
      'x-trace-id',
      'Accept-Language',
    ])('sends a %s header param as before', async (header) => {
      const fetchImpl = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response('{}', { status: 200 }),
      );
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      await transport.invoke(withHeaderParam(header), { q: 'x', [header]: 'cursor-2' }, {});
      const init = fetchImpl.mock.calls[0]?.[1];
      expect((init?.headers as Record<string, string>)[header]).toBe('cursor-2');
    });

    function withQueryParams(declared: Record<string, unknown>): Operation {
      return { ...withHeaderParam('x-trace-id'), params_schema: declared };
    }

    it.each([
      ['access_token', { type: 'object', properties: { access_token: { 'x-in': 'query' } } }],
      ['api_key', { type: 'object', properties: { api_key: { 'x-in': 'query' } } }],
      ['apikey', { type: 'object', properties: { apikey: { type: 'string' } } }],
      ['client_secret', { type: 'object', properties: { client_secret: { type: 'string' } } }],
      ['sudo', { type: 'object', properties: { sudo: { type: 'string' } } }],
      // An empty params_schema accepts any param, and a GET puts it on the query string.
      ['access_token', {}],
      ['X-Amz-Security-Token', {}],
    ])('refuses a %s query param before any request', async (name, schema) => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      const thrown = await transport
        .invoke(withQueryParams(schema), { [name]: FAKE }, {})
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(GateOwnedParamRefusedError);
      expect((thrown as GateOwnedParamRefusedError).location).toBe('query');
      expect((thrown as Error).message).not.toContain(FAKE);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    /** Pagination cursors and retry keys whose names end in `token` (review of #532, round 3). */
    const PAGINATION_TOKENS = [
      'page_token',
      'pageToken',
      'startPageToken',
      'prevPageToken',
      'next_token',
      'NextToken',
      'PaginationToken',
      'pagination_token',
      'continuation-token',
      'continuationToken',
      'x-ms-continuationtoken',
      'syncToken',
      '$skipToken',
      '$skiptoken',
      'skipToken',
      '$deltatoken',
      'starting_token',
      'resumeToken',
      'resume_token',
      'after_token',
      'before_token',
      'nextForwardToken',
      'scroll_token',
      'x-nextpagetoken',
      'Idempotency-Token',
    ];

    it.each([...PAGINATION_TOKENS, 'cursor', 'key', 'q', 'limit'])(
      'sends a %s query param as before',
      async (name) => {
        const fetchImpl = vi.fn(
          async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response('{}', { status: 200 }),
        );
        const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
        await transport.invoke(withQueryParams({}), { [name]: 'cursor-2' }, {});
        const url = fetchImpl.mock.calls[0]?.[0] as URL;
        expect(url.searchParams.get(name)).toBe('cursor-2');
      },
    );

    it('refuses a cookie param and a param that would replace the binding’s own query', async () => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      const cookie: Operation = {
        ...withHeaderParam('x-trace-id'),
        params_schema: { type: 'object', properties: { session_id: { 'x-in': 'cookie' } } },
      };
      const fixed: Operation = {
        ...withHeaderParam('x-trace-id'),
        binding: { kind: 'http', method: 'GET', path: '/search?index=public' },
        params_schema: {},
      };
      for (const [operation, params, location] of [
        [cookie, { session_id: 's1' }, 'cookie'],
        [fixed, { index: 'private' }, 'binding'],
      ] as const) {
        const thrown = await transport.invoke(operation, params, {}).catch((err: unknown) => err);
        expect(thrown).toBeInstanceOf(GateOwnedParamRefusedError);
        expect((thrown as GateOwnedParamRefusedError).location).toBe(location);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('is case-insensitive and needs no credential to refuse the injection names', () => {
      expect(isGateOwnedHeader(' Authorization ')).toBe(true);
      expect(isGateOwnedHeader('X-Custom', new Set(['x-custom']))).toBe(true);
      expect(isGateOwnedHeader('x-page-token')).toBe(false);
      expect(isGateOwnedHeader('x-csrf-token')).toBe(true);
    });

    it('tells a pagination token from a credential by the word before `token`', () => {
      for (const name of PAGINATION_TOKENS) {
        expect(isGateOwnedQueryParam(name), name).toBe(false);
        expect(isGateOwnedHeader(name), name).toBe(false);
      }
      for (const name of [
        'access_token',
        'refreshToken',
        'id_token',
        'auth_token',
        'sessionToken',
        'X-Session-Token',
        'pageAccessToken',
        'nextAuthToken',
        'x-pagesessiontoken',
      ]) {
        expect(isGateOwnedQueryParam(name), name).toBe(true);
        expect(isGateOwnedHeader(name), name).toBe(true);
      }
    });

    it('compares a binding’s own query without case', async () => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      const fixed: Operation = {
        ...withHeaderParam('x-trace-id'),
        binding: { kind: 'http', method: 'GET', path: '/items?api-version=1' },
        params_schema: {},
      };
      const thrown = await transport
        .invoke(fixed, { 'API-Version': '2' }, {})
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(GateOwnedParamRefusedError);
      expect((thrown as GateOwnedParamRefusedError).location).toBe('binding');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
