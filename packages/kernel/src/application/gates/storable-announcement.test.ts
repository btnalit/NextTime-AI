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
 * or the gate acts on refused before any write. Legacy 837: half of a surrogate pair the same way,
 * its stand-in U+FFFD.
 */

/** Half of an emoji: what a cut through one leaves, and `jsonb` refuses. */
const HALF = '\u{1F600}'[0] as string;

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
      character: 'nul',
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

  it('half of a surrogate pair (legacy 837): U+FFFD in the description, the name and acted fields refused', () => {
    expect(storableManifestOperation(op({ description: `cut ${HALF}` })).description).toBe(
      'cut \ufffd',
    );
    expect(() => storableManifestOperation(op({ name: `x${HALF}` }))).toThrow(
      OperationNameInvalidError,
    );
    expect(() =>
      storableManifestOperation(
        op({ binding: { kind: 'http', method: 'POST', path: `/c/${HALF}` } }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'unstorable_text',
        details: { path: ['binding', 'path'], in: 'value', character: 'lone_surrogate' },
      }),
    );
    expect(() =>
      storableManifestOperation(
        op({
          params_schema: { type: 'object', properties: { [`i${HALF}d`]: { type: 'string' } } },
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        details: {
          path: ['params_schema', 'properties', 'i\\u{D83D}d'],
          in: 'key',
          character: 'lone_surrogate',
        },
      }),
    );
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
        details: { path: ['target'], in: 'value', character: 'nul' },
      }),
    );
  });

  it('half of a surrogate pair (legacy 837): escaped where U+0000 is, refused where U+0000 is', () => {
    const stored = storableAnnouncement(
      body({ displayName: `Docker ${HALF}`, operations: [op({ description: `d${HALF}` })] }),
    );
    expect(stored.displayName).toBe('Docker \ufffd');
    expect(stored.operations[0]?.description).toBe('d\ufffd');
    expect(() =>
      storableAnnouncement(body({ endpoint: `http://gate-docker:8080/${HALF}` })),
    ).toThrow(
      expect.objectContaining({
        code: 'unstorable_text',
        details: { path: ['endpoint'], in: 'value', character: 'lone_surrogate' },
      }),
    );
    expect(() => storableAnnouncement(body({ operations: [op({ name: `a${HALF}` })] }))).toThrow(
      OperationNameInvalidError,
    );
  });

  it('refuses an Operation name holding it', () => {
    expect(() => storableAnnouncement(body({ operations: [op({ name: 'a\u0000' })] }))).toThrow(
      OperationNameInvalidError,
    );
  });
});
