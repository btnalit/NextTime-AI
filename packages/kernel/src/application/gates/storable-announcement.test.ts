import type { Operation } from '@nexttime/shared';
import { UnstorableTextError } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  OperationNameInvalidError,
  storableManifestOperation,
} from '../../governance/gatekeepers/index.js';
import { type AnnounceBody, storableAnnouncement } from './store.js';

/**
 * Legacy 320 (unit, no DB): what a manifest entry and a gate announcement keep, escape or refuse
 * when they carry U+0000 — description and display name escaped to `\u{0}`, every field the kernel
 * or the gate acts on refused before any write.
 */

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    name: 'container.restart',
    description: 'Restart a container.',
    binding: { kind: 'http', method: 'POST', path: '/containers/{id}/restart' },
    params_schema: { type: 'object', properties: { id: { type: 'string' } } },
    mode: 'execute',
    blast_radius: 'high',
    reversibility: false,
    auto_approvable: false,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  };
}

describe('storableManifestOperation (legacy 320)', () => {
  it('returns an entry without U+0000 as is', () => {
    const entry = op();
    expect(storableManifestOperation(entry)).toBe(entry);
  });

  it('stores U+0000 in the description as the visible \\u{0}', () => {
    expect(storableManifestOperation(op({ description: 'a\u0000b' })).description).toBe('a\\u{0}b');
  });

  it('refuses a name holding it by the name rule, as any other control character', () => {
    expect(() => storableManifestOperation(op({ name: 'x\u0000' }))).toThrow(
      OperationNameInvalidError,
    );
  });

  it('refuses it in a field the gate acts on, naming the field', () => {
    let thrown: unknown;
    try {
      storableManifestOperation(
        op({ binding: { kind: 'http', method: 'POST', path: '/c/\u0000' } }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnstorableTextError);
    expect((thrown as UnstorableTextError).details).toEqual({
      path: ['binding', 'path'],
      in: 'value',
    });
    expect((thrown as Error).message).toContain('import_manifest: Operation "container.restart"');
  });

  it('refuses it in a params schema key', () => {
    expect(() =>
      storableManifestOperation(
        op({ params_schema: { type: 'object', properties: { 'i\u0000d': { type: 'string' } } } }),
      ),
    ).toThrow(UnstorableTextError);
  });
});

describe('storableAnnouncement (legacy 320)', () => {
  const body = (overrides: Partial<AnnounceBody> = {}): AnnounceBody => ({
    gateId: 'gate-1',
    connector: 'docker',
    transportKind: 'http',
    endpoint: 'http://gate-docker:8080',
    operations: [op()],
    ...overrides,
  });

  it('escapes the display name and an Operation description', () => {
    const stored = storableAnnouncement(
      body({ displayName: 'Docker \u0000', operations: [op({ description: 'd\u0000' })] }),
    );
    expect(stored.displayName).toBe('Docker \\u{0}');
    expect(stored.operations[0]?.description).toBe('d\\u{0}');
  });

  it('refuses it in an address', () => {
    expect(() => storableAnnouncement(body({ target: 'https://x\u0000' }))).toThrow(
      expect.objectContaining({
        code: 'unstorable_text',
        details: { path: ['target'], in: 'value' },
      }),
    );
  });

  it('refuses an Operation name holding it', () => {
    expect(() => storableAnnouncement(body({ operations: [op({ name: 'a\u0000' })] }))).toThrow(
      OperationNameInvalidError,
    );
  });
});
