import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  GateOwnedParamRefusedError,
  OperationRefusedError,
  ParamsSchemaInvalidError,
  ParamsValidationError,
  TransportInvokeError,
} from '../errors.js';
import { assertParamsValid } from '../params-validation.js';
import { mapGatekeeperError } from '../server.js';
import {
  HttpTransport,
  type OpenApiDocumentLike,
  encodePathSegment,
  gateOwnedParamsOf,
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

/**
 * Legacy 197 (#532 review N): `importOpenApi` read neither a path item's own `parameters` nor any
 * `$ref`, so a `$ref` request body added nothing and an Operation with no other parameter got
 * `params_schema: {}`, which accepts anything.
 */
describe('importOpenApi — path item parameters and $ref (legacy 197)', () => {
  type Schema = {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const schemaOf = (operations: Operation[], name: string): Schema =>
    operations.find((op) => op.name === name)?.params_schema as Schema;

  const components = {
    parameters: {
      Limit: { name: 'limit', in: 'query', schema: { $ref: '#/components/schemas/Limit' } },
      LimitAgain: { $ref: '#/components/parameters/Limit' },
    },
    requestBodies: {
      NewPet: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } },
      },
    },
    schemas: {
      Limit: { type: 'integer', minimum: 1, maximum: 100 },
      Tag: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      NewPet: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
          // A property may be called `default`: it is a schema, written out like any other.
          default: { $ref: '#/components/schemas/Tag' },
        },
        required: ['name'],
        example: { tags: [{ $ref: '#/components/schemas/Tag' }] },
      },
      'a/b~c': { type: 'string', maxLength: 3 },
    },
  };

  it("takes the path item's parameters on every method; an Operation's own one of the same name and place replaces it", () => {
    const operations = importOpenApi({
      paths: {
        '/pets/{petId}': {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'X-Request-Id', in: 'header', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          ],
          get: {
            operationId: 'pet_get',
            parameters: [
              // Replaces the path item's: its own schema, and no longer required.
              { name: 'X-Request-Id', in: 'header', schema: { format: 'uuid' } },
              { name: 'fields', in: 'query' },
            ],
          },
          delete: { operationId: 'pet_delete' },
        },
      },
    });
    expect(schemaOf(operations, 'pet_get')).toEqual({
      type: 'object',
      properties: {
        petId: { type: 'string', 'x-in': 'path' },
        verbose: { type: 'boolean', 'x-in': 'query' },
        'X-Request-Id': { format: 'uuid', 'x-in': 'header' },
        fields: { 'x-in': 'query' },
      },
      required: ['petId'],
    });
    expect(schemaOf(operations, 'pet_delete')).toEqual({
      type: 'object',
      properties: {
        petId: { type: 'string', 'x-in': 'path' },
        'X-Request-Id': { type: 'string', 'x-in': 'header' },
        verbose: { type: 'boolean', 'x-in': 'query' },
      },
      required: ['petId', 'X-Request-Id'],
    });
  });

  it("leaves a path item's gate-owned parameters out, as an Operation's own", () => {
    const [operation] = importOpenApi({
      paths: {
        '/logs': {
          parameters: [
            { name: 'Authorization', in: 'header', required: true },
            { name: 'api_key', in: 'query', required: true },
            { name: 'session', in: 'cookie' },
            { name: 'q', in: 'query' },
          ],
          get: { operationId: 'logs_query' },
        },
      },
    });
    expect(operation?.params_schema).toEqual({
      type: 'object',
      properties: { q: { 'x-in': 'query' } },
    });
  });

  it('follows $ref to parameters, request bodies and schemas in the same document', () => {
    const operations = importOpenApi({
      components,
      paths: {
        '/pets': {
          get: {
            operationId: 'pets_list',
            parameters: [{ $ref: '#/components/parameters/LimitAgain' }],
          },
          post: {
            operationId: 'pet_create',
            requestBody: { $ref: '#/components/requestBodies/NewPet' },
          },
        },
      },
    });
    expect(schemaOf(operations, 'pets_list')).toEqual({
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, 'x-in': 'query' } },
    });
    const tag = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
    expect(schemaOf(operations, 'pet_create')).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        tags: { type: 'array', items: tag },
        default: tag,
      },
      required: ['name'],
    });
    // The gate's own validator has no document to resolve a `$ref` against: what it gets compiles
    // and holds the call to the document's schema.
    const create = operations.find((op) => op.name === 'pet_create');
    const schema = create?.params_schema ?? {};
    expect(() =>
      assertParamsValid('pet_create', schema, { name: 'rex', tags: [{ label: 'a' }] }),
    ).not.toThrow();
    expect(() => assertParamsValid('pet_create', schema, { name: 'rex', tags: [{}] })).toThrow(
      ParamsValidationError,
    );
    expect(() => assertParamsValid('pet_create', schema, { name: 'rex', owner: 'x' })).toThrow(
      ParamsValidationError,
    );
    expect(() =>
      assertParamsValid('pets_list', schemaOf(operations, 'pets_list'), { limit: 0 }),
    ).toThrow(ParamsValidationError);
  });

  it("copies a value that is data as it is: an example's `$ref` is not followed", () => {
    const [operation] = importOpenApi({
      components,
      paths: {
        '/pets': {
          post: {
            operationId: 'pet_create',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { nick: { $ref: '#/components/schemas/NewPet' } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const nick = (operation?.params_schema as Schema).properties?.nick;
    expect(nick?.example).toEqual({ tags: [{ $ref: '#/components/schemas/Tag' }] });
  });

  it('reads RFC 6901 escapes in a pointer, and only names the document has', () => {
    const operations = importOpenApi({
      components,
      paths: {
        '/a': {
          get: {
            operationId: 'escaped',
            parameters: [
              { name: 'v', in: 'query', schema: { $ref: '#/components/schemas/a~1b~0c' } },
            ],
          },
          post: {
            operationId: 'inherited',
            parameters: [{ $ref: '#/components/parameters/constructor' }],
          },
        },
      },
    });
    expect(schemaOf(operations, 'escaped').properties?.v).toEqual({
      type: 'string',
      maxLength: 3,
      'x-in': 'query',
    });
    // `constructor` is on every object's prototype, not a parameter the document declares.
    expect(schemaOf(operations, 'inherited')).toEqual({ type: 'object', properties: {} });
  });

  it('a parameter or property called `__proto__` stays a property, not the prototype', () => {
    const [operation] = importOpenApi(
      JSON.parse(`{
        "paths": { "/odd": { "post": {
          "operationId": "odd",
          "parameters": [{ "name": "__proto__", "in": "query", "schema": { "type": "string" } }],
          "requestBody": { "content": { "application/json": { "schema": {
            "type": "object",
            "properties": { "nested": { "type": "object", "properties": {
              "__proto__": { "type": "integer" } } } }
          } } } }
        } } }
      }`) as OpenApiDocumentLike,
    );
    const properties = (operation?.params_schema as Schema).properties ?? {};
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.keys(properties)).toEqual(['__proto__', 'nested']);
    const nested = properties.nested?.properties as Record<string, unknown>;
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(Object.keys(nested)).toEqual(['__proto__']);
  });

  it('writes a schema that contains itself out once along each path, `{}` where it recurs', () => {
    const [operation] = importOpenApi({
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
            },
          },
        },
      },
      paths: {
        '/tree': {
          put: {
            operationId: 'tree_put',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
            },
          },
        },
      },
    });
    expect(operation?.params_schema).toEqual({
      type: 'object',
      properties: {
        label: { type: 'string' },
        children: { type: 'array', items: {} },
      },
    });
  });

  it('a parameter or body it cannot read leaves a schema that takes only what it could read, never `{}`', () => {
    const operations = importOpenApi({
      components,
      paths: {
        '/elsewhere': {
          post: {
            operationId: 'body_in_another_document',
            requestBody: {
              content: { 'application/json': { schema: { $ref: 'pets.yaml#/Pet' } } },
            },
          },
          put: {
            operationId: 'request_body_missing',
            parameters: [{ name: 'dryRun', in: 'query', schema: { type: 'boolean' } }],
            requestBody: { $ref: '#/components/requestBodies/Gone' },
          },
          patch: {
            operationId: 'only_request_body_missing',
            requestBody: { $ref: '#/components/requestBodies/Gone' },
          },
          get: {
            operationId: 'parameter_missing',
            parameters: [{ $ref: '#/components/parameters/Gone' }],
          },
        },
      },
    });
    expect(schemaOf(operations, 'body_in_another_document')).toEqual({
      type: 'object',
      properties: {},
    });
    expect(schemaOf(operations, 'request_body_missing')).toEqual({
      type: 'object',
      properties: { dryRun: { type: 'boolean', 'x-in': 'query' } },
    });
    expect(schemaOf(operations, 'only_request_body_missing')).toEqual({
      type: 'object',
      properties: {},
    });
    expect(schemaOf(operations, 'parameter_missing')).toEqual({ type: 'object', properties: {} });
    for (const op of operations) {
      expect(() => assertParamsValid(op.name, op.params_schema, { anything: 1 })).toThrow(
        ParamsValidationError,
      );
      expect(() => assertParamsValid(op.name, op.params_schema, {})).not.toThrow();
    }
  });

  it('references that fan out stop being written out past a bound: the schema does not compile, so calls are refused', () => {
    // L0 uses L1 twice, L1 uses L2 twice, … — written out in full this is 2^40 objects.
    const schemas: Record<string, unknown> = { L40: { type: 'string' } };
    for (let level = 0; level < 40; level += 1) {
      const next = { $ref: `#/components/schemas/L${level + 1}` };
      schemas[`L${level}`] = { type: 'object', properties: { a: next, b: next } };
    }
    const started = Date.now();
    const [operation] = importOpenApi({
      components: { schemas },
      paths: {
        '/fan': {
          post: {
            operationId: 'fan_out',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/L0' } } },
            },
          },
        },
      },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    const schema = operation?.params_schema ?? {};
    expect(JSON.stringify(schema)).toContain('"$ref"');
    expect(() => assertParamsValid('fan_out', schema, { a: {} })).toThrow(ParamsSchemaInvalidError);
  });

  it('a document with no path item parameters and no $ref imports exactly as before', () => {
    const [operation] = importOpenApi({
      paths: {
        '/stock/{id}': {
          patch: {
            operationId: 'stock_patch',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'note', in: 'header' },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { qty: { type: 'integer', default: 0 } },
                    required: ['qty'],
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(operation?.params_schema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', 'x-in': 'path' },
        note: { 'x-in': 'header' },
        qty: { type: 'integer', default: 0 },
      },
      required: ['id', 'qty'],
    });
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

  it('never lets fetch follow a redirect, so credential headers never follow one (review lane 5, P2-2)', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ qty: 1 }), { status: 200 }),
    );
    const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
    await transport.invoke(observeOperation, { id: 'X1' }, {});
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as NonNullable<typeof call>;
    expect(init?.redirect).toBe('manual');
  });

  it('fails a redirect with its status and target path, not "request failed" (review of #532, item 4)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', { status: 301, headers: { location: '/v2/stock/X1?sig=s3cr3t' } }),
    );
    const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
    const thrown = await transport
      .invoke(observeOperation, { id: 'X1' }, { credential: { token: 'configured-on-the-gate' } })
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(TransportInvokeError);
    expect((thrown as Error).message).toContain('responded 301, a redirect to "/v2/stock/X1"');
    expect((thrown as Error).message).not.toContain('s3cr3t');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats 304 as a response, not a redirect', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
    const thrown = await transport
      .invoke(observeOperation, { id: 'X1' }, {})
      .catch((err: unknown) => err);
    expect((thrown as Error).message).toContain('responded 304');
    expect((thrown as Error).message).not.toContain('redirect');
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
      // Review of #532, item 5.
      'es-security-runas-user',
      'X-Run-As',
      'run_as_user',
      'X-Hasura-Role',
      'X-Hasura-User-Id',
      'x-functions-key',
      'x-jwt-assertion',
      'X-Goog-IAP-JWT-Assertion',
      'X-Forwarded-Email',
      'X-Forwarded-Groups',
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

    it('routes a hand-written `x-in` without case, so `Header` meets the header guard', async () => {
      const fetchImpl = vi.fn();
      const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
      const operation: Operation = {
        ...withHeaderParam('x-trace-id'),
        params_schema: {
          type: 'object',
          properties: { Authorization: { type: 'string', 'x-in': 'Header' } },
        },
      };
      const thrown = await transport
        .invoke(operation, { Authorization: `Basic ${FAKE}` }, {})
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(GateOwnedParamRefusedError);
      expect((thrown as GateOwnedParamRefusedError).location).toBe('header');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
      'X-Scope-OrgID',
      'x-scope-orgid',
      'Authorization',
      'OpenAI-Organization',
      'X-Tenant-Id',
      'Impersonate-User',
      'X-Forwarded-User',
      'X-Hasura-Role',
      'run_as',
      'jwt',
      'sudo',
    ])(
      'refuses an undeclared GET param named like the %s identity header (review of #532, item 3)',
      async (name) => {
        const fetchImpl = vi.fn();
        const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
        const undeclared: Operation = { ...withHeaderParam('x-trace-id'), params_schema: {} };
        const thrown = await transport
          .invoke(undeclared, { [name]: 'tenant-a' }, {})
          .catch((err: unknown) => err);
        expect(thrown).toBeInstanceOf(GateOwnedParamRefusedError);
        expect((thrown as GateOwnedParamRefusedError).location).toBe('query');
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );

    it.each(['host', 'Host', 'forwarded', 'X-Forwarded-For', 'x-forwarded-host', 'tenant_id'])(
      'sends an undeclared GET param named %s to the query string: routing names are filters there',
      async (name) => {
        const fetchImpl = vi.fn(
          async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response('{}', { status: 200 }),
        );
        const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
        const undeclared: Operation = { ...withHeaderParam('x-trace-id'), params_schema: {} };
        await transport.invoke(undeclared, { [name]: 'web-1' }, {});
        const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
        expect(url.searchParams.get(name)).toBe('web-1');
      },
    );

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

describe('gateOwnedParamsOf (legacy J)', () => {
  function op(
    method: string,
    path: string,
    properties: Record<string, Record<string, unknown>>,
  ): Operation {
    return {
      name: 'items.call',
      binding: { kind: 'http', method, path },
      params_schema: { type: 'object', properties },
      mode: method === 'GET' ? 'observe' : 'execute',
      blast_radius: 'low',
      reversibility: false,
      auto_approvable: true,
      await_decision: false,
      reads: [],
      writes: [],
    };
  }

  const GET_ITEMS = op('GET', '/items/{token}?api-version=2024-01-01', {
    token: { type: 'string', 'x-in': 'path' },
    Authorization: { type: 'string', 'x-in': 'Header' },
    'X-Request-Id': { type: 'string', 'x-in': 'header' },
    access_token: { type: 'string', 'x-in': 'query' },
    page_token: { type: 'string', 'x-in': 'query' },
    session: { type: 'string', 'x-in': 'cookie' },
    'API-Version': { type: 'string', 'x-in': 'query' },
    api_key: { type: 'string' },
    q: { type: 'string' },
  });
  const POST_ITEMS = op('POST', '/items', {
    password: { type: 'string' },
    'X-Tenant-Id': { type: 'string', 'x-in': 'header' },
    pageToken: { type: 'string', 'x-in': 'query' },
    sig: { type: 'string', 'x-in': 'query' },
  });

  it('names every declared param the transport refuses, and where', () => {
    // Sorted by name (code point order), whatever the declaration order.
    expect(gateOwnedParamsOf(GET_ITEMS)).toEqual([
      { param: 'API-Version', location: 'binding' },
      { param: 'Authorization', location: 'header' },
      { param: 'access_token', location: 'query' },
      // Undeclared location on a GET: the query string.
      { param: 'api_key', location: 'query' },
      { param: 'session', location: 'cookie' },
    ]);
    // A POST's unlocated param is body, not query: `password` there is the target's own field.
    expect(gateOwnedParamsOf(POST_ITEMS)).toEqual([
      { param: 'X-Tenant-Id', location: 'header' },
      { param: 'sig', location: 'query' },
    ]);
  });

  it('agrees with the call: a declared param is reported exactly when invoke refuses it', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const transport = new HttpTransport({ baseUrl: 'https://example.test', fetchImpl });
    for (const operation of [GET_ITEMS, POST_ITEMS]) {
      const reported = new Set(gateOwnedParamsOf(operation).map((entry) => entry.param));
      const properties = (operation.params_schema as { properties: Record<string, unknown> })
        .properties;
      for (const name of Object.keys(properties)) {
        const params = { token: 't1', [name]: 'v' };
        const thrown = await transport.invoke(operation, params, {}).catch((err: unknown) => err);
        expect([name, thrown instanceof GateOwnedParamRefusedError]).toEqual([
          name,
          reported.has(name),
        ]);
      }
    }
  });

  it('is empty for another binding kind, and for a definition without properties', () => {
    expect(
      gateOwnedParamsOf({
        ...GET_ITEMS,
        binding: { kind: 'mcp', tool_name: 'items' },
      }),
    ).toEqual([]);
    expect(gateOwnedParamsOf({ ...GET_ITEMS, params_schema: {} })).toEqual([]);
    expect(gateOwnedParamsOf(null)).toEqual([]);
    expect(gateOwnedParamsOf({ binding: { kind: 'http' } })).toEqual([]);
  });
});
