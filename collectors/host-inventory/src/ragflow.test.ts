import { describe, expect, it, vi } from 'vitest';
import type {
  KernelClient,
  ObserveOperationParams,
  ObserveOperationResult,
} from './kernel-client.js';
import { KernelClientError } from './kernel-client.js';
import {
  RagflowReadError,
  buildRagflowObservations,
  collectRagflowObservations,
} from './ragflow.js';

function fakeKernelClient(
  observeOperation: (params: ObserveOperationParams) => Promise<ObserveOperationResult>,
): KernelClient {
  return {
    registerSource: vi.fn(),
    submitObservations: vi.fn(),
    observeOperation,
  } as unknown as KernelClient;
}

describe('buildRagflowObservations (pure)', () => {
  it('builds a KnowledgeBase (served_by Gatekeeper) and its Documents (part_of KnowledgeBase)', () => {
    const observations = buildRagflowObservations({
      gatekeeperId: 'gk-1',
      knowledgeBases: [
        {
          kb: {
            id: 'ds1',
            name: 'kb-1',
            chunk_count: 10,
            document_count: 2,
            embedding_model: 'BAAI/bge-m3',
            chunk_method: 'naive',
          },
          documents: [
            { id: 'doc1', name: 'a.pdf', size: 100, run: 'DONE', chunk_count: 5 },
            { id: 'doc2', name: 'b.pdf', size: 200, run: 'UNSTART', chunk_count: 0 },
          ],
        },
      ],
    });

    expect(observations).toEqual([
      {
        objectType: 'KnowledgeBase',
        identity: { gatekeeperId: 'gk-1', kbId: 'ds1' },
        properties: {
          name: 'kb-1',
          chunkCount: 10,
          documentCount: 2,
          embeddingModel: 'BAAI/bge-m3',
          chunkMethod: 'naive',
        },
        links: [
          {
            linkType: 'served_by',
            target: { objectType: 'Gatekeeper', identity: { gatekeeperId: 'gk-1' } },
          },
        ],
      },
      {
        objectType: 'Document',
        identity: { gatekeeperId: 'gk-1', kbId: 'ds1', documentId: 'doc1' },
        properties: { name: 'a.pdf', size: 100, run: 'DONE', chunkCount: 5 },
        links: [
          {
            linkType: 'part_of',
            target: {
              objectType: 'KnowledgeBase',
              identity: { gatekeeperId: 'gk-1', kbId: 'ds1' },
            },
          },
        ],
      },
      {
        objectType: 'Document',
        identity: { gatekeeperId: 'gk-1', kbId: 'ds1', documentId: 'doc2' },
        properties: { name: 'b.pdf', size: 200, run: 'UNSTART', chunkCount: 0 },
        links: [
          {
            linkType: 'part_of',
            target: {
              objectType: 'KnowledgeBase',
              identity: { gatekeeperId: 'gk-1', kbId: 'ds1' },
            },
          },
        ],
      },
    ]);
  });

  it('skips a KnowledgeBase with no id, and a Document with no id', () => {
    const observations = buildRagflowObservations({
      gatekeeperId: 'gk-1',
      knowledgeBases: [
        { kb: { id: '' }, documents: [] },
        { kb: { id: 'ds1' }, documents: [{ id: '' }, { id: 'doc1' }] },
      ],
    });

    expect(observations.map((o) => o.objectType)).toEqual(['KnowledgeBase', 'Document']);
    expect(observations[1]?.identity).toEqual({
      gatekeeperId: 'gk-1',
      kbId: 'ds1',
      documentId: 'doc1',
    });
  });

  it('produces no observations for an empty knowledgeBases list', () => {
    expect(buildRagflowObservations({ gatekeeperId: 'gk-1', knowledgeBases: [] })).toEqual([]);
  });
});

type FakeItem = { readonly id: string; readonly name?: string };

interface FakeRagflow {
  kbs: FakeItem[];
  docs: Record<string, FakeItem[]>;
  /** Items per page the fake actually answers, whatever `page_size` asked for (RAGFlow's own
   *  server answers 10 per page for any `page_size` above 100). Default: honour `page_size`. */
  effectivePageSize?: number;
  /** Report totals (`total_datasets` top level for datasets, `data.total` for documents). */
  reportTotals?: boolean;
  /** Return a raw RAGFlow body for this call instead of the listing (e.g. an error envelope). */
  override?: (params: ObserveOperationParams) => unknown;
}

/** A fake RAGFlow behind `observe_operation` with real 1-based paging. */
function pagedRagflow(
  state: FakeRagflow,
): (params: ObserveOperationParams) => Promise<ObserveOperationResult> {
  return async (params) => {
    const overridden = state.override?.(params);
    if (overridden !== undefined) return { status: 'ok', data: overridden, observedFactCount: 0 };
    const page = Number(params.params?.page ?? 1);
    const size = state.effectivePageSize ?? Number(params.params?.page_size ?? 30);
    const slice = (all: FakeItem[]) => all.slice((page - 1) * size, page * size);
    const totals = state.reportTotals ?? true;
    if (params.operation === 'kb.list') {
      return {
        status: 'ok',
        data: {
          code: 0,
          data: slice(state.kbs),
          ...(totals ? { total_datasets: state.kbs.length } : {}),
        },
        observedFactCount: 0,
      };
    }
    const docs = state.docs[String(params.params?.dataset_id)] ?? [];
    return {
      status: 'ok',
      data: { code: 0, data: { docs: slice(docs), ...(totals ? { total: docs.length } : {}) } },
      observedFactCount: 0,
    };
  };
}

function docsNamed(prefix: string, count: number): FakeItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}` }));
}

describe('collectRagflowObservations (orchestration, fake kernel client)', () => {
  it('reads every page of kb.list and of each KnowledgeBase, page_size 100', async () => {
    const calls: ObserveOperationParams[] = [];
    const fake = pagedRagflow({
      kbs: [
        { id: 'ds1', name: 'kb-1' },
        { id: 'ds2', name: 'kb-2' },
      ],
      docs: { ds1: docsNamed('doc', 250) },
    });
    const kernelClient = fakeKernelClient(async (params) => {
      calls.push(params);
      return fake(params);
    });

    const observations = await collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' });

    expect(calls).toEqual([
      { gatekeeperId: 'gk-1', operation: 'kb.list', params: { page: 1, page_size: 100 } },
      ...[1, 2, 3].map((page) => ({
        gatekeeperId: 'gk-1',
        operation: 'kb.documents',
        params: { dataset_id: 'ds1', page, page_size: 100 },
      })),
      // ds2 reports total 0: its first, empty page ends it.
      {
        gatekeeperId: 'gk-1',
        operation: 'kb.documents',
        params: { dataset_id: 'ds2', page: 1, page_size: 100 },
      },
    ]);
    expect(observations.filter((o) => o.objectType === 'KnowledgeBase')).toHaveLength(2);
    const documents = observations.filter((o) => o.objectType === 'Document');
    expect(documents).toHaveLength(250);
    expect(new Set(documents.map((d) => d.identity.documentId)).size).toBe(250);
  });

  it('a server answering fewer items per page than asked is still read to the end (never "a short page = the last page")', async () => {
    const calls: ObserveOperationParams[] = [];
    const fake = pagedRagflow({
      kbs: [{ id: 'ds1' }],
      docs: { ds1: docsNamed('doc', 25) },
      effectivePageSize: 10,
    });
    const kernelClient = fakeKernelClient(async (params) => {
      calls.push(params);
      return fake(params);
    });

    const observations = await collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' });

    expect(calls.filter((c) => c.operation === 'kb.documents')).toHaveLength(3);
    expect(observations.filter((o) => o.objectType === 'Document')).toHaveLength(25);
  });

  it('without a reported total, reads until an empty page', async () => {
    const calls: ObserveOperationParams[] = [];
    const fake = pagedRagflow({
      kbs: [{ id: 'ds1' }],
      docs: { ds1: docsNamed('doc', 150) },
      reportTotals: false,
    });
    const kernelClient = fakeKernelClient(async (params) => {
      calls.push(params);
      return fake(params);
    });

    const observations = await collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' });

    expect(calls.map((c) => `${c.operation}:${c.params?.page}`)).toEqual([
      'kb.list:1',
      'kb.list:2',
      'kb.documents:1',
      'kb.documents:2',
      'kb.documents:3',
    ]);
    expect(observations.filter((o) => o.objectType === 'Document')).toHaveLength(150);
  });

  it('a non-zero RAGFlow code from kb.list (an error in a 200 body) throws — never "no KnowledgeBases"', async () => {
    const kernelClient = fakeKernelClient(async () => ({
      status: 'ok',
      data: { code: 109, message: 'Authentication error: API key is invalid!' },
      observedFactCount: 0,
    }));

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toThrow(RagflowReadError);
    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toThrow(/kb\.list: RAGFlow answered code 109/);
  });

  it('a failed page of one KnowledgeBase fails the whole collection — no partial result', async () => {
    const kernelClient = fakeKernelClient(
      pagedRagflow({
        kbs: [{ id: 'ds1' }, { id: 'ds2' }],
        docs: { ds1: docsNamed('doc', 150), ds2: docsNamed('other', 2) },
        override: (p) =>
          p.operation === 'kb.documents' && p.params?.dataset_id === 'ds1' && p.params?.page === 2
            ? { code: 102, message: 'internal error' }
            : undefined,
      }),
    );

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toThrow(/kb\.documents ds1: RAGFlow answered code 102/);
  });

  it('a kb.documents call that throws propagates — no longer "that KnowledgeBase, zero Documents"', async () => {
    const kernelClient = fakeKernelClient(async (params) => {
      if (params.operation === 'kb.list') {
        return {
          status: 'ok',
          data: { code: 0, data: [{ id: 'ds1', name: 'kb-1' }], total_datasets: 1 },
          observedFactCount: 1,
        };
      }
      throw new KernelClientError('observe_operation', 500, 'internal_error', 'gate unreachable');
    });

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toMatchObject({ name: 'KernelClientError', code: 'internal_error' });
  });

  it('propagates a kb.list failure to the caller (run.ts decides whether that is fatal)', async () => {
    const kernelClient = fakeKernelClient(async () => {
      throw new KernelClientError('observe_operation', 401, 'unauthorized', 'bad token');
    });

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toMatchObject({ name: 'KernelClientError', code: 'unauthorized' });
  });

  it.each([
    ['a body that is not a RAGFlow envelope', { data: [] }],
    ['kb.list data that is not a list', { code: 0, data: { docs: [] } }],
    ['an item without an id', { code: 0, data: [{ name: 'no id' }] }],
  ])('throws on %s', async (_label, body) => {
    const kernelClient = fakeKernelClient(async () => ({
      status: 'ok',
      data: body,
      observedFactCount: 0,
    }));

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toThrow(RagflowReadError);
  });

  it('throws when kb.documents has no docs list', async () => {
    const kernelClient = fakeKernelClient(
      pagedRagflow({
        kbs: [{ id: 'ds1' }],
        docs: {},
        override: (p) => (p.operation === 'kb.documents' ? { code: 0, data: {} } : undefined),
      }),
    );

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toThrow(/data\.docs/);
  });

  it('throws when the listing changes while it is being read (the total moves between pages)', async () => {
    const state: FakeRagflow = { kbs: [{ id: 'ds1' }], docs: { ds1: docsNamed('doc', 150) } };
    const fake = pagedRagflow(state);
    const kernelClient = fakeKernelClient(async (params) => {
      // A Document is deleted after page 1 was read: every later item shifts one place up, so
      // page 2 would silently skip one.
      if (params.operation === 'kb.documents' && params.params?.page === 2) {
        state.docs.ds1 = (state.docs.ds1 ?? []).filter((d) => d.id !== 'doc-3');
      }
      return fake(params);
    });

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toThrow(/changed while it was being read/);
  });

  it('throws when fewer distinct items were read than the listing reports', async () => {
    const kernelClient = fakeKernelClient(
      pagedRagflow({
        kbs: [{ id: 'ds1' }],
        docs: { ds1: docsNamed('doc', 5) },
        override: (p) =>
          p.operation === 'kb.documents'
            ? { code: 0, data: { docs: p.params?.page === 1 ? docsNamed('doc', 5) : [], total: 7 } }
            : undefined,
      }),
    );

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toThrow(/read 5 items, the listing reports 7/);
  });

  it('throws when the server ignores `page` (every page repeats the first)', async () => {
    const kernelClient = fakeKernelClient(async (params) =>
      params.operation === 'kb.list'
        ? { status: 'ok', data: { code: 0, data: [{ id: 'ds1' }] }, observedFactCount: 0 }
        : { status: 'ok', data: { code: 0, data: { docs: [] } }, observedFactCount: 0 },
    );

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1' }),
    ).rejects.toThrow(/paging not honoured/);
  });
});
