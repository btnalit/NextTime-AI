import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { deriveOntologyPackId, publishOntologyDomainPack } from './loader.js';
import {
  OntologyChangeValidationError,
  OntologyDraftNotFoundError,
  getType,
  listTypes,
  proposeOntologyChange,
  publishOntologyDraft,
  validateLink,
} from './registry.js';

/**
 * substrate/ontology/registry.test: DB-gated (real Postgres; auto-skip without DATABASE_URL) proof
 * of S3.1's acceptance criteria (docs/development-tasks.md S3.1: "同内容再发布得 v2；validate_link
 * domain/range；agent 提议的 draft 对他人不可见") plus `get_type`/`list_types` round-tripping an
 * ActionType (S2.1's own dependency on "S3.1 的 ActionType 元数据"). Same fixture pattern as
 * `loader.test.ts`'s own integration block.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

const MINIMAL_DEFINITION = {
  objectTypes: [{ name: 'Widget', description: 'A widget.', identityKey: ['widgetId'] }],
  linkTypes: [{ name: 'connects', domain: 'Widget', range: 'Widget', description: 'd' }],
  actionTypes: [
    {
      name: 'spin',
      description: 'Spin a Widget.',
      mode: 'execute',
      blastRadius: 'low',
      autoApprovable: true,
    },
  ],
};

describe.runIf(DATABASE_URL !== undefined)('substrate/ontology/registry (integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let alice: string;
  let bob: string;

  async function adminInsertWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId: id, principalId: randomUUID() },
      async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function adminInsertPrincipal(displayName: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: id },
      async (client) => {
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'builder', $3)",
          [workspaceId, id, displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await adminInsertWorkspace('ontology-registry-test-workspace');
    alice = await adminInsertPrincipal('alice');
    bob = await adminInsertPrincipal('bob');
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('publishOntologyDomainPack — "同内容再发布得 v2"', () => {
    it('publishes ops-assets-v1.yaml as v1, then again as v2 under the same deterministic id', async () => {
      const first = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyDomainPack(client, workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          dir: ONTOLOGY_DIR,
          principalId: alice,
        }),
      );
      expect(first.version).toBe(1);
      expect(first.status).toBe('published');
      expect(first.id).toBe(deriveOntologyPackId('ops-assets'));

      const second = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyDomainPack(client, workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          dir: ONTOLOGY_DIR,
          principalId: alice,
        }),
      );
      expect(second.id).toBe(first.id);
      expect(second.version).toBe(2);
      expect(second.definition).toEqual(first.definition);
    });

    it('get_type resolves every ObjectType/LinkType declared in ops-assets-v1.yaml', async () => {
      const names = [
        'Host',
        'ComposeProject',
        'Container',
        'Image',
        'SystemdService',
        'Process',
        'Volume',
        'Network',
        'Endpoint',
        'Repository',
        'Owner',
      ];
      for (const name of names) {
        const type = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
          getType(client, workspaceId, bob, name),
        );
        expect(type, `get_type(${name})`).not.toBeNull();
        expect(type?.kind).toBe('object');
      }

      const linkType = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        getType(client, workspaceId, bob, 'runs_on'),
      );
      expect(linkType?.kind).toBe('link');
      if (linkType?.kind === 'link') {
        expect(linkType.signatures.length).toBeGreaterThanOrEqual(4);
        expect(linkType.signatures).toContainEqual({
          domain: 'Container',
          range: 'Host',
          description: 'This Container instance is currently running on this Host.',
        });
      }
    });

    it('validate accepts an enumerated ops-assets domain/range pair and rejects an unlisted one', async () => {
      const accepted = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        validateLink(client, workspaceId, bob, {
          linkType: 'uses_image',
          sourceType: 'Container',
          targetType: 'Image',
        }),
      );
      expect(accepted).toEqual({ valid: true });

      const rejected = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        validateLink(client, workspaceId, bob, {
          linkType: 'uses_image',
          sourceType: 'Host',
          targetType: 'Image',
        }),
      );
      expect(rejected.valid).toBe(false);
      expect(rejected.errors?.[0]).toMatch(/does not permit/);

      const unknownLinkType = await withWorkspace(
        pool,
        { workspaceId, principalId: bob },
        (client) =>
          validateLink(client, workspaceId, bob, {
            linkType: 'does_not_exist',
            sourceType: 'Container',
            targetType: 'Image',
          }),
      );
      expect(unknownLinkType.valid).toBe(false);
      expect(unknownLinkType.errors?.[0]).toMatch(/unknown LinkType/);
    });
  });

  describe('proposeOntologyChange / publishOntologyDraft — I16 draft isolation', () => {
    it('a proposed draft is invisible to another principal, and disappears once published', async () => {
      const draft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, {
          change: MINIMAL_DEFINITION,
          proposedBy: alice,
        }),
      );
      expect(draft.status).toBe('draft');
      expect(draft.version).toBe(1);

      // Alice (the proposer) sees her own draft.
      const aliceSees = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        getType(client, workspaceId, alice, 'Widget'),
      );
      expect(aliceSees?.kind).toBe('object');

      // Bob does not — the draft is private to its proposer (I16).
      const bobSees = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        getType(client, workspaceId, bob, 'Widget'),
      );
      expect(bobSees).toBeNull();

      const listedForBob = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        listTypes(client, workspaceId, bob, 'object'),
      );
      expect(listedForBob.some((t) => t.kind === 'object' && t.name === 'Widget')).toBe(false);

      // Once published, everyone sees it.
      const published = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyDraft(client, workspaceId, {
          id: draft.id,
          version: draft.version,
          publishedBy: alice,
        }),
      );
      expect(published.status).toBe('published');

      const bobSeesNow = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        getType(client, workspaceId, bob, 'Widget'),
      );
      expect(bobSeesNow?.kind).toBe('object');
    });

    it('get_type/list_types round-trip an ActionType’s mode/blastRadius (S2.1’s own dependency)', async () => {
      const draft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, {
          change: MINIMAL_DEFINITION,
          proposedBy: alice,
        }),
      );
      const spin = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        getType(client, workspaceId, alice, 'spin'),
      );
      expect(spin).toEqual({
        kind: 'action',
        name: 'spin',
        description: 'Spin a Widget.',
        mode: 'execute',
        blastRadius: 'low',
        autoApprovable: true,
      });

      const listed = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        listTypes(client, workspaceId, alice, 'action'),
      );
      expect(listed).toContainEqual(spin);

      // clean up: publish so later tests in this file see a stable visible set for Alice.
      await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyDraft(client, workspaceId, {
          id: draft.id,
          version: draft.version,
          publishedBy: alice,
        }),
      );
    });

    it('publishOntologyDraft throws OntologyDraftNotFoundError for an already-published row', async () => {
      const draft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, {
          change: MINIMAL_DEFINITION,
          proposedBy: alice,
        }),
      );
      await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyDraft(client, workspaceId, {
          id: draft.id,
          version: draft.version,
          publishedBy: alice,
        }),
      );

      await expect(
        withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
          publishOntologyDraft(client, workspaceId, {
            id: draft.id,
            version: draft.version,
            publishedBy: alice,
          }),
        ),
      ).rejects.toThrow(OntologyDraftNotFoundError);
    });

    it('proposeOntologyChange rejects a structurally invalid change', async () => {
      await expect(
        withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
          proposeOntologyChange(client, workspaceId, {
            change: { objectTypes: [] },
            proposedBy: alice,
          }),
        ),
      ).rejects.toThrow(OntologyChangeValidationError);
    });
  });
});
