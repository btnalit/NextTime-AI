import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyResultMapping } from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';

/**
 * Maps sample RAGFlow REST API response bodies (shapes verified against the public HTTP API
 * reference, `{code, data}` envelope — docs/references/http_api_reference.md upstream) through
 * this manifest's own `result_mapping` declarations, using `@nexttime/gatekeeper-base`'s
 * `applyResultMapping` directly — no network involved.
 */

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'manifest.json',
);
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Operation[];

function operationWithMapping(
  name: string,
): Operation & { result_mapping: NonNullable<Operation['result_mapping']> } {
  const op = MANIFEST.find((o) => o.name === name);
  if (!op) throw new Error(`manifest.json has no operation "${name}"`);
  if (!op.result_mapping) throw new Error(`operation "${name}" has no result_mapping`);
  return op as Operation & { result_mapping: NonNullable<Operation['result_mapping']> };
}

describe('ragflow result mapping (sample API responses -> KnowledgeBase/Document facts)', () => {
  it('kb.list maps a sample dataset-list response to KnowledgeBase facts', () => {
    const op = operationWithMapping('kb.list');
    const sampleResponse = {
      code: 0,
      data: [
        {
          id: 'ds1',
          name: 'Product Docs',
          chunk_count: 120,
          document_count: 8,
          embedding_model: 'bge-large',
          chunk_method: 'naive',
        },
      ],
      total_datasets: 1,
    };
    expect(applyResultMapping(sampleResponse, op.result_mapping)).toEqual([
      {
        objectType: 'KnowledgeBase',
        identity: { id: 'ds1' },
        properties: {
          name: 'Product Docs',
          chunkCount: 120,
          documentCount: 8,
          embeddingModel: 'bge-large',
          chunkMethod: 'naive',
        },
      },
    ]);
  });

  it('kb.documents maps a sample document-list response to Document facts', () => {
    const op = operationWithMapping('kb.documents');
    const sampleResponse = {
      code: 0,
      data: {
        docs: [{ id: 'doc1', name: 'manual.pdf', size: 20480, run: 'DONE', chunk_count: 42 }],
        total_datasets: 1,
      },
    };
    expect(applyResultMapping(sampleResponse, op.result_mapping)).toEqual([
      {
        objectType: 'Document',
        identity: { id: 'doc1' },
        properties: { name: 'manual.pdf', size: 20480, run: 'DONE', chunkCount: 42 },
      },
    ]);
  });

  it('document.upload maps a sample upload response to a Document fact', () => {
    const op = operationWithMapping('document.upload');
    const sampleResponse = {
      code: 0,
      data: [{ id: 'doc2', name: 'empty-placeholder', dataset_id: 'ds1', size: 0, run: 'UNSTART' }],
    };
    expect(applyResultMapping(sampleResponse, op.result_mapping)).toEqual([
      {
        objectType: 'Document',
        identity: { id: 'doc2' },
        properties: { name: 'empty-placeholder', size: 0, run: 'UNSTART' },
      },
    ]);
  });

  it('an error response (code != 0, no data) produces no facts — known limitation, see README', () => {
    const op = operationWithMapping('kb.list');
    const errorResponse = { code: 102, message: 'dataset not found' };
    expect(applyResultMapping(errorResponse, op.result_mapping)).toEqual([]);
  });
});
