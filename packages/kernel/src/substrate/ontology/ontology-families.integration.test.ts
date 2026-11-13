import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  OntologyFamilyNameError,
  assertOntologyFamilyName,
  deriveOntologyPackId,
  loadOntologyFamilyId,
  loadOntologyFamilyNames,
  nameOntologyFamily,
  publishOntologyDomainPack,
  publishOntologyVersion,
  seedPlatformMetaOntology,
} from './index.js';

/**
 * substrate/ontology — ontology-families.integration (legacy 706, migrations/core/0056): the name
 * of an ontology family, recorded once with its first named publish and never changed (F1), the
 * id a pack's, the command line's or an admin proposal's name derives (F2), `platform-meta` the
 * platform-meta ontology's alone (F3) — and the migration's names for the families that already
 * existed.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MIGRATION = path.join(MIGRATIONS_DIR, 'core', '0056_ontology_families.sql');

type Ws = { readonly workspaceId: string; readonly ownerId: string };

/** The part of 0056 that names the families already there (its step 2), run again in a test. */
const backfillOf = (sql: string): string => sql.slice(sql.indexOf('-- 2. Names already known.'));

/** A definition declaring `type`. */
const declaring = (type: string) => ({
  objectTypes: [{ name: type, description: 'd' }],
  linkTypes: [{ name: 'relates_to', domain: type, range: '*', description: 'd' }],
});

describe('legacy 706: the migration’s ops-assets id', () => {
  it('is deriveOntologyPackId("ops-assets")', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    const ids = [
      ...sql.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'::uuid/g),
    ].map((match) => match[1]);
    expect(ids).toEqual([deriveOntologyPackId('ops-assets')]);
  });

  it('a name: lower-case words joined by hyphens, at most 64 characters, never platform-meta', () => {
    expect(() => assertOntologyFamilyName('ops-assets')).not.toThrow();
    for (const bad of [
      'platform-meta',
      'Ops',
      'ops_assets',
      'ops--assets',
      '-ops',
      'a'.repeat(65),
      '',
    ]) {
      expect(() => assertOntologyFamilyName(bad), bad).toThrow(OntologyFamilyNameError);
    }
  });
});

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 706: ontology_families (integration, real Postgres)',
  () => {
    let pool: Pool;

    let sqlText: string;
    beforeAll(async () => {
      pool = createPool({ connectionString: DATABASE_URL as string });
      await runMigrations(pool, MIGRATIONS_DIR);
      sqlText = await readFile(MIGRATION, 'utf8');
    });
    afterAll(async () => {
      await pool.end();
    });

    async function newWorkspace(): Promise<Ws> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await superuser({ workspaceId, ownerId }, async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'l706',
        ]);
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
          [workspaceId, ownerId],
        );
      });
      return { workspaceId, ownerId };
    }
    const asApp = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn);
    function superuser<T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) {
      return withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }
    const names = (ws: Ws) =>
      superuser(ws, async (client) =>
        Object.fromEntries(
          (
            await client.query<{ id: string; name: string }>(
              'select id, name from ontology_families where workspace_id = $1 order by name',
              [ws.workspaceId],
            )
          ).rows.map((row) => [row.name, row.id]),
        ),
      );

    it('the platform-meta seed names its family platform-meta; a seeded pack its derived id', async () => {
      const ws = await newWorkspace();
      const meta = await asApp(ws, (client) =>
        seedPlatformMetaOntology(client, ws.workspaceId, ws.ownerId),
      );
      const ops = await asApp(ws, (client) =>
        publishOntologyDomainPack(client, ws.workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          principalId: ws.ownerId,
        }),
      );
      expect(ops.id).toBe(deriveOntologyPackId('ops-assets'));
      expect(await names(ws)).toEqual({ 'ops-assets': ops.id, 'platform-meta': meta.id });
      // The next seed of the same pack is its next version, and names nothing new.
      await asApp(ws, (client) =>
        publishOntologyDomainPack(client, ws.workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v2.yaml',
          principalId: ws.ownerId,
        }),
      );
      expect(await names(ws)).toEqual({ 'ops-assets': ops.id, 'platform-meta': meta.id });
      // Read back as the application reads them.
      await asApp(ws, async (client) => {
        expect(await loadOntologyFamilyId(client, ws.workspaceId, 'platform-meta')).toBe(meta.id);
        expect(
          await loadOntologyFamilyNames(client, ws.workspaceId, [meta.id, ops.id, randomUUID()]),
        ).toEqual(
          new Map([
            [meta.id, 'platform-meta'],
            [ops.id, 'ops-assets'],
          ]),
        );
      });
    });

    it('the command line may not name a family platform-meta, or a name of another shape', async () => {
      const ws = await newWorkspace();
      for (const packName of ['platform-meta', 'Ops_Assets']) {
        await expect(
          asApp(ws, (client) =>
            publishOntologyDomainPack(client, ws.workspaceId, {
              packName,
              fileName: 'ops-assets-v1.yaml',
              principalId: ws.ownerId,
            }),
          ),
        ).rejects.toThrow(OntologyFamilyNameError);
      }
      expect(await names(ws)).toEqual({});
    });

    it('F1: written once; the same name again changes nothing, another name or a taken name is refused', async () => {
      const ws = await newWorkspace();
      const id = deriveOntologyPackId('widgets');
      await asApp(ws, (client) =>
        publishOntologyVersion(client, ws.workspaceId, {
          id,
          definition: declaring('Widget'),
          principalId: ws.ownerId,
          origin: 'human',
          family: 'widgets',
        }),
      );
      await asApp(ws, (client) => nameOntologyFamily(client, ws.workspaceId, id, 'widgets'));
      await expect(
        asApp(ws, (client) => nameOntologyFamily(client, ws.workspaceId, id, 'gadgets')),
      ).rejects.toThrow(/is named "widgets", not "gadgets"/);
      await expect(
        asApp(ws, (client) => nameOntologyFamily(client, ws.workspaceId, randomUUID(), 'widgets')),
      ).rejects.toThrow(/already names another ontology family/);
      expect(await names(ws)).toEqual({ widgets: id });
      // A family published with no name (a console draft's) has no row, and is still a family.
      const unnamed = await asApp(ws, (client) =>
        publishOntologyVersion(client, ws.workspaceId, {
          definition: declaring('Gadget'),
          principalId: ws.ownerId,
          origin: 'human',
        }),
      );
      expect(Object.values(await names(ws))).not.toContain(unnamed.id);
    });

    it('the database keeps F1 too: no update or delete for the application, no update for anyone, and the shape', async () => {
      const ws = await newWorkspace();
      const other = await newWorkspace();
      const id = deriveOntologyPackId('widgets');
      await asApp(ws, (client) =>
        publishOntologyVersion(client, ws.workspaceId, {
          id,
          definition: declaring('Widget'),
          principalId: ws.ownerId,
          origin: 'human',
          family: 'widgets',
        }),
      );
      await expect(
        asApp(ws, (client) =>
          client.query("update ontology_families set name = 'gadgets' where id = $1", [id]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asApp(ws, (client) => client.query('delete from ontology_families where id = $1', [id])),
      ).rejects.toThrow(/permission denied/);
      await expect(
        superuser(ws, (client) =>
          client.query("update ontology_families set name = 'gadgets' where id = $1", [id]),
        ),
      ).rejects.toThrow(/a family's name never changes \(F1\)/);
      await expect(
        superuser(ws, (client) =>
          client.query(
            'insert into ontology_families (workspace_id, id, name) values ($1, $2, $3)',
            [ws.workspaceId, randomUUID(), 'Not_A_Name'],
          ),
        ),
      ).rejects.toThrow(/ontology_families_name_shape/);
      // RLS: another workspace sees none of it, and cannot write into it.
      await asApp(other, async (client) => {
        const seen = await client.query('select 1 from ontology_families where id = $1', [id]);
        expect(seen.rowCount).toBe(0);
        await expect(
          client.query(
            'insert into ontology_families (workspace_id, id, name) values ($1, $2, $3)',
            [ws.workspaceId, randomUUID(), 'intruder'],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });

    it('the migration names the families that already exist: platform-meta and ops-assets (an installed one: application/packs)', async () => {
      const ws = await newWorkspace();
      const bare = await newWorkspace();
      const meta = await asApp(ws, (client) =>
        seedPlatformMetaOntology(client, ws.workspaceId, ws.ownerId),
      );
      const ops = await asApp(ws, (client) =>
        publishOntologyDomainPack(client, ws.workspaceId, {
          packName: 'ops-assets',
          fileName: 'ops-assets-v1.yaml',
          principalId: ws.ownerId,
        }),
      );
      // Before 0056 nothing named them.
      await superuser(ws, (client) =>
        client.query('delete from ontology_families where workspace_id = any($1)', [
          [ws.workspaceId, bare.workspaceId],
        ]),
      );
      expect(await names(ws)).toEqual({});

      await superuser(ws, (client) => client.query(backfillOf(sqlText)));
      expect(await names(ws)).toEqual({ 'ops-assets': ops.id, 'platform-meta': meta.id });
      // A workspace with no platform-meta ontology is left unnamed, not an error.
      expect(await names(bare)).toEqual({});
      // Run again: nothing changes.
      await superuser(ws, (client) => client.query(backfillOf(sqlText)));
      expect(await names(ws)).toEqual({ 'ops-assets': ops.id, 'platform-meta': meta.id });
    });
  },
);
