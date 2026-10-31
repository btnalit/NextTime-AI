import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/publish-worker-definition-references.integration.test (legacy 302): DB-gated
 * (auto-skip without DATABASE_URL) dispatch-level coverage of `publish_worker_definition`'s
 * reference check — what a person publishes through the capability is held to what is there, its
 * model included: the model is checked against the llm-proxy catalog (`MODELS_JSON_FILE`), read
 * only when the version names one, and a catalog that cannot be read refuses the publish (503)
 * rather than letting an unchecked model through. The refusal reaches the wire as 400
 * `unresolved_references` with every field's unresolved values in `details`, and the version stays
 * a draft.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const KNOWN_MODEL = 'anthropic/claude-known-model';

describe.runIf(DATABASE_URL !== undefined)(
  'publish_worker_definition: references resolve at publish (legacy 302, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let modelsDir: string;
    let savedModelsJsonFile: string | undefined;

    function humanCaller(principalId: string, role: Role): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId,
          kind: 'web',
          onBehalfOf: principalId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    const call = <T>(name: string, params: Record<string, unknown>): Promise<T> =>
      dispatchCapability({ pool }, humanCaller(ownerId, 'owner'), name, params) as Promise<T>;

    async function draft(definition: Record<string, unknown>) {
      return call<{ id: string; version: number }>('propose_worker_definition', {
        kind: 'worker',
        definition: { systemPrompt: 'You run things.', ...definition },
      });
    }

    const publish = (ref: { id: string; version: number }) =>
      call<{ status: string }>('publish_worker_definition', {
        definitionId: ref.id,
        version: ref.version,
      });

    async function wireRefusal(promise: Promise<unknown>) {
      let thrown: unknown;
      try {
        await promise;
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      return mapCapabilityError(thrown);
    }

    async function statusOf(ref: { id: string; version: number }): Promise<string | undefined> {
      const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ status: string }>(
          'select status from worker_definitions where workspace_id = $1 and id = $2 and version = $3',
          [workspaceId, ref.id, ref.version],
        ),
      );
      return rows.rows[0]?.status;
    }

    /** Runs `fn` with `MODELS_JSON_FILE` naming `file` (or a file that is not there). */
    async function withCatalog<T>(file: string, fn: () => Promise<T>): Promise<T> {
      process.env.MODELS_JSON_FILE = file;
      try {
        return await fn();
      } finally {
        if (savedModelsJsonFile === undefined) {
          Reflect.deleteProperty(process.env, 'MODELS_JSON_FILE');
        } else {
          process.env.MODELS_JSON_FILE = savedModelsJsonFile;
        }
      }
    }

    beforeAll(async () => {
      savedModelsJsonFile = process.env.MODELS_JSON_FILE;
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            `publish-references-${randomUUID().slice(0, 8)}`,
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      modelsDir = await mkdtemp(path.join(os.tmpdir(), 'publish-references-models-'));
      const [provider, model] = KNOWN_MODEL.split('/');
      await writeFile(
        path.join(modelsDir, 'models.json'),
        JSON.stringify({
          providers: {
            [provider as string]: {
              baseUrl: 'http://llm-proxy:8082/anthropic',
              apiKey: '$CAPABILITY_HANDLE',
              api: 'anthropic-messages',
              models: [{ id: model }],
            },
          },
        }),
      );
    });

    afterAll(async () => {
      await pool.end();
      await rm(modelsDir, { recursive: true, force: true });
    });

    it('every reference that is not there reaches the wire as 400 unresolved_references, by field; the version stays a draft', async () => {
      const ref = await draft({
        capabilities: ['get_object', 'no_such_capability'],
        gates: [randomUUID()],
        skills: ['nothing-by-this-name'],
        model: 'anthropic/not-offered',
      });
      const mapped = await withCatalog(path.join(modelsDir, 'models.json'), () =>
        wireRefusal(publish(ref)),
      );
      expect(mapped).toMatchObject({
        status: 400,
        code: 'unresolved_references',
        details: {
          unresolved: {
            capabilities: ['no_such_capability'],
            gates: [expect.any(String)],
            skills: ['nothing-by-this-name'],
            model: ['anthropic/not-offered'],
          },
        },
      });
      expect(await statusOf(ref)).toBe('draft');
    });

    it('a model the catalog offers is published', async () => {
      const ref = await draft({ model: KNOWN_MODEL });
      const published = await withCatalog(path.join(modelsDir, 'models.json'), () => publish(ref));
      expect(published.status).toBe('published');
    });

    it('a catalog that cannot be read refuses a version naming a model (503), and is not read for one that names none', async () => {
      const missing = path.join(modelsDir, 'not-there.json');
      const named = await draft({ model: KNOWN_MODEL });
      const mapped = await withCatalog(missing, () => wireRefusal(publish(named)));
      expect(mapped.status).toBe(503);
      expect(await statusOf(named)).toBe('draft');

      const unnamed = await draft({});
      expect((await withCatalog(missing, () => publish(unnamed))).status).toBe('published');
    });
  },
);
