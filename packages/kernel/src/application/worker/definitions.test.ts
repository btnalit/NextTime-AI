import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ENTRY_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import {
  WorkerDefinitionKindMismatchError,
  WorkerDefinitionNotFoundError,
  WorkerDefinitionNotPublishedError,
  WorkerDefinitionValidationError,
  deprecateWorkerDefinition,
  getPublishedEntryDefinition,
  getWorkerDefinition,
  listWorkerDefinitions,
  listWorkerDefinitionsPage,
  proposeWorkerDefinition,
  publishWorkerDefinition,
  requirePublishedWorkerDefinition,
  validateWorkerDefinitionContent,
} from './definitions.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL — same pattern as
 * application/chat/service.test.ts) for the WorkerDefinition registry: transitions, ownership,
 * the entry ceiling check, kind-specific schema validation, and "reference a draft is rejected"
 * (docs/development-tasks.md S2.6 acceptance).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const VALID_ENTRY_DEFINITION = {
  systemPrompt: 'You are the entry agent.',
  capabilities: ['get_object', 'traverse'],
};

const VALID_WORKER_DEFINITION = {
  systemPrompt: 'You are ops-runner.',
};

describe('validateWorkerDefinitionContent (pure)', () => {
  it('accepts a valid entry definition whose capabilities are within the ceiling', () => {
    expect(() => validateWorkerDefinitionContent('entry', VALID_ENTRY_DEFINITION)).not.toThrow();
  });

  it('rejects an entry definition with a capability outside the ceiling', () => {
    expect(() =>
      validateWorkerDefinitionContent('entry', {
        systemPrompt: 'hi',
        capabilities: ['request_action'],
      }),
    ).toThrow(WorkerDefinitionValidationError);
  });

  it('rejects an entry definition missing systemPrompt', () => {
    expect(() => validateWorkerDefinitionContent('entry', { capabilities: [] })).toThrow(
      WorkerDefinitionValidationError,
    );
  });

  it('accepts a valid worker definition with no capabilities field', () => {
    expect(() => validateWorkerDefinitionContent('worker', VALID_WORKER_DEFINITION)).not.toThrow();
  });

  it('rejects a worker definition carrying an unknown field', () => {
    // S2.7: `capabilities` is now a valid (worker-scoped, not entry's own) field on the worker
    // schema too (packages/shared/src/worker-definition.ts's own doc comment), and
    // feat/egress-definition-lists made `egressDeny` valid on both schemas — so this test now uses
    // a field neither schema declares (`.strict()` still rejects it) to prove the worker schema
    // still rejects fields that are not its own.
    expect(() =>
      validateWorkerDefinitionContent('worker', {
        systemPrompt: 'hi',
        notAField: ['nope'],
      }),
    ).toThrow(WorkerDefinitionValidationError);
  });

  it('accepts a worker definition declaring its own egressDeny (feat/egress-definition-lists)', () => {
    expect(() =>
      validateWorkerDefinitionContent('worker', {
        systemPrompt: 'hi',
        egressDeny: ['blocked.example.com'],
      }),
    ).not.toThrow();
  });

  it('accepts a worker definition declaring its own capabilities/gates (S2.7)', () => {
    expect(() =>
      validateWorkerDefinitionContent('worker', {
        systemPrompt: 'hi',
        capabilities: ['get_object', 'assert_fact'],
        gates: ['gk-1'],
      }),
    ).not.toThrow();
  });

  it('every capability the entry ceiling actually contains still validates (sanity)', () => {
    expect(() =>
      validateWorkerDefinitionContent('entry', {
        systemPrompt: 'hi',
        capabilities: [...ENTRY_CEILING_CAPABILITIES],
      }),
    ).not.toThrow();
  });
});

describe.runIf(DATABASE_URL !== undefined)(
  'application/worker/definitions (integration, real Postgres)',
  () => {
    let pool: Pool;
    const graphStore = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;
    let otherBuilderId: string;

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

    async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(
      principalId: string,
      fn: (client: import('pg').PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('worker-definitions-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      builderId = await adminInsertPrincipal('builder', 'builder');
      otherBuilderId = await adminInsertPrincipal('builder', 'other-builder');
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('propose', () => {
      it('creates a draft version-1 row owned by the proposer', async () => {
        const row = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'entry',
            definition: VALID_ENTRY_DEFINITION,
          }),
        );

        expect(row.version).toBe(1);
        expect(row.status).toBe('draft');
        expect(row.proposedBy).toBe(builderId);
        expect(row.publishedBy).toBeNull();
      });

      it('a second propose under the same definitionId produces version 2', async () => {
        const first = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        const second = await inTx(otherBuilderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
            definitionId: first.id,
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        expect(second.id).toBe(first.id);
        expect(second.version).toBe(2);
        expect(second.proposedBy).toBe(otherBuilderId);
      });

      it('rejects a kind mismatch against an existing definitionId', async () => {
        const first = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        await expect(
          inTx(builderId, (client) =>
            proposeWorkerDefinition(client, workspaceId, builderId, {
              definitionId: first.id,
              kind: 'entry',
              definition: VALID_ENTRY_DEFINITION,
            }),
          ),
        ).rejects.toThrow(WorkerDefinitionKindMismatchError);
      });

      it('propose does not validate content (invalid content is accepted as a draft)', async () => {
        const row = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'entry',
            definition: { nonsense: true },
          }),
        );
        expect(row.status).toBe('draft');
      });
    });

    describe('publish / deprecate', () => {
      it('publishes a draft, sets published_by/published_at, and projects a WorkerDefinition Object', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'entry',
            definition: VALID_ENTRY_DEFINITION,
          }),
        );

        const published = await inTx(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: draft.id,
            version: draft.version,
          }),
        );

        expect(published.status).toBe('published');
        expect(published.publishedBy).toBe(ownerId);
        expect(published.publishedAt).not.toBeNull();

        const object = await inTx(ownerId, (client) =>
          graphStore.search(client, workspaceId, { query: '', objectType: 'WorkerDefinition' }),
        );
        expect(object.some((o) => o.identityKey?.definitionId === draft.id)).toBe(true);
      });

      it('rejects publishing content that fails validation, leaving the row in draft', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'entry',
            definition: { systemPrompt: 'hi', capabilities: ['request_action'] },
          }),
        );

        await expect(
          inTx(ownerId, (client) =>
            publishWorkerDefinition(client, workspaceId, ownerId, {
              definitionId: draft.id,
              version: draft.version,
            }),
          ),
        ).rejects.toThrow(WorkerDefinitionValidationError);

        const stillDraft = await inTx(ownerId, (client) =>
          getWorkerDefinition(client, workspaceId, {
            definitionId: draft.id,
            version: draft.version,
          }),
        );
        expect(stillDraft?.status).toBe('draft');
      });

      it('rejects publishing an already-published version (IllegalTransition)', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        const ref = { definitionId: draft.id, version: draft.version };
        await inTx(ownerId, (client) => publishWorkerDefinition(client, workspaceId, ownerId, ref));

        await expect(
          inTx(ownerId, (client) => publishWorkerDefinition(client, workspaceId, ownerId, ref)),
        ).rejects.toThrow(IllegalTransition);
      });

      it('deprecates a published version, and rejects deprecating a draft', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        const ref = { definitionId: draft.id, version: draft.version };

        await expect(
          inTx(ownerId, (client) => deprecateWorkerDefinition(client, workspaceId, ref)),
        ).rejects.toThrow(IllegalTransition);

        await inTx(ownerId, (client) => publishWorkerDefinition(client, workspaceId, ownerId, ref));
        const deprecated = await inTx(ownerId, (client) =>
          deprecateWorkerDefinition(client, workspaceId, ref),
        );
        expect(deprecated.status).toBe('deprecated');
      });

      it('throws WorkerDefinitionNotFoundError for a nonexistent version', async () => {
        await expect(
          inTx(ownerId, (client) =>
            publishWorkerDefinition(client, workspaceId, ownerId, {
              definitionId: randomUUID(),
              version: 1,
            }),
          ),
        ).rejects.toThrow(WorkerDefinitionNotFoundError);
      });
    });

    describe('requirePublishedWorkerDefinition ("引用 draft 被拒")', () => {
      it('rejects a reference to a draft version', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        await expect(
          inTx(ownerId, (client) =>
            requirePublishedWorkerDefinition(client, workspaceId, {
              definitionId: draft.id,
              version: draft.version,
            }),
          ),
        ).rejects.toThrow(WorkerDefinitionNotPublishedError);
      });

      it('resolves a published version', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        const ref = { definitionId: draft.id, version: draft.version };
        await inTx(ownerId, (client) => publishWorkerDefinition(client, workspaceId, ownerId, ref));

        const resolved = await inTx(ownerId, (client) =>
          requirePublishedWorkerDefinition(client, workspaceId, ref),
        );
        expect(resolved.status).toBe('published');
      });
    });

    describe('getPublishedEntryDefinition / listWorkerDefinitions', () => {
      it('returns null when no entry definition has been published yet', async () => {
        const freshWorkspaceId = await adminInsertWorkspace('worker-definitions-empty-workspace');
        const freshOwnerId = await (async () => {
          const id = randomUUID();
          await withWorkspace(
            pool,
            { workspaceId: freshWorkspaceId, principalId: id },
            async (client) => {
              await client.query(
                "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
                [freshWorkspaceId, id],
              );
            },
            { skipRoleSwitch: true },
          );
          return id;
        })();

        const result = await withWorkspace(
          pool,
          { workspaceId: freshWorkspaceId, principalId: freshOwnerId },
          (client) => getPublishedEntryDefinition(client, freshWorkspaceId),
        );
        expect(result).toBeNull();
      });

      it('returns the most recently published entry definition, and lists published worker definitions', async () => {
        const entryDraft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'entry',
            definition: VALID_ENTRY_DEFINITION,
          }),
        );
        await inTx(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: entryDraft.id,
            version: entryDraft.version,
          }),
        );

        const publishedEntry = await inTx(ownerId, (client) =>
          getPublishedEntryDefinition(client, workspaceId),
        );
        expect(publishedEntry?.id).toBe(entryDraft.id);
        expect(publishedEntry?.kind).toBe('entry');

        const publishedWorkers = await inTx(ownerId, (client) =>
          listWorkerDefinitions(client, workspaceId, 'worker'),
        );
        expect(
          publishedWorkers.every((row) => row.status === 'published' && row.kind === 'worker'),
        ).toBe(true);
      });
    });

    describe('listWorkerDefinitionsPage / includeOwnDrafts (S8 W2-U2b, audit R6 "草稿保存后找不回")', () => {
      it('omits every draft row when includeOwnDrafts is omitted (default false, unchanged behavior)', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        const page = await inTx(builderId, (client) =>
          listWorkerDefinitionsPage(client, workspaceId, builderId, {}),
        );
        expect(page.items.some((row) => row.id === draft.id)).toBe(false);
        expect(page.items.every((row) => row.status === 'published')).toBe(true);
      });

      it('includes only the caller’s own draft rows when includeOwnDrafts is true', async () => {
        const ownDraft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        const othersDraft = await inTx(otherBuilderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        const page = await inTx(builderId, (client) =>
          listWorkerDefinitionsPage(client, workspaceId, builderId, { includeOwnDrafts: true }),
        );
        expect(page.items.some((row) => row.id === ownDraft.id && row.status === 'draft')).toBe(
          true,
        );
        expect(page.items.some((row) => row.id === othersDraft.id)).toBe(false);
      });

      it('never returns another principal’s draft, even for a caller who also passes includeOwnDrafts', async () => {
        const othersDraft = await inTx(otherBuilderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        const page = await inTx(ownerId, (client) =>
          listWorkerDefinitionsPage(client, workspaceId, ownerId, { includeOwnDrafts: true }),
        );
        expect(page.items.some((row) => row.id === othersDraft.id)).toBe(false);
      });

      it('leaves published rows unchanged (still present, still status "published") when includeOwnDrafts is true', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        await inTx(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: draft.id,
            version: draft.version,
          }),
        );

        const page = await inTx(builderId, (client) =>
          listWorkerDefinitionsPage(client, workspaceId, builderId, { includeOwnDrafts: true }),
        );
        const row = page.items.find((item) => item.id === draft.id);
        expect(row?.status).toBe('published');
      });

      it('pages consistently with includeOwnDrafts (every created row surfaces exactly once)', async () => {
        const freshWorkspaceId = await adminInsertWorkspace('worker-definitions-paging-workspace');

        async function adminInsertFreshPrincipal(
          role: string,
          displayName: string,
        ): Promise<string> {
          const id = randomUUID();
          await withWorkspace(
            pool,
            { workspaceId: freshWorkspaceId, principalId: id },
            async (client) => {
              await client.query(
                "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
                [freshWorkspaceId, id, role, displayName],
              );
            },
            { skipRoleSwitch: true },
          );
          return id;
        }

        const pagingBuilderId = await adminInsertFreshPrincipal('builder', 'paging-builder');
        const pagingOwnerId = await adminInsertFreshPrincipal('owner', 'paging-owner');

        async function inFreshTx<T>(
          principalId: string,
          fn: (client: import('pg').PoolClient) => Promise<T>,
        ): Promise<T> {
          return withWorkspace(pool, { workspaceId: freshWorkspaceId, principalId }, fn);
        }

        const createdIds: string[] = [];
        // Three draft-only rows (never published) plus three proposed-then-published rows — every
        // one of the six must surface exactly once while paging with includeOwnDrafts, at limit=2
        // (three pages).
        for (let i = 0; i < 3; i += 1) {
          const draft = await inFreshTx(pagingBuilderId, (client) =>
            proposeWorkerDefinition(client, freshWorkspaceId, pagingBuilderId, {
              kind: 'worker',
              definition: VALID_WORKER_DEFINITION,
            }),
          );
          createdIds.push(draft.id);
        }
        for (let i = 0; i < 3; i += 1) {
          const draft = await inFreshTx(pagingBuilderId, (client) =>
            proposeWorkerDefinition(client, freshWorkspaceId, pagingBuilderId, {
              kind: 'worker',
              definition: VALID_WORKER_DEFINITION,
            }),
          );
          await inFreshTx(pagingOwnerId, (client) =>
            publishWorkerDefinition(client, freshWorkspaceId, pagingOwnerId, {
              definitionId: draft.id,
              version: draft.version,
            }),
          );
          createdIds.push(draft.id);
        }

        const seen = new Set<string>();
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page = await inFreshTx(pagingBuilderId, (client) =>
            listWorkerDefinitionsPage(client, freshWorkspaceId, pagingBuilderId, {
              includeOwnDrafts: true,
              limit: 2,
              cursor,
            }),
          );
          for (const row of page.items) {
            expect(seen.has(row.id)).toBe(false);
            seen.add(row.id);
          }
          cursor = page.nextCursor;
          guard += 1;
        } while (cursor !== undefined && guard < 10);

        for (const id of createdIds) {
          expect(seen.has(id)).toBe(true);
        }
      });
    });
  },
);
