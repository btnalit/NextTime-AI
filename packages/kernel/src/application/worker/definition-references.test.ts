import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { WorkerDefinitionReferenceError } from './definition-references.js';
import {
  WorkerDefinitionValidationError,
  getWorkerDefinition,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from './definitions.js';
import { deprecateSkill, proposeSkill, publishSkill } from './skills.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for legacy 302: a
 * WorkerDefinition is published only when what it names is there — capabilities within the worker
 * ceiling, gates naming this workspace's Gatekeepers, skills naming published Skills, a model the
 * catalog offers (when one is passed) — every reference that is not refused at once, by field,
 * and nothing published. Read through the caller's client, so what the same transaction wrote
 * resolves (a pack's install publishes its Skills before its Workers).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'application/worker/definition-references (legacy 302, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let otherWorkspaceId: string;
    let otherOwnerId: string;

    async function adminInsertWorkspace(name: string): Promise<{ id: string; owner: string }> {
      const id = randomUUID();
      const owner = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [id, owner],
          );
        },
        { skipRoleSwitch: true },
      );
      return { id, owner };
    }

    const inTx = <T>(fn: (client: PoolClient) => Promise<T>, ws = workspaceId, as = ownerId) =>
      withWorkspace(pool, { workspaceId: ws, principalId: as }, fn);

    async function gatekeeper(client: PoolClient, ws: string, name: string): Promise<string> {
      const owner = ws === workspaceId ? ownerId : otherOwnerId;
      const activity = await client.query<{ id: string }>(
        `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.connection', 'running', $2) returning id`,
        [ws, owner],
      );
      const registered = await registerGatekeeper(client, ws, {
        name,
        transportKind: 'http',
        target: `${name}-system`,
        endpoint: `https://${name}-gate.example.invalid`,
        activityId: activity.rows[0]?.id ?? '',
        registeredBy: { id: owner, kind: 'human' },
      });
      return registered.gatekeeperId;
    }

    async function publishedSkill(client: PoolClient, name: string) {
      const draft = await proposeSkill(client, workspaceId, ownerId, {
        name,
        description: `What ${name} does.`,
        markdown: `# ${name}\n\nDo it.`,
      });
      return publishSkill(client, workspaceId, ownerId, draft.id);
    }

    async function workerDraft(client: PoolClient, definition: Record<string, unknown>) {
      return proposeWorkerDefinition(client, workspaceId, ownerId, {
        kind: 'worker',
        definition: { systemPrompt: 'You run things.', ...definition },
      });
    }

    async function refusalOf(call: Promise<unknown>): Promise<WorkerDefinitionReferenceError> {
      let thrown: unknown;
      try {
        await call;
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkerDefinitionReferenceError);
      return thrown as WorkerDefinitionReferenceError;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const ws = await adminInsertWorkspace(`definition-references-${randomUUID().slice(0, 8)}`);
      workspaceId = ws.id;
      ownerId = ws.owner;
      const other = await adminInsertWorkspace(
        `definition-references-other-${randomUUID().slice(0, 8)}`,
      );
      otherWorkspaceId = other.id;
      otherOwnerId = other.owner;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a Worker naming only what is there is published', async () => {
      const { draft, skill, gate } = await inTx(async (client) => {
        const gate = await gatekeeper(client, workspaceId, `ok-${randomUUID().slice(0, 6)}`);
        const skill = await publishedSkill(client, `ok-skill-${randomUUID().slice(0, 6)}`);
        const draft = await workerDraft(client, {
          // The gate-projection patterns are in the worker ceiling too: a run keeps them.
          capabilities: ['get_object', 'assert_fact', 'request_action', '<gate>.<op>:execute'],
          gates: [gate],
          // By name and by id, as a run mounts them.
          skills: [skill.name, skill.id],
        });
        return { draft, skill, gate };
      });
      const published = await inTx((client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          version: draft.version,
        }),
      );
      expect(published.status).toBe('published');
      expect(published.definition).toMatchObject({ gates: [gate], skills: [skill.name, skill.id] });
    });

    it('every reference that is not there is named at once, by field, and nothing is published', async () => {
      const { draft, unpublished, deprecated } = await inTx(async (client) => {
        const unpublished = await proposeSkill(client, workspaceId, ownerId, {
          name: `draft-only-${randomUUID().slice(0, 6)}`,
          description: 'Still a draft.',
          markdown: '# Draft\n\nNot yet.',
        });
        const gone = await publishedSkill(client, `retired-${randomUUID().slice(0, 6)}`);
        const deprecated = await deprecateSkill(client, workspaceId, gone.id);
        const draft = await workerDraft(client, {
          capabilities: [
            'get_object',
            'no_such_capability',
            // In the registry, but a Worker can never hold it (S11 GO5c).
            'propose_goal',
          ],
          gates: [
            randomUUID(),
            'not-a-uuid',
            // Listed twice: named once.
            'not-a-uuid',
          ],
          skills: [unpublished.name, deprecated.name, 'nothing-by-this-name'],
        });
        return { draft, unpublished, deprecated };
      });
      // A Gatekeeper of another workspace is not one of this workspace's.
      const foreignGate = await inTx(
        (client) => gatekeeper(client, otherWorkspaceId, `foreign-${randomUUID().slice(0, 6)}`),
        otherWorkspaceId,
        otherOwnerId,
      );
      const withForeign = await inTx((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          kind: 'worker',
          definition: {
            ...draft.definition,
            gates: [...(draft.definition.gates as string[]), foreignGate],
          },
        }),
      );

      const refusal = await refusalOf(
        inTx((client) =>
          publishWorkerDefinition(
            client,
            workspaceId,
            ownerId,
            { definitionId: withForeign.id, version: withForeign.version },
            undefined,
            { modelCatalog: async () => new Set(['fake/known']) },
          ),
        ),
      );
      expect(refusal.code).toBe('unresolved_references');
      const gates = draft.definition.gates as string[];
      expect(refusal.details.unresolved).toEqual({
        capabilities: ['no_such_capability', 'propose_goal'],
        gates: [gates[0], 'not-a-uuid', foreignGate],
        skills: [unpublished.name, deprecated.name, 'nothing-by-this-name'],
      });
      expect(refusal.message).toContain('no_such_capability');
      expect(refusal.message).toContain(foreignGate);
      // Nothing published: the version is still a draft.
      const after = await inTx((client) =>
        getWorkerDefinition(client, workspaceId, {
          definitionId: withForeign.id,
          version: withForeign.version,
        }),
      );
      expect(after?.status).toBe('draft');
    });

    it('what the same transaction wrote resolves: a Gatekeeper and a Skill created just before the Worker', async () => {
      const published = await inTx(async (client) => {
        const gate = await gatekeeper(client, workspaceId, `same-tx-${randomUUID().slice(0, 6)}`);
        const skill = await publishedSkill(client, `same-tx-skill-${randomUUID().slice(0, 6)}`);
        const draft = await workerDraft(client, { gates: [gate], skills: [skill.name] });
        return publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          version: draft.version,
        });
      });
      expect(published.status).toBe('published');
    });

    it('the model is checked against the catalog the caller passes, and read only when one is named', async () => {
      let reads = 0;
      const catalog = async () => {
        reads += 1;
        return new Set(['fake/known']);
      };
      const publish = (definitionId: string, version: number) =>
        inTx((client) =>
          publishWorkerDefinition(
            client,
            workspaceId,
            ownerId,
            { definitionId, version },
            undefined,
            { modelCatalog: catalog },
          ),
        );

      const unnamed = await inTx((client) => workerDraft(client, {}));
      await publish(unnamed.id, unnamed.version);
      expect(reads).toBe(0);

      const known = await inTx((client) => workerDraft(client, { model: 'fake/known' }));
      expect((await publish(known.id, known.version)).status).toBe('published');
      expect(reads).toBe(1);

      const unknown = await inTx((client) => workerDraft(client, { model: 'fake/gone' }));
      const refusal = await refusalOf(publish(unknown.id, unknown.version));
      expect(refusal.details.unresolved).toEqual({ model: ['fake/gone'] });

      // An entry definition's model too.
      const entry = await inTx((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'entry',
          definition: {
            systemPrompt: 'You are the entry agent.',
            capabilities: [],
            model: 'fake/gone',
          },
        }),
      );
      expect((await refusalOf(publish(entry.id, entry.version))).details.unresolved).toEqual({
        model: ['fake/gone'],
      });

      // No catalog passed (an internal caller): not checked.
      const internal = await inTx(async (client) => {
        const draft = await workerDraft(client, { model: 'fake/gone' });
        return publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: draft.id,
          version: draft.version,
        });
      });
      expect(internal.status).toBe('published');
    });

    it('an entry definition keeps its own ceiling check: outside it is invalid content, as before', async () => {
      const entry = await inTx((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'entry',
          definition: {
            systemPrompt: 'You are the entry agent.',
            capabilities: ['request_action'],
          },
        }),
      );
      await expect(
        inTx((client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: entry.id,
            version: entry.version,
          }),
        ),
      ).rejects.toBeInstanceOf(WorkerDefinitionValidationError);
    });
  },
);
