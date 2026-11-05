import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HttpTransport, importOpenApi } from './http.js';

/**
 * S11 AA5c: the accept_s2 ticket system's own OpenAPI document
 * (`deploy/accept-s2/openapi-fixture/tickets-openapi.json`, served by the openapi fixture at
 * `/tickets/openapi.json`). The admin agent journey (`scripts/lib/accept-s2-admin-agent-tickets.sh`,
 * the AA5 plan's §5.8) connects it in a trial workspace and expects exactly these Operations: two
 * reads that need no approval and one write that waits for a person. If the document drifts, this
 * fails here, not halfway through a journey on the staging host.
 */
const DOCUMENT_PATH = fileURLToPath(
  new URL('../../../../deploy/accept-s2/openapi-fixture/tickets-openapi.json', import.meta.url),
);
const document = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8'));

describe('accept_s2 ticket system OpenAPI document (S11 AA5c)', () => {
  const operations = importOpenApi(document);
  const byName = new Map(operations.map((op) => [op.name, op]));

  it('imports three Operations named by their operationId', () => {
    expect([...byName.keys()].sort()).toEqual(['tickets.create', 'tickets.get', 'tickets.list']);
  });

  it('reads are observe and need no approval; opening a ticket is execute and waits for a decision', () => {
    for (const name of ['tickets.list', 'tickets.get']) {
      const op = byName.get(name);
      expect(op?.mode).toBe('observe');
      expect(op?.auto_approvable).toBe(true);
      expect(op?.await_decision).toBe(false);
    }
    const create = byName.get('tickets.create');
    expect(create?.mode).toBe('execute');
    expect(create?.auto_approvable).toBe(false);
    expect(create?.await_decision).toBe(true);
    expect(create?.binding).toEqual({ kind: 'http', method: 'POST', path: '/tickets' });
  });

  it("tickets.create's params are the request body's fields, title required", () => {
    const schema = byName.get('tickets.create')?.params_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['priority', 'title']);
    expect(schema.required).toEqual(['title']);
  });

  it("tickets.get's id is its path parameter", async () => {
    const op = byName.get('tickets.get');
    expect(op?.binding).toEqual({ kind: 'http', method: 'GET', path: '/tickets/{id}' });
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{}', { status: 200 }),
    );
    const transport = new HttpTransport({ baseUrl: 'http://accept-s2-openapi:8080', fetchImpl });
    if (!op) throw new Error('tickets.get missing');
    await transport.invoke(op, { id: 'T-1001' }, {});
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://accept-s2-openapi:8080/tickets/T-1001');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('tickets.create sends title and priority as the JSON body', async () => {
    const op = byName.get('tickets.create');
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"T-1003"}', { status: 201 }),
    );
    const transport = new HttpTransport({ baseUrl: 'http://accept-s2-openapi:8080', fetchImpl });
    if (!op) throw new Error('tickets.create missing');
    const result = await transport.invoke(
      op,
      { title: 'Printer on floor 3 is offline', priority: 'high' },
      {},
    );
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://accept-s2-openapi:8080/tickets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Printer on floor 3 is offline',
      priority: 'high',
    });
    expect(result.data).toEqual({ id: 'T-1003' });
  });
});
