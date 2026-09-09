import type { Operation } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import { RagflowTransport } from './transport.js';

/**
 * `RagflowTransport` unit tests (S3.4) — no real network: `document.upload` calls are captured via
 * an injected `fetchImpl`; every other Operation is exercised through the same fake to confirm
 * delegation to the wrapped `HttpTransport` still produces a plain JSON request (unchanged from
 * before this file existed).
 */

const BASE_URL = 'https://ragflow.example.invalid';

const uploadOperation: Operation = {
  name: 'document.upload',
  binding: { kind: 'http', method: 'POST', path: '/api/v1/datasets/{dataset_id}/documents' },
  params_schema: { type: 'object' },
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: false,
  await_decision: true,
  reads: [],
  writes: ['Document'],
};

const parseOperation: Operation = {
  name: 'document.parse',
  binding: { kind: 'http', method: 'POST', path: '/api/v1/datasets/{dataset_id}/chunks' },
  params_schema: { type: 'object' },
  mode: 'execute',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: true,
  reads: ['Document'],
  writes: ['Document'],
};

const kbListOperation: Operation = {
  name: 'kb.list',
  binding: { kind: 'http', method: 'GET', path: '/api/v1/datasets' },
  params_schema: { type: 'object' },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: ['KnowledgeBase'],
  writes: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RagflowTransport', () => {
  describe('document.upload (multipart)', () => {
    it('sends a real multipart/form-data POST with the decoded content as the file body', async () => {
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        const file = form.get('file');
        expect(file).toBeInstanceOf(Blob);
        expect(await (file as Blob).text()).toBe('hello world');
        expect((file as File).name).toBe('note.txt');
        expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' });
        return jsonResponse({
          code: 0,
          data: [{ id: 'doc1', name: 'note.txt', dataset_id: 'ds1', size: 11, run: 'UNSTART' }],
        });
      });
      const transport = new RagflowTransport({ baseUrl: BASE_URL, fetchImpl: fetchImpl as never });

      const result = await transport.invoke(
        uploadOperation,
        { dataset_id: 'ds1', name: 'note.txt', content: 'hello world' },
        { credential: { token: 'test-token' } },
      );

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl] = fetchImpl.mock.calls[0] as [URL, RequestInit];
      expect(calledUrl.toString()).toBe(`${BASE_URL}/api/v1/datasets/ds1/documents?type=local`);
      expect(result.data).toEqual({
        code: 0,
        data: [{ id: 'doc1', name: 'note.txt', dataset_id: 'ds1', size: 11, run: 'UNSTART' }],
      });
    });

    it('decodes base64 content into raw bytes', async () => {
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const form = init?.body as FormData;
        const file = form.get('file') as Blob;
        expect(await file.text()).toBe('hi');
        return jsonResponse({ code: 0, data: [] });
      });
      const transport = new RagflowTransport({ baseUrl: BASE_URL, fetchImpl: fetchImpl as never });

      await transport.invoke(
        uploadOperation,
        {
          dataset_id: 'ds1',
          name: 'note.txt',
          content: Buffer.from('hi', 'utf8').toString('base64'),
          encoding: 'base64',
        },
        {},
      );
    });

    it('throws on an unrecognized encoding without ever calling fetch', async () => {
      const fetchImpl = vi.fn();
      const transport = new RagflowTransport({ baseUrl: BASE_URL, fetchImpl: fetchImpl as never });

      await expect(
        transport.invoke(
          uploadOperation,
          { dataset_id: 'ds1', name: 'note.txt', content: 'x', encoding: 'gzip' },
          {},
        ),
      ).rejects.toThrow(/encoding/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('throws when a required param is missing', async () => {
      const transport = new RagflowTransport({ baseUrl: BASE_URL });
      await expect(
        transport.invoke(uploadOperation, { dataset_id: 'ds1', content: 'x' }, {}),
      ).rejects.toThrow(/"name"/);
    });

    it('wraps a non-2xx response as TransportInvokeError', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ code: 102, message: 'nope' }, 500));
      const transport = new RagflowTransport({ baseUrl: BASE_URL, fetchImpl: fetchImpl as never });

      await expect(
        transport.invoke(
          uploadOperation,
          { dataset_id: 'ds1', name: 'note.txt', content: 'x' },
          {},
        ),
      ).rejects.toThrow(/responded 500/);
    });

    it('simulate describes the upload without calling fetch (no side effects)', async () => {
      const fetchImpl = vi.fn();
      const transport = new RagflowTransport({ baseUrl: BASE_URL, fetchImpl: fetchImpl as never });

      const result = await transport.simulate(
        uploadOperation,
        { dataset_id: 'ds1', name: 'note.txt', content: 'hello' },
        {},
      );

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.description).toContain('would upload document "note.txt"');
      expect(result.description).toContain('dataset "ds1"');
      expect(result.detail).toMatchObject({ datasetId: 'ds1', name: 'note.txt', sizeBytes: 5 });
    });
  });

  describe('every other Operation delegates to HttpTransport unchanged', () => {
    it('document.parse invoke sends a plain JSON POST (no FormData)', async () => {
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(init?.body).not.toBeInstanceOf(FormData);
        expect(typeof init?.body).toBe('string');
        return jsonResponse({ code: 0 });
      });
      const transport = new RagflowTransport({ baseUrl: BASE_URL, fetchImpl: fetchImpl as never });

      const result = await transport.invoke(
        parseOperation,
        { dataset_id: 'ds1', document_ids: ['doc1'] },
        {},
      );
      expect(result.data).toEqual({ code: 0 });
    });

    it('document.parse simulate describes the call without calling fetch', async () => {
      const fetchImpl = vi.fn();
      const transport = new RagflowTransport({ baseUrl: BASE_URL, fetchImpl: fetchImpl as never });

      const result = await transport.simulate(
        parseOperation,
        { dataset_id: 'ds1', document_ids: ['doc1'] },
        {},
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.description).toContain('would call POST');
    });

    it('kb.list invoke sends a plain GET', async () => {
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(init?.method).toBe('GET');
        return jsonResponse({ code: 0, data: [] });
      });
      const transport = new RagflowTransport({ baseUrl: BASE_URL, fetchImpl: fetchImpl as never });

      await transport.invoke(kbListOperation, {}, {});
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
