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

  it('classifies document.upload as medium (not auto-approvable) and document.parse as low, auto-approvable (S3.4)', () => {
    const manifest = loadManifest();
    const upload = manifest.find((op) => op.name === 'document.upload');
    const parse = manifest.find((op) => op.name === 'document.parse');
    expect(upload).toMatchObject({
      mode: 'execute',
      blast_radius: 'medium',
      auto_approvable: false,
    });
    // S3.4: document.parse is a hand-authored, reviewed classification (not an importOpenApi
    // draft) — auto_approvable:true + blast_radius:'low' resolves to `allow` under the workspace's
    // compiled-in low-blast-radius default (governance/policy/engine.ts's
    // `effectiveWorkspaceAutoApprove`), unless a workspace has explicitly opted out.
    expect(parse).toMatchObject({ mode: 'execute', blast_radius: 'low', auto_approvable: true });
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
});
