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
import { discardDraft } from './draft-lifecycle.js';
import { FamilyDraftPendingError, ReplacedDraftNotPendingError } from './family-version.js';

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

  it('S11 GO13: accepts a worker contract; refuses one a step’s outputSchema would refuse, naming the field', () => {
    const report = { type: 'object', properties: { summary: { type: 'string' } } };
    expect(() =>
      validateWorkerDefinitionContent('worker', {
        systemPrompt: 'hi',
        inputSchema: report,
        outputSchema: report,
      }),
    ).not.toThrow();
    for (const field of ['inputSchema', 'outputSchema']) {
      let thrown: unknown;
      try {
        validateWorkerDefinitionContent('worker', {
          systemPrompt: 'hi',
          [field]: { type: 'string' },
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkerDefinitionValidationError);
      expect((thrown as Error).message).toContain(`"${field}"`);
    }
    // Not an entry definition's field.
    expect(() =>
      validateWorkerDefinitionContent('entry', {
        systemPrompt: 'hi',
        capabilities: [],
        outputSchema: report,
      }),
    ).toThrow(WorkerDefinitionValidationError);
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
            origin: 'human',
            kind: 'entry',
            definition: VALID_ENTRY_DEFINITION,
          }),
        );

        expect(row.version).toBe(1);
        expect(row.status).toBe('draft');
        expect(row.proposedBy).toBe(builderId);
        expect(row.publishedBy).toBeNull();
      });

      it('legacy 680: a next version over the proposer’s own pending draft is refused; once it is published, anyone extends the family', async () => {
        const first = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            kind: 'worker',
            definition: { ...VALID_WORKER_DEFINITION, name: 'Runner' },
          }),
        );
        // The proposer's own draft is pending: no second one beside it, and nothing written.
        const refused = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            definitionId: first.id,
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        ).catch((caught: unknown) => caught);
        expect(refused).toBeInstanceOf(FamilyDraftPendingError);
        expect(refused).toMatchObject({
          code: 'draft_pending',
          kind: 'worker_definition',
          familyId: first.id,
          draftVersion: 1,
        });
        expect((refused as Error).message).toContain(`"Runner" ${first.id}@1 is your draft`);
        await inTx(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: first.id,
            version: 1,
          }),
        );
        const second = await inTx(otherBuilderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
            origin: 'human',
            definitionId: first.id,
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        // Another principal's pending draft is not there for this proposer (I16), and a
        // WorkerDefinition is published by its version: theirs does not stop this one.
        const third = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            definitionId: first.id,
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        expect(second).toMatchObject({ id: first.id, version: 2, proposedBy: otherBuilderId });
        expect(third).toMatchObject({ id: first.id, version: 3, proposedBy: builderId });
        // Discarding the pending draft frees the proposer's next version.
        await expect(
          inTx(otherBuilderId, (client) =>
            proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
              origin: 'human',
              definitionId: first.id,
              kind: 'worker',
              definition: VALID_WORKER_DEFINITION,
            }),
          ),
        ).rejects.toMatchObject({ code: 'draft_pending', draftVersion: 2 });
        await inTx(otherBuilderId, (client) =>
          discardDraft(client, workspaceId, otherBuilderId, {
            kind: 'worker_definition',
            id: first.id,
            version: 2,
          }),
        );
        const fourth = await inTx(otherBuilderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
            origin: 'human',
            definitionId: first.id,
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        expect(fourth).toMatchObject({ id: first.id, version: 4, proposedBy: otherBuilderId });
      });

      it('legacy 680: a pack’s install (published in the same transaction) goes in beside the installer’s own pending draft', async () => {
        const derived = randomUUID();
        await inTx(ownerId, async (client) => {
          const installed = await proposeWorkerDefinition(client, workspaceId, ownerId, {
            origin: 'human',
            definitionId: derived,
            onMissingFamily: 'start',
            ownPendingDraft: 'beside',
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          });
          await publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: derived,
            version: installed.version,
          });
        });
        const own = await inTx(ownerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, ownerId, {
            origin: 'human',
            definitionId: derived,
            kind: 'worker',
            definition: { ...VALID_WORKER_DEFINITION, systemPrompt: 'Edited by hand.' },
          }),
        );
        const upgraded = await inTx(ownerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, ownerId, {
            origin: 'human',
            definitionId: derived,
            onMissingFamily: 'start',
            ownPendingDraft: 'beside',
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        expect(own).toMatchObject({ version: 2, status: 'draft' });
        expect(upgraded).toMatchObject({ version: 3, status: 'draft' });
        // Without it, the same call is refused.
        await expect(
          inTx(ownerId, (client) =>
            proposeWorkerDefinition(client, workspaceId, ownerId, {
              origin: 'human',
              definitionId: derived,
              onMissingFamily: 'start',
              kind: 'worker',
              definition: VALID_WORKER_DEFINITION,
            }),
          ),
        ).rejects.toBeInstanceOf(FamilyDraftPendingError);
      });

      it('legacy 680: replacesDraft edits the proposer’s own pending draft — that draft goes and the next number comes, in one call', async () => {
        // A family whose only version is that draft: as discard_draft then propose, it would be
        // lost (once discarded, nobody sees it). Replaced, the family keeps its id.
        const only = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            kind: 'worker',
            definition: { ...VALID_WORKER_DEFINITION, name: 'Fixer' },
          }),
        );
        const edited = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            definitionId: only.id,
            replacesDraft: 1,
            kind: 'worker',
            definition: { ...VALID_WORKER_DEFINITION, name: 'Fixer', systemPrompt: 'Fixed.' },
          }),
        );
        expect(edited).toMatchObject({
          id: only.id,
          version: 2,
          status: 'draft',
          proposedBy: builderId,
        });
        expect(edited.definition.systemPrompt).toBe('Fixed.');
        const before = await inTx(builderId, (client) =>
          getWorkerDefinition(client, workspaceId, { definitionId: only.id, version: 1 }),
        );
        expect(before).toBeNull();

        // Naming another version than the pending one: refused, naming the pending one.
        const wrong = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            definitionId: only.id,
            replacesDraft: 1,
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        ).catch((caught: unknown) => caught);
        expect(wrong).toBeInstanceOf(FamilyDraftPendingError);
        expect(wrong).toMatchObject({ familyId: only.id, draftVersion: 2 });

        // Published since: nothing of theirs pending to replace — 409, nothing proposed.
        await inTx(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: only.id,
            version: 2,
          }),
        );
        const stale = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            definitionId: only.id,
            replacesDraft: 2,
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        ).catch((caught: unknown) => caught);
        expect(stale).toBeInstanceOf(ReplacedDraftNotPendingError);
        expect(stale).toMatchObject({ code: 'draft_changed', familyId: only.id, draftVersion: 2 });
        const published = await inTx(builderId, (client) =>
          getWorkerDefinition(client, workspaceId, { definitionId: only.id, version: 2 }),
        );
        expect(published?.status).toBe('published');
        const next = await inTx(builderId, (client) =>
          getWorkerDefinition(client, workspaceId, { definitionId: only.id, version: 3 }),
        );
        expect(next).toBeNull();

        // Someone else's pending draft is not theirs to replace — the same 409 as none at all, so
        // it says nothing of that draft (I16).
        const theirs = await inTx(otherBuilderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
            origin: 'human',
            definitionId: only.id,
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        await expect(
          inTx(builderId, (client) =>
            proposeWorkerDefinition(client, workspaceId, builderId, {
              origin: 'human',
              definitionId: only.id,
              replacesDraft: theirs.version,
              kind: 'worker',
              definition: VALID_WORKER_DEFINITION,
            }),
          ),
        ).rejects.toBeInstanceOf(ReplacedDraftNotPendingError);
        const kept = await inTx(otherBuilderId, (client) =>
          getWorkerDefinition(client, workspaceId, { definitionId: only.id, version: 3 }),
        );
        expect(kept).toMatchObject({ status: 'draft', proposedBy: otherBuilderId });

        // replacesDraft names a draft of a family: without definitionId it is refused.
        await expect(
          inTx(builderId, (client) =>
            proposeWorkerDefinition(client, workspaceId, builderId, {
              origin: 'human',
              replacesDraft: 1,
              kind: 'worker',
              definition: VALID_WORKER_DEFINITION,
            }),
          ),
        ).rejects.toThrow(WorkerDefinitionValidationError);
      });

      it('legacy 492: a family only someone else has drafted is not found, as an id nothing has', async () => {
        const theirs = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            kind: 'entry',
            definition: VALID_ENTRY_DEFINITION,
          }),
        );
        const attempts = [
          { definitionId: theirs.id, kind: 'entry' as const }, // same kind: no version added to it
          { definitionId: theirs.id, kind: 'worker' as const }, // other kind: its kind not named
          { definitionId: randomUUID(), kind: 'worker' as const }, // no family under a chosen id
        ];
        const messages: string[] = [];
        for (const attempt of attempts) {
          const err = await inTx(otherBuilderId, (client) =>
            proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
              origin: 'human',
              ...attempt,
              definition: VALID_WORKER_DEFINITION,
            }),
          ).catch((caught: unknown) => caught);
          expect(err).toBeInstanceOf(WorkerDefinitionNotFoundError);
          messages.push((err as Error).message.replace(attempt.definitionId, '<id>'));
        }
        expect(new Set(messages).size).toBe(1);
        expect(messages[0]).not.toMatch(/entry|worker"/);

        const versions = await inTx(ownerId, async (client) => {
          const result = await client.query<{ id: string; version: number }>(
            'select id, version from worker_definitions where workspace_id = $1 and id = any($2)',
            [workspaceId, [theirs.id, attempts[2]?.definitionId]],
          );
          return result.rows;
        });
        expect(versions).toEqual([{ id: theirs.id, version: 1 }]);
      });

      it("legacy 492: a pack's install starts its own family, and extends it by every version", async () => {
        const derived = randomUUID();
        const started = await inTx(ownerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, ownerId, {
            origin: 'human',
            definitionId: derived,
            onMissingFamily: 'start',
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        expect(started).toMatchObject({ id: derived, version: 1 });
        // The draft is the owner's own; the install judges the family by every version all the same.
        await expect(
          inTx(builderId, (client) =>
            proposeWorkerDefinition(client, workspaceId, builderId, {
              origin: 'human',
              definitionId: derived,
              onMissingFamily: 'start',
              kind: 'entry',
              definition: VALID_ENTRY_DEFINITION,
            }),
          ),
        ).rejects.toThrow(WorkerDefinitionKindMismatchError);
      });

      it('rejects a kind mismatch against an existing definitionId', async () => {
        const first = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );

        await expect(
          inTx(builderId, (client) =>
            proposeWorkerDefinition(client, workspaceId, builderId, {
              origin: 'human',
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
            origin: 'human',
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
            origin: 'human',
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
            origin: 'human',
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
            origin: 'human',
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
            origin: 'human',
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
            origin: 'human',
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

      it('legacy 492: for whom the answer is, a draft not theirs is not found; their own is not published', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        const ref = { definitionId: draft.id, version: draft.version };

        await expect(
          inTx(otherBuilderId, (client) =>
            requirePublishedWorkerDefinition(client, workspaceId, ref, otherBuilderId),
          ),
        ).rejects.toThrow(WorkerDefinitionNotFoundError);
        await expect(
          inTx(builderId, (client) =>
            requirePublishedWorkerDefinition(client, workspaceId, ref, builderId),
          ),
        ).rejects.toThrow(WorkerDefinitionNotPublishedError);
      });

      it('resolves a published version', async () => {
        const draft = await inTx(builderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, builderId, {
            origin: 'human',
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
            origin: 'human',
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
            origin: 'human',
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
            origin: 'human',
            kind: 'worker',
            definition: VALID_WORKER_DEFINITION,
          }),
        );
        const othersDraft = await inTx(otherBuilderId, (client) =>
          proposeWorkerDefinition(client, workspaceId, otherBuilderId, {
            origin: 'human',
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
            origin: 'human',
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
            origin: 'human',
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
              origin: 'human',
              kind: 'worker',
              definition: VALID_WORKER_DEFINITION,
            }),
          );
          createdIds.push(draft.id);
        }
        for (let i = 0; i < 3; i += 1) {
          const draft = await inFreshTx(pagingBuilderId, (client) =>
            proposeWorkerDefinition(client, freshWorkspaceId, pagingBuilderId, {
              origin: 'human',
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
