import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  deriveOntologyPackId,
  publishOntologyDomainPack,
  publishOntologyVersion,
} from './loader.js';
import { OntologyNamespaceConflictError } from './namespace.js';
import {
  OntologyChangeValidationError,
  OntologyDraftNotFoundError,
  getType,
  listOntologyVersions,
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

/** I-P1 (`namespace.ts`): published families may not share an ObjectType / ActionType name, and
 *  every test here publishes into the same workspace — so each call names its types uniquely. */
function minimalDefinition() {
  const tag = randomUUID().slice(0, 8);
  const widget = `Widget_${tag}`;
  const spin = `spin_${tag}`;
  return {
    widget,
    spin,
    definition: {
      objectTypes: [{ name: widget, description: 'A widget.', identityKey: ['widgetId'] }],
      linkTypes: [{ name: 'connects', domain: widget, range: widget, description: 'd' }],
      actionTypes: [
        {
          name: spin,
          description: 'Spin a Widget.',
          mode: 'execute' as const,
          blastRadius: 'low' as const,
          autoApprovable: true,
        },
      ],
    },
  };
}

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
      const fixture = minimalDefinition();
      const draft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, {
          change: fixture.definition,
          proposedBy: alice,
        }),
      );
      expect(draft.status).toBe('draft');
      expect(draft.version).toBe(1);

      // Alice (the proposer) sees her own draft.
      const aliceSees = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        getType(client, workspaceId, alice, fixture.widget),
      );
      expect(aliceSees?.kind).toBe('object');

      // Bob does not — the draft is private to its proposer (I16).
      const bobSees = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        getType(client, workspaceId, bob, fixture.widget),
      );
      expect(bobSees).toBeNull();

      const listedForBob = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        listTypes(client, workspaceId, bob, 'object'),
      );
      expect(listedForBob.some((t) => t.kind === 'object' && t.name === fixture.widget)).toBe(
        false,
      );

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
        getType(client, workspaceId, bob, fixture.widget),
      );
      expect(bobSeesNow?.kind).toBe('object');
    });

    it('get_type/list_types round-trip an ActionType’s mode/blastRadius (S2.1’s own dependency)', async () => {
      const fixture = minimalDefinition();
      const draft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, {
          change: fixture.definition,
          proposedBy: alice,
        }),
      );
      const spin = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        getType(client, workspaceId, alice, fixture.spin),
      );
      expect(spin).toEqual({
        kind: 'action',
        name: fixture.spin,
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
      const fixture = minimalDefinition();
      const draft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, {
          change: fixture.definition,
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

    // STATUS leftover 100: only the proposer may publish. Bob never saw Alice's draft (I16's read
    // half), so his publish must not land — and must read exactly like a missing row.
    it('publishOntologyDraft by another principal throws OntologyDraftNotFoundError and leaves the draft untouched', async () => {
      const fixture = minimalDefinition();
      const draft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, {
          change: fixture.definition,
          proposedBy: alice,
        }),
      );

      await expect(
        withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
          publishOntologyDraft(client, workspaceId, {
            id: draft.id,
            version: draft.version,
            publishedBy: bob,
          }),
        ),
      ).rejects.toThrow(OntologyDraftNotFoundError);

      const stillPrivate = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        listOntologyVersions(client, workspaceId, bob),
      );
      expect(
        stillPrivate.items.some((item) => item.id === draft.id && item.version === draft.version),
      ).toBe(false);

      const published = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyDraft(client, workspaceId, {
          id: draft.id,
          version: draft.version,
          publishedBy: alice,
        }),
      );
      expect(published.status).toBe('published');
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

  // Closing wave C5b (coverage gap G1 part 2): `list_ontology_versions`'s logic — mirrors
  // `listWorkerDefinitionsPage`/`listSkills`'s own I16 read-privacy predicate (published rows,
  // workspace-wide, plus the caller's own drafts), proven the same way this file already proves it
  // for `get_type`/`list_types` above.
  describe('listOntologyVersions', () => {
    it('shows every published row plus the caller’s own drafts, never another principal’s draft', async () => {
      const fixture = minimalDefinition();
      const alicesDraft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, {
          change: fixture.definition,
          proposedBy: alice,
        }),
      );

      const aliceOwnList = await withWorkspace(
        pool,
        { workspaceId, principalId: alice },
        (client) => listOntologyVersions(client, workspaceId, alice),
      );
      const aliceOwnRow = aliceOwnList.items.find(
        (item) => item.id === alicesDraft.id && item.version === alicesDraft.version,
      );
      expect(aliceOwnRow?.status).toBe('draft');
      expect(aliceOwnRow?.proposedBy).toEqual({ id: alice, kind: 'human', displayName: 'alice' });

      // Bob does not see Alice's still-private draft (I16) — same "absent, not a 403" convention
      // `get_type`/`list_types` already use for a draft the caller does not own.
      const bobList = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        listOntologyVersions(client, workspaceId, bob),
      );
      expect(
        bobList.items.some(
          (item) => item.id === alicesDraft.id && item.version === alicesDraft.version,
        ),
      ).toBe(false);

      // Every already-published row (e.g. the ops-assets-v1 domain pack published earlier in this
      // file) is visible workspace-wide, to both Alice and Bob.
      const opsAssetsId = deriveOntologyPackId('ops-assets');
      expect(aliceOwnList.items.some((item) => item.id === opsAssetsId)).toBe(true);
      expect(bobList.items.some((item) => item.id === opsAssetsId)).toBe(true);

      // Once published, Bob sees the exact same row.
      await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyDraft(client, workspaceId, {
          id: alicesDraft.id,
          version: alicesDraft.version,
          publishedBy: alice,
        }),
      );
      const bobListAfterPublish = await withWorkspace(
        pool,
        { workspaceId, principalId: bob },
        (client) => listOntologyVersions(client, workspaceId, bob),
      );
      const bobSeesPublished = bobListAfterPublish.items.find(
        (item) => item.id === alicesDraft.id && item.version === alicesDraft.version,
      );
      expect(bobSeesPublished?.status).toBe('published');
      expect(bobSeesPublished?.definition).toEqual(fixture.definition);
    });

    it('keyset-paginates newest created_at first', async () => {
      const page = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        listOntologyVersions(client, workspaceId, alice, { limit: 1 }),
      );
      expect(page.items.length).toBe(1);
      expect(page.nextCursor).toBeDefined();
      const nextPage = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        listOntologyVersions(client, workspaceId, alice, { limit: 1, cursor: page.nextCursor }),
      );
      expect(nextPage.items.length).toBe(1);
      // The second page is a different (id, version) row than the first — the cursor actually
      // advances rather than repeating page one.
      expect(`${nextPage.items[0]?.id}:${nextPage.items[0]?.version}`).not.toBe(
        `${page.items[0]?.id}:${page.items[0]?.version}`,
      );
    });

    it('a page boundary between two versions of one family created in the same millisecond skips neither', async () => {
      // Its own workspace: rows inserted on the login role with one fixed created_at, so the tie
      // is deterministic rather than hoped for.
      const ws = await adminInsertWorkspace('ontology-keyset-tie-workspace');
      const owner = randomUUID();
      const family = randomUUID();
      const fixture = minimalDefinition();
      await withWorkspace(
        pool,
        { workspaceId: ws, principalId: owner },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [ws, owner],
          );
          for (const version of [1, 2, 3]) {
            await client.query(
              `insert into ontology_versions
                 (workspace_id, id, version, status, definition, proposed_by, published_by,
                  created_at, published_at)
               values ($1, $2, $3, 'published', $4::jsonb, $5, $5,
                       '2026-10-08T00:00:00.123Z', now())`,
              [ws, family, version, JSON.stringify(fixture.definition), owner],
            );
          }
        },
        { skipRoleSwitch: true },
      );

      const seen: number[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const result = await withWorkspace(
          pool,
          { workspaceId: ws, principalId: owner },
          (client) =>
            listOntologyVersions(client, ws, owner, { limit: 1, ...(cursor ? { cursor } : {}) }),
        );
        seen.push(...result.items.map((item) => item.version));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([3, 2, 1]);

      // A two-part cursor issued before the version was added keeps its old meaning: everything
      // after that (createdAt, id), i.e. none of the family's three tied rows again.
      const legacy = Buffer.from(`2026-10-08T00:00:00.123Z|${family}`, 'utf8').toString(
        'base64url',
      );
      const afterLegacy = await withWorkspace(
        pool,
        { workspaceId: ws, principalId: owner },
        (client) => listOntologyVersions(client, ws, owner, { limit: 10, cursor: legacy }),
      );
      expect(afterLegacy.items).toEqual([]);
    });
  });

  // I-P1 (docs/s10-evolution-plan-2026-10-04.md §3.3, STATUS leftover 124): within a workspace an
  // ObjectType / ActionType name belongs to one published family; both publish paths refuse a
  // second owner and write nothing.
  describe('I-P1 — ObjectType / ActionType names are unique across published families', () => {
    it('publishOntologyDraft refuses a draft that redeclares another family’s ObjectType; the draft stays a draft', async () => {
      const owner = minimalDefinition();
      const ownerDraft = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        proposeOntologyChange(client, workspaceId, { change: owner.definition, proposedBy: alice }),
      );
      await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyDraft(client, workspaceId, {
          id: ownerDraft.id,
          version: ownerDraft.version,
          publishedBy: alice,
        }),
      );

      const other = minimalDefinition();
      const clash = {
        ...other.definition,
        objectTypes: [
          ...other.definition.objectTypes,
          { name: owner.widget, description: 'mine now' },
        ],
      };
      const clashDraft = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        proposeOntologyChange(client, workspaceId, { change: clash, proposedBy: bob }),
      );
      const refusal = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        publishOntologyDraft(client, workspaceId, {
          id: clashDraft.id,
          version: clashDraft.version,
          publishedBy: bob,
        }),
      ).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(OntologyNamespaceConflictError);
      expect((refusal as OntologyNamespaceConflictError).code).toBe('ontology_namespace_conflict');
      expect((refusal as OntologyNamespaceConflictError).conflicts).toEqual([
        { kind: 'object', name: owner.widget, ontologyId: ownerDraft.id },
      ]);

      const bobsRows = await withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        listOntologyVersions(client, workspaceId, bob),
      );
      expect(bobsRows.items.find((item) => item.id === clashDraft.id)?.status).toBe('draft');
      // Everyone still reads the owner family's definition of the type.
      const seen = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        getType(client, workspaceId, alice, owner.widget),
      );
      expect(seen).toMatchObject({ kind: 'object', description: 'A widget.' });
    });

    it('the loader path (seed, domain pack, install_module) refuses a new family that reuses an ActionType name, and writes no row', async () => {
      const owner = minimalDefinition();
      await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyVersion(client, workspaceId, {
          definition: owner.definition,
          principalId: alice,
        }),
      );
      const other = minimalDefinition();
      const clash = { ...other.definition, actionTypes: owner.definition.actionTypes };
      const countRows = async (): Promise<number> =>
        (
          await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
            client.query<{ n: number }>(
              'select count(*)::int as n from ontology_versions where workspace_id = $1',
              [workspaceId],
            ),
          )
        ).rows[0]?.n ?? -1;
      const before = await countRows();

      await expect(
        withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
          publishOntologyVersion(client, workspaceId, { definition: clash, principalId: alice }),
        ),
      ).rejects.toThrow(OntologyNamespaceConflictError);
      expect(await countRows()).toBe(before);
    });

    it('two concurrent publishes of the same new ObjectType name: the namespace lock lets exactly one family own it', async () => {
      const first = minimalDefinition();
      const second = minimalDefinition();
      const clash = {
        ...second.definition,
        objectTypes: [
          ...second.definition.objectTypes,
          { name: first.widget, description: 'mine too' },
        ],
      };
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // A publishes and keeps its transaction (and the workspace namespace lock) open.
      let aPublished!: () => void;
      const aReady = new Promise<void>((resolve) => {
        aPublished = resolve;
      });
      const a = withWorkspace(pool, { workspaceId, principalId: alice }, async (client) => {
        const row = await publishOntologyVersion(client, workspaceId, {
          definition: first.definition,
          principalId: alice,
        });
        aPublished();
        await held;
        return row;
      });
      await aReady;

      // B starts while A is uncommitted: it must wait on the advisory lock, not race past the check.
      const b = withWorkspace(pool, { workspaceId, principalId: bob }, (client) =>
        publishOntologyVersion(client, workspaceId, { definition: clash, principalId: bob }),
      ).catch((err: unknown) => err);
      const waiting = async (): Promise<number> =>
        (
          await pool.query<{ n: number }>(
            `select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
          )
        ).rows[0]?.n ?? 0;
      for (let i = 0; i < 100 && (await waiting()) === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await waiting()).toBeGreaterThan(0);

      release();
      const winner = await a;
      const loser = await b;
      expect(loser).toBeInstanceOf(OntologyNamespaceConflictError);
      expect((loser as OntologyNamespaceConflictError).conflicts).toEqual([
        { kind: 'object', name: first.widget, ontologyId: winner.id },
      ]);
      const owners = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        client.query<{ id: string }>(
          `select distinct t.id from ontology_versions t, jsonb_array_elements(t.definition -> 'objectTypes') e
            where t.workspace_id = $1 and t.status = 'published' and e ->> 'name' = $2`,
          [workspaceId, first.widget],
        ),
      );
      expect(owners.rows.map((row) => row.id)).toEqual([winner.id]);
    });

    it('a family’s next version keeps its own names; LinkType names may repeat across families', async () => {
      const first = minimalDefinition();
      const v1 = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyVersion(client, workspaceId, {
          definition: first.definition,
          principalId: alice,
        }),
      );
      const v2 = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyVersion(client, workspaceId, {
          id: v1.id,
          definition: first.definition,
          principalId: alice,
        }),
      );
      expect(v2.version).toBe(2);
      // `connects` is declared by every minimalDefinition() family already published here.
      const second = minimalDefinition();
      const sibling = await withWorkspace(pool, { workspaceId, principalId: alice }, (client) =>
        publishOntologyVersion(client, workspaceId, {
          definition: second.definition,
          principalId: alice,
        }),
      );
      expect(sibling.status).toBe('published');
    });
  });
});
