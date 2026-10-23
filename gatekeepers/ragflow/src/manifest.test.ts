import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';

/**
 * Validates `../manifest.json` (this gate's preset 接入包 content, design doc §7.10) against
 * `@nexttime/shared`'s `OperationSchema`, and spot-checks the task brief's classification.
 */

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'manifest.json',
);

function loadManifest(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Array<Record<string, unknown>>;
}

describe('gatekeepers/ragflow manifest.json', () => {
  it('every entry validates against OperationSchema', () => {
    const manifest = loadManifest();
    expect(manifest.length).toBeGreaterThan(0);
    for (const op of manifest) {
      expect(() => OperationSchema.parse(op)).not.toThrow();
    }
  });

  it('has the three observe operations from the task brief, all http-bound', () => {
    const manifest = loadManifest();
    const observeOps = manifest.filter((op) => op.mode === 'observe');
    expect(observeOps.map((op) => op.name).sort()).toEqual(['kb.documents', 'kb.list', 'retrieve']);
    for (const op of observeOps) {
      expect((op.binding as { kind: string }).kind).toBe('http');
      expect(op.auto_approvable).toBe(true);
    }
  });

  it('classifies both execute operations as medium and never auto-approvable', () => {
    const manifest = loadManifest();
    const upload = manifest.find((op) => op.name === 'document.upload');
    const parse = manifest.find((op) => op.name === 'document.parse');
    expect(upload).toMatchObject({
      mode: 'execute',
      blast_radius: 'medium',
      auto_approvable: false,
    });
    // Re-parsing a document makes RAGFlow delete every chunk it has, chunks added or edited by
    // hand included, before it parses again (`parse()` in RAGFlow's api/apps/sdk/doc.py, in each
    // release checked from v0.18.0 to v0.23.0) — lost work no one can undo, so a person approves every parse: no workspace
    // rule can turn auto-approval on for it (S3.4 had it low and auto-approvable).
    expect(parse).toMatchObject({
      mode: 'execute',
      blast_radius: 'medium',
      reversibility: false,
      auto_approvable: false,
      await_decision: true,
    });
    expect(parse?.description).toContain('cannot be recovered');
  });

  it('document.upload accepts real file content (S3.4: kbId/name/content, base64 or utf8)', () => {
    const manifest = loadManifest();
    const upload = manifest.find((op) => op.name === 'document.upload') as {
      params_schema: {
        required: string[];
        properties: Record<string, { type: string; enum?: string[] }>;
      };
      binding: { path: string };
    };
    expect(upload.params_schema.required.sort()).toEqual(['content', 'dataset_id', 'name']);
    expect(upload.params_schema.properties.content?.type).toBe('string');
    expect(upload.params_schema.properties.encoding?.enum).toEqual(['utf8', 'base64']);
    expect(upload.binding.path).toContain('type=local');
  });

  it('kb.list and kb.documents map their response to KnowledgeBase/Document facts', () => {
    const manifest = loadManifest();
    const kbList = manifest.find((op) => op.name === 'kb.list') as {
      result_mapping: Record<string, unknown>;
    };
    const kbDocs = manifest.find((op) => op.name === 'kb.documents') as {
      result_mapping: Record<string, unknown>;
    };
    expect(kbList.result_mapping.object_type).toBe('KnowledgeBase');
    expect(kbList.result_mapping.identity_keys).toEqual(['id']);
    expect(kbDocs.result_mapping.object_type).toBe('Document');
    expect(kbDocs.result_mapping.identity_keys).toEqual(['id']);
  });
  it('S11 P1-F: the platform connector preset carries the same Operations, all but document.upload', () => {
    // `connectors/ragflow/` is the template a platform administrator creates a gate-host instance
    // of RAGFlow from; the generic http transport cannot send `document.upload`'s multipart body.
    const presetOperations = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(MANIFEST_PATH),
          '..',
          '..',
          'connectors',
          'ragflow',
          'operations.json',
        ),
        'utf8',
      ),
    ) as unknown;
    expect(presetOperations).toEqual(loadManifest().filter((op) => op.name !== 'document.upload'));
  });
});
