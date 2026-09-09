import { describe, expect, it, vi } from 'vitest';
import type {
  KernelClient,
  ObserveOperationParams,
  ObserveOperationResult,
} from './kernel-client.js';
import { KernelClientError } from './kernel-client.js';
import { buildRagflowObservations, collectRagflowObservations } from './ragflow.js';

function fakeKernelClient(
  observeOperation: (params: ObserveOperationParams) => Promise<ObserveOperationResult>,
): KernelClient {
  return {
    registerSource: vi.fn(),
    submitObservations: vi.fn(),
    observeOperation,
  } as unknown as KernelClient;
}

function fakeLogger() {
  return { warn: vi.fn() };
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

describe('collectRagflowObservations (orchestration, fake kernel client)', () => {
  it('calls kb.list then kb.documents per KnowledgeBase, and returns the built observations', async () => {
    const calls: ObserveOperationParams[] = [];
    const kernelClient = fakeKernelClient(async (params) => {
      calls.push(params);
      if (params.operation === 'kb.list') {
        return {
          status: 'ok',
          data: {
            code: 0,
            data: [
              { id: 'ds1', name: 'kb-1' },
              { id: 'ds2', name: 'kb-2' },
            ],
          },
          observedFactCount: 2,
        };
      }
      if (params.operation === 'kb.documents' && params.params?.dataset_id === 'ds1') {
        return {
          status: 'ok',
          data: { code: 0, data: { docs: [{ id: 'doc1', name: 'a.pdf' }] } },
          observedFactCount: 1,
        };
      }
      return { status: 'ok', data: { code: 0, data: { docs: [] } }, observedFactCount: 0 };
    });

    const observations = await collectRagflowObservations({
      kernelClient,
      gatekeeperId: 'gk-1',
      logger: fakeLogger(),
    });

    expect(calls).toEqual([
      { gatekeeperId: 'gk-1', operation: 'kb.list', params: { page_size: 1000 } },
      {
        gatekeeperId: 'gk-1',
        operation: 'kb.documents',
        params: { dataset_id: 'ds1', page_size: 1000 },
      },
      {
        gatekeeperId: 'gk-1',
        operation: 'kb.documents',
        params: { dataset_id: 'ds2', page_size: 1000 },
      },
    ]);
    expect(observations.filter((o) => o.objectType === 'KnowledgeBase')).toHaveLength(2);
    expect(observations.filter((o) => o.objectType === 'Document')).toHaveLength(1);
  });

  it('treats a non-zero RAGFlow code from kb.list as "nothing observed", logs a warning, does not throw', async () => {
    const logger = fakeLogger();
    const kernelClient = fakeKernelClient(async () => ({
      status: 'ok',
      data: { code: 102, message: 'dataset not found' },
      observedFactCount: 0,
    }));

    const observations = await collectRagflowObservations({
      kernelClient,
      gatekeeperId: 'gk-1',
      logger,
    });

    expect(observations).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('non-zero RAGFlow code'),
      expect.objectContaining({ operation: 'kb.list', code: 102 }),
    );
  });

  it('degrades a single KnowledgeBase to zero Documents when its kb.documents call throws, without failing the whole call', async () => {
    const logger = fakeLogger();
    const kernelClient = fakeKernelClient(async (params) => {
      if (params.operation === 'kb.list') {
        return {
          status: 'ok',
          data: { code: 0, data: [{ id: 'ds1', name: 'kb-1' }] },
          observedFactCount: 1,
        };
      }
      throw new KernelClientError('observe_operation', 500, 'internal_error', 'gate unreachable');
    });

    const observations = await collectRagflowObservations({
      kernelClient,
      gatekeeperId: 'gk-1',
      logger,
    });

    expect(observations).toEqual([
      {
        objectType: 'KnowledgeBase',
        identity: { gatekeeperId: 'gk-1', kbId: 'ds1' },
        properties: {
          name: 'kb-1',
          chunkCount: undefined,
          documentCount: undefined,
          embeddingModel: undefined,
          chunkMethod: undefined,
        },
        links: [
          {
            linkType: 'served_by',
            target: { objectType: 'Gatekeeper', identity: { gatekeeperId: 'gk-1' } },
          },
        ],
      },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('kb.documents failed'),
      expect.objectContaining({ kbId: 'ds1' }),
    );
  });

  it('propagates a kb.list failure to the caller (run.ts decides whether that is fatal)', async () => {
    const kernelClient = fakeKernelClient(async () => {
      throw new KernelClientError('observe_operation', 401, 'unauthorized', 'bad token');
    });

    await expect(
      collectRagflowObservations({ kernelClient, gatekeeperId: 'gk-1', logger: fakeLogger() }),
    ).rejects.toMatchObject({ name: 'KernelClientError', code: 'unauthorized' });
  });
});
