import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  OntologyLinkEndpointError,
  OntologyLinkEndpointOutsideRequiresError,
  deriveOntologyPackId,
  publishOntologyVersion,
  seedPlatformMetaOntology,
} from '../../substrate/ontology/index.js';
import { installOrUpgradeModule, moduleRegistryOf } from '../platform/modules.js';
import { type PackFixtureDirs, type PackFixtureVersion, writePackFixture } from './fixture.js';
import {
  type PackEntry,
  type PackRegistry,
  diskPackFiles,
  installPack,
  loadPackEntry,
  previewPackInstall,
} from './index.js';

/**
 * application/packs — link-endpoint-scope.integration (legacy 705, L1): installing a pack or a
 * module, each LinkType end of its ontology components names an ObjectType of the platform-meta
 * ontology, of its own families, or of the families of a pack it requires directly — as the
 * workspace has them, counting what the same install publishes. Anything else refuses 409
 * `ontology_link_endpoint_outside_requires`, after legacy 303's own check, writing nothing. And
 * (legacy 706) an install names the families it publishes; the migration names one installed
 * before it from its ChangePlan item.
 *
 * The packs here are read one by one (`loadPackEntry`), not through `readPackRegistry`, whose own
 * L1 rule would refuse the ones this file installs to see the install refuse them.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

type Ws = { readonly workspaceId: string; readonly ownerId: string };

/** A domain pack declaring `types`; each `[link, domain, range]` a LinkType. */
function yaml(types: readonly string[], links: readonly (readonly [string, string, string])[]) {
  const objectTypes = types.map((name) => `  - name: ${name}\n    description: d\n`).join('');
  const linkTypes = links
    .map(
      ([name, domain, range]) =>
        `  - name: ${name}\n    domain: ${JSON.stringify(domain)}\n    range: ${JSON.stringify(range)}\n    description: d\n`,
    )
    .join('');
  return `objectTypes:\n${objectTypes}linkTypes:\n${linkTypes}`;
}

const one = (
  family: string,
  types: readonly string[],
  links: readonly (readonly [string, string, string])[],
  requiresPacks?: PackFixtureVersion['requiresPacks'],
): PackFixtureVersion => ({
  ontology: [{ family, domainPack: `${family}.yaml`, yaml: yaml(types, links) }],
  ...(requiresPacks ? { requiresPacks } : {}),
});

const PACKS: Readonly<Record<string, readonly PackFixtureVersion[]>> = {
  hosts: [one('hosts', ['Host'], [['host_rel', 'Host', '*']])],
  // Links to Host, requiring nothing.
  tickets: [one('tickets', ['Ticket'], [['ticket_on_host', 'Ticket', 'Host']])],
  // Links to Host, requiring hosts.
  'tickets-ok': [
    one(
      'tickets-ok',
      ['OkTicket'],
      [['ok_ticket_on_host', 'OkTicket', 'Host']],
      [{ name: 'hosts', minVersion: 1 }],
    ),
  ],
  // Requires tickets-ok, which requires hosts: links to Host all the same.
  deep: [
    one(
      'deep',
      ['Deep'],
      [['deep_on_host', 'Deep', 'Host']],
      [{ name: 'tickets-ok', minVersion: 1 }],
    ),
  ],
  // Two families, one linking to the other: both its own, published in the same install.
  bundle: [
    {
      ontology: [
        {
          family: 'bundle-a',
          domainPack: 'bundle-a.yaml',
          yaml: yaml(['BundleA'], [['a_rel', 'BundleA', '*']]),
        },
        {
          family: 'bundle-b',
          domainPack: 'bundle-b.yaml',
          yaml: yaml(['BundleB'], [['b_to_a', 'BundleB', 'BundleA']]),
        },
      ],
    },
  ],
  // Links to the platform-meta ontology's Gatekeeper, requiring nothing.
  gated: [one('gated', ['GateNote'], [['note_on_gate', 'GateNote', 'Gatekeeper']])],
  // Modules: every version publishes only the family named after it.
  'mod-tickets': [one('mod-tickets', ['ModTicket'], [['mod_on_host', 'ModTicket', 'Host']])],
  'mod-ok': [one('mod-ok', ['ModOk'], [['mod_ok_rel', 'ModOk', 'Gatekeeper']])],
};

describe.runIf(DATABASE_URL !== undefined)(
  'application/packs — legacy 705 L1 at install (integration, real Postgres)',
  () => {
    let pool: Pool;
    let fixture: PackFixtureDirs;
    let registry: PackRegistry;

    beforeAll(async () => {
      pool = createPool({ connectionString: DATABASE_URL as string });
      await runMigrations(pool, MIGRATIONS_DIR);
      fixture = await writePackFixture(PACKS);
      const entries: [string, PackEntry][] = [];
      for (const name of Object.keys(PACKS)) {
        entries.push([
          name,
          await loadPackEntry(diskPackFiles, path.join(fixture.packsDir, name), name, 'builtin', {
            library: fixture.ontologyDir,
          }),
        ]);
      }
      registry = new Map(entries);
    });
    afterAll(async () => {
      await rm(fixture.root, { recursive: true, force: true });
      await pool.end();
    });

    async function newWorkspace(meta = true): Promise<Ws> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await superuser({ workspaceId, ownerId }, async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'l705',
        ]);
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
          [workspaceId, ownerId],
        );
      });
      const ws = { workspaceId, ownerId };
      if (meta) {
        await asApp(ws, (client) => seedPlatformMetaOntology(client, workspaceId, ownerId));
      }
      return ws;
    }
    const asApp = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn);
    function superuser<T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) {
      return withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }
    const preview = (ws: Ws, name: string) =>
      asApp(ws, (client) => previewPackInstall(client, ws.workspaceId, registry, name));
    async function install(ws: Ws, name: string): Promise<void> {
      const reviewed = await preview(ws, name);
      await asApp(ws, (client) =>
        installPack(client, ws.workspaceId, ws.ownerId, registry, {
          name,
          version: reviewed.target.version,
          reviewedDigest: reviewed.plan.digest,
          confirmedOrdinals: reviewed.plan.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
        }),
      );
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
    const segments = (ws: Ws) =>
      superuser(ws, async (client) =>
        Number(
          (
            await client.query<{ n: string }>(
              'select count(*) as n from change_segments where workspace_id = $1',
              [ws.workspaceId],
            )
          ).rows[0]?.n,
        ),
      );
    async function refusal(
      promise: Promise<unknown>,
    ): Promise<OntologyLinkEndpointOutsideRequiresError> {
      const err = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OntologyLinkEndpointOutsideRequiresError);
      return err as OntologyLinkEndpointOutsideRequiresError;
    }

    it('a LinkType end naming a type of a pack it does not require is refused, naming the family and its pack; nothing written', async () => {
      const ws = await newWorkspace();
      await install(ws, 'hosts');
      const before = await segments(ws);
      const err = await refusal(preview(ws, 'tickets'));
      expect(err.code).toBe('ontology_link_endpoint_outside_requires');
      expect(err.ends).toEqual([
        {
          linkType: 'ticket_on_host',
          end: 'range',
          objectType: 'Host',
          declaredBy: deriveOntologyPackId('hosts'),
          family: 'hosts',
          pack: 'hosts',
        },
      ]);
      expect(err.message).toContain('add the pack that has it to requires.packs');
      // The install refuses the same way, and writes nothing.
      await refusal(
        asApp(ws, (client) =>
          installPack(client, ws.workspaceId, ws.ownerId, registry, {
            name: 'tickets',
            version: 1,
            reviewedDigest: `sha256:${'0'.repeat(64)}`,
            confirmedOrdinals: [],
          }),
        ),
      );
      expect(await segments(ws)).toBe(before);
      expect(Object.keys(await names(ws))).not.toContain('tickets');
    });

    it('legacy 303 first: with no family declaring the type, the end is undeclared, not outside', async () => {
      const ws = await newWorkspace();
      await expect(preview(ws, 'tickets')).rejects.toBeInstanceOf(OntologyLinkEndpointError);
    });

    it('a type declared by a family with no name (a console draft’s): refused, saying no family', async () => {
      const ws = await newWorkspace();
      const draftFamily = await asApp(ws, (client) =>
        publishOntologyVersion(client, ws.workspaceId, {
          definition: yaml2def(['Host']),
          principalId: ws.ownerId,
          origin: 'human',
        }),
      );
      const err = await refusal(preview(ws, 'tickets'));
      expect(err.ends).toEqual([
        expect.objectContaining({
          objectType: 'Host',
          declaredBy: draftFamily.id,
          family: null,
          pack: null,
        }),
      ]);
    });

    it('requiring the pack that declares it: installs, and names the family it publishes', async () => {
      const ws = await newWorkspace();
      await install(ws, 'hosts');
      await install(ws, 'tickets-ok');
      expect(await names(ws)).toMatchObject({
        hosts: deriveOntologyPackId('hosts'),
        'tickets-ok': deriveOntologyPackId('tickets-ok'),
        'platform-meta': expect.any(String),
      });
    });

    it('not through a pack the required one requires: not transitive', async () => {
      const ws = await newWorkspace();
      await install(ws, 'hosts');
      await install(ws, 'tickets-ok');
      const err = await refusal(preview(ws, 'deep'));
      expect(err.ends).toEqual([
        expect.objectContaining({ linkType: 'deep_on_host', family: 'hosts', pack: 'hosts' }),
      ]);
    });

    it('its own families, both published in the same install: installs', async () => {
      const ws = await newWorkspace();
      await install(ws, 'bundle');
      expect(await names(ws)).toMatchObject({
        'bundle-a': deriveOntologyPackId('bundle-a'),
        'bundle-b': deriveOntologyPackId('bundle-b'),
      });
    });

    it('a platform-meta ObjectType: installs without requiring anything', async () => {
      const ws = await newWorkspace();
      await install(ws, 'gated');
      expect(Object.keys(await names(ws))).toContain('gated');
    });

    it('a module is held to it too, and its install names its family', async () => {
      const ws = await newWorkspace();
      await install(ws, 'hosts');
      // The modules alone: a pack shaped like one that requires another is refused as a module.
      const modules = moduleRegistryOf(
        new Map([...registry].filter(([name]) => name.startsWith('mod-'))),
      );
      const err = await refusal(
        asApp(ws, (client) =>
          installOrUpgradeModule(client, ws.workspaceId, ws.ownerId, modules, {
            name: 'mod-tickets',
            channel: 'human',
          }),
        ),
      );
      // A module requires no pack, so its install knows no pack to name beside the family.
      expect(err.ends).toEqual([
        expect.objectContaining({ linkType: 'mod_on_host', family: 'hosts', pack: null }),
      ]);
      await asApp(ws, (client) =>
        installOrUpgradeModule(client, ws.workspaceId, ws.ownerId, modules, {
          name: 'mod-ok',
          channel: 'human',
        }),
      );
      expect(await names(ws)).toMatchObject({ 'mod-ok': deriveOntologyPackId('mod-ok') });
      expect(Object.keys(await names(ws))).not.toContain('mod-tickets');
    });

    it('legacy 706: the migration names a family installed before it from its ChangePlan item', async () => {
      const ws = await newWorkspace();
      await install(ws, 'hosts');
      await superuser(ws, (client) =>
        client.query('delete from ontology_families where workspace_id = $1', [ws.workspaceId]),
      );
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, 'core', '0056_ontology_families.sql'),
        'utf8',
      );
      await superuser(ws, (client) =>
        client.query(sql.slice(sql.indexOf('-- 2. Names already known.'))),
      );
      expect(await names(ws)).toEqual({
        hosts: deriveOntologyPackId('hosts'),
        'platform-meta': expect.any(String),
      });
    });
  },
);

/** A definition declaring `types`, each with one LinkType to anything. */
function yaml2def(types: readonly string[]) {
  return {
    objectTypes: types.map((name) => ({ name, description: 'd' })),
    linkTypes: types.map((name) => ({
      name: `${name.toLowerCase()}_rel`,
      domain: name,
      range: '*',
      description: 'd',
    })),
  };
}
