import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  OntologyDefinitionParseError,
  OntologyDefinitionSchema,
  loadOntologyDefinitionFile,
  parseOntologyDefinition,
  publishOntologyVersion,
  resolveOntologyDir,
  seedPlatformMetaOntology,
} from './loader.js';

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

const VALID_YAML = `
objectTypes:
  - name: Thing
    description: A thing.
linkTypes:
  - name: relates_to
    domain: Thing
    range: "*"
    description: Relates one Thing to anything.
`;

describe('parseOntologyDefinition', () => {
  it('parses valid YAML into an OntologyDefinition', () => {
    const definition = parseOntologyDefinition(VALID_YAML);
    expect(definition.objectTypes).toEqual([{ name: 'Thing', description: 'A thing.' }]);
    expect(definition.linkTypes).toEqual([
      {
        name: 'relates_to',
        domain: 'Thing',
        range: '*',
        description: 'Relates one Thing to anything.',
      },
    ]);
  });

  it('throws OntologyDefinitionParseError on malformed YAML', () => {
    expect(() => parseOntologyDefinition('objectTypes: [')).toThrow(OntologyDefinitionParseError);
  });

  it('throws OntologyDefinitionParseError when objectTypes is missing', () => {
    expect(() =>
      parseOntologyDefinition(
        'linkTypes:\n  - name: x\n    domain: A\n    range: B\n    description: d\n',
      ),
    ).toThrow(OntologyDefinitionParseError);
  });

  it('throws OntologyDefinitionParseError when a LinkType is missing domain/range (I2)', () => {
    const missingRange = `
objectTypes:
  - name: A
    description: d
linkTypes:
  - name: rel
    domain: A
    description: d
`;
    expect(() => parseOntologyDefinition(missingRange)).toThrow(OntologyDefinitionParseError);
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() => parseOntologyDefinition(`${VALID_YAML}\nextra: true\n`)).toThrow(
      OntologyDefinitionParseError,
    );
  });
});

describe('OntologyDefinitionSchema', () => {
  it('is the single source of truth parseOntologyDefinition validates against', () => {
    const result = OntologyDefinitionSchema.safeParse({
      objectTypes: [{ name: 'A', description: 'd' }],
      linkTypes: [{ name: 'rel', domain: 'A', range: '*', description: 'd' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('resolveOntologyDir', () => {
  it('honors ONTOLOGY_DIR when set', () => {
    expect(resolveOntologyDir({ ONTOLOGY_DIR: '/custom/ontology' })).toBe('/custom/ontology');
  });

  it('defaults to the repo-root ontology/ directory in dev', () => {
    expect(path.resolve(resolveOntologyDir({}))).toBe(path.resolve(ONTOLOGY_DIR));
  });
});

describe('loadOntologyDefinitionFile', () => {
  it('loads and validates the real ontology/platform-meta.yaml checked into the repo', async () => {
    const definition = await loadOntologyDefinitionFile(
      path.join(ONTOLOGY_DIR, 'platform-meta.yaml'),
    );
    const objectTypeNames = definition.objectTypes.map((t) => t.name).sort();
    expect(objectTypeNames).toEqual(
      ['Capability', 'Gatekeeper', 'Operation', 'Procedure', 'Skill', 'WorkerDefinition'].sort(),
    );
    const linkTypeNames = definition.linkTypes.map((t) => t.name).sort();
    expect(linkTypeNames).toEqual(
      [
        'can_act_on',
        'connects_to',
        'exposes',
        'reads',
        'requires',
        'steps',
        'uses',
        'writes',
      ].sort(),
    );
    for (const linkType of definition.linkTypes) {
      expect(linkType.domain.length).toBeGreaterThan(0);
      expect(linkType.range.length).toBeGreaterThan(0);
    }
  });

  it('throws OntologyDefinitionParseError for a nonexistent file', async () => {
    await expect(loadOntologyDefinitionFile('/nonexistent/ontology.yaml')).rejects.toThrow(
      OntologyDefinitionParseError,
    );
  });
});

// -------------------------------------------------------------------------------------------
// Integration (real Postgres, auto-skip without DATABASE_URL) — same pattern as
// substrate/graph/sql-store.test.ts.
// -------------------------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(DATABASE_URL !== undefined)(
  'publishOntologyVersion / seedPlatformMetaOntology (integration)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

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
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', $3)",
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
      workspaceId = await adminInsertWorkspace('ontology-loader-test-workspace');
      ownerId = await adminInsertPrincipal('owner');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('publishes a fresh definition as a published, version-1 ontology_versions row', async () => {
      const definition = parseOntologyDefinition(VALID_YAML);
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishOntologyVersion(client, workspaceId, { definition, principalId: ownerId }),
      );

      expect(row.version).toBe(1);
      expect(row.status).toBe('published');
      expect(row.proposedBy).toBe(ownerId);
      expect(row.publishedBy).toBe(ownerId);
      expect(row.publishedAt).not.toBeNull();
      expect(row.definition).toEqual(definition);
    });

    it('publishing again under the same id produces version 2', async () => {
      const definition = parseOntologyDefinition(VALID_YAML);
      const first = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishOntologyVersion(client, workspaceId, { definition, principalId: ownerId }),
      );
      const second = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishOntologyVersion(client, workspaceId, {
          id: first.id,
          definition,
          principalId: ownerId,
        }),
      );

      expect(second.id).toBe(first.id);
      expect(second.version).toBe(2);
    });

    it('seedPlatformMetaOntology reads and publishes the real ontology/platform-meta.yaml', async () => {
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        seedPlatformMetaOntology(client, workspaceId, ownerId, ONTOLOGY_DIR),
      );

      expect(row.status).toBe('published');
      expect(row.definition.objectTypes.map((t) => t.name)).toContain('WorkerDefinition');
    });

    it('an already-published version cannot have its definition changed (I12, DB trigger)', async () => {
      const definition = parseOntologyDefinition(VALID_YAML);
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        publishOntologyVersion(client, workspaceId, { definition, principalId: ownerId }),
      );

      const otherDefinition = parseOntologyDefinition(
        VALID_YAML.replace('A thing.', 'A different thing.'),
      );
      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query(
            'update ontology_versions set definition = $1::jsonb where workspace_id = $2 and id = $3 and version = $4',
            [JSON.stringify(otherDefinition), workspaceId, row.id, row.version],
          ),
        ),
      ).rejects.toThrow();
    });
  },
);
