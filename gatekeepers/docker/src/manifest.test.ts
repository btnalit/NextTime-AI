import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';

/**
 * Validates `../manifest.json` (this gate's preset 接入包 content, design doc §7.10) against
 * `@nexttime/shared`'s `OperationSchema`, and spot-checks the classification/mode/await_decision
 * values the task brief specifies verbatim.
 */

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'manifest.json',
);

function loadManifest(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Array<Record<string, unknown>>;
}

describe('gatekeepers/docker manifest.json', () => {
  it('every entry validates against OperationSchema', () => {
    const manifest = loadManifest();
    expect(manifest.length).toBeGreaterThan(0);
    for (const op of manifest) {
      expect(() => OperationSchema.parse(op)).not.toThrow();
    }
  });

  it('has exactly the four observe operations from the task brief, all auto_approvable and synchronous', () => {
    const manifest = loadManifest();
    const observeOps = manifest.filter((op) => op.mode === 'observe');
    expect(observeOps.map((op) => op.name).sort()).toEqual([
      'compose.ls',
      'container.inspect',
      'container.logs_tail',
      'containers.list',
    ]);
    for (const op of observeOps) {
      expect(op.auto_approvable).toBe(true);
      expect(op.await_decision).toBe(false);
    }
  });

  it('has exactly the three execute operations from the task brief, all auto_approvable:false', () => {
    const manifest = loadManifest();
    const executeOps = manifest.filter((op) => op.mode === 'execute');
    expect(executeOps.map((op) => op.name).sort()).toEqual([
      'compose.down',
      'compose.up',
      'container.restart',
    ]);
    for (const op of executeOps) {
      expect(op.auto_approvable).toBe(false);
    }
  });

  it('classifies container.restart as medium/await_decision:false with a cli binding', () => {
    const manifest = loadManifest();
    const op = manifest.find((o) => o.name === 'container.restart');
    expect(op).toMatchObject({
      blast_radius: 'medium',
      await_decision: false,
      binding: { kind: 'cli' },
    });
  });

  it('classifies compose.up/compose.down as high blast radius', () => {
    const manifest = loadManifest();
    for (const name of ['compose.up', 'compose.down']) {
      const op = manifest.find((o) => o.name === name);
      expect(op).toMatchObject({ blast_radius: 'high', mode: 'execute' });
    }
  });

  it('containers.list and container.inspect map their response to Container facts by id', () => {
    const manifest = loadManifest();
    for (const name of ['containers.list', 'container.inspect']) {
      const op = manifest.find((o) => o.name === name) as {
        result_mapping: Record<string, unknown>;
      };
      expect(op.result_mapping.object_type).toBe('Container');
      expect(op.result_mapping.identity_keys).toEqual(['id']);
    }
  });
});
