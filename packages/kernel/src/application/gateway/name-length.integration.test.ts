import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAT_TITLE_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  NAME_MAX_LENGTH,
  type OntologyDefinition,
  type Role,
  WORKER_DEFINITION_NAME_MAX_LENGTH,
} from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { publishOntologyVersion } from '../../substrate/ontology/index.js';
import { InvalidCapabilityParamsError, dispatchCapability } from './dispatch.js';
import { NameTooLongError } from './name-length.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Legacy 309: every cap on a name a caller gives a new thing, at its limit and one past it, end to
 * end through `dispatchCapability`. The caps a capability's `paramsSchema` carries refuse as any
 * params problem does (`InvalidCapabilityParamsError`); the ones a handler checks inside an opaque
 * payload refuse with `NameTooLongError` (400 `invalid_params`, `details.path` / `maxLength`) and
 * write nothing. The `/api/auth` routes' caps are in auth-routes.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** A unique name exactly `length` UTF-16 units long. */
function nameOf(length: number, prefix = 'n'): string {
  const head = `${prefix}-${randomUUID().slice(0, 8)}-`;
  return head + 'x'.repeat(length - head.length);
}

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 309 name caps (integration, real Postgres, dispatchCapability)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    function owner(): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: ownerId, kind: 'human', role: 'owner', displayName: null },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: ownerId,
          kind: 'web',
          onBehalfOf: ownerId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
      return dispatchCapability({ pool }, owner(), name, params) as Promise<T>;
    }

    function admin<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function count(table: string, column: string, value: string): Promise<number> {
      return admin(async (client) => {
        const result = await client.query<{ n: string }>(
          `select count(*)::text as n from ${table} where workspace_id = $1 and ${column} = $2`,
          [workspaceId, value],
        );
        return Number(result.rows[0]?.n);
      });
    }

    beforeAll(async () => {
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
            'legacy-309-name-caps',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, ownerId, 'human', 'owner' satisfies Role, 'owner'],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('caps in a capability’s params', () => {
      it('register_source: name up to NAME_MAX_LENGTH', async () => {
        const over = nameOf(NAME_MAX_LENGTH + 1, 'src');
        await expect(
          call('register_source', { kind: 'document', name: over, visibility: 'workspace' }),
        ).rejects.toBeInstanceOf(InvalidCapabilityParamsError);
        expect(await count('sources', 'name', over)).toBe(0);

        const at = nameOf(NAME_MAX_LENGTH, 'src');
        await expect(
          call('register_source', { kind: 'document', name: at, visibility: 'workspace' }),
        ).resolves.toMatchObject({ created: true });
      });

      it('create_principal: displayName up to DISPLAY_NAME_MAX_LENGTH', async () => {
        const over = nameOf(DISPLAY_NAME_MAX_LENGTH + 1, 'svc');
        await expect(
          call('create_principal', { role: 'member', displayName: over }),
        ).rejects.toBeInstanceOf(InvalidCapabilityParamsError);
        expect(await count('principals', 'display_name', over)).toBe(0);

        const at = nameOf(DISPLAY_NAME_MAX_LENGTH, 'svc');
        await call('create_principal', { role: 'member', displayName: at });
        expect(await count('principals', 'display_name', at)).toBe(1);
      });

      it('new_chat: title up to CHAT_TITLE_MAX_LENGTH, the cap rename_chat has', async () => {
        const over = nameOf(CHAT_TITLE_MAX_LENGTH + 1, 'chat');
        await expect(call('new_chat', { title: over })).rejects.toBeInstanceOf(
          InvalidCapabilityParamsError,
        );
        expect(await count('chats', 'title', over)).toBe(0);

        const at = nameOf(CHAT_TITLE_MAX_LENGTH, 'chat');
        await call('new_chat', { title: at });
        expect(await count('chats', 'title', at)).toBe(1);
      });
    });

    describe('caps a handler checks inside the payload', () => {
      it('propose_skill: a new Skill’s name up to NAME_MAX_LENGTH', async () => {
        const skill = (name: string) => ({
          skill: { name, description: 'Legacy 309.', markdown: '# Steps' },
        });
        const over = nameOf(NAME_MAX_LENGTH + 1, 'skill');
        const refused = call('propose_skill', skill(over));
        await expect(refused).rejects.toBeInstanceOf(NameTooLongError);
        await expect(refused).rejects.toMatchObject({
          code: 'invalid_params',
          details: { path: 'skill.name', maxLength: NAME_MAX_LENGTH },
        });
        expect(await count('skills', 'name', over)).toBe(0);

        const at = nameOf(NAME_MAX_LENGTH, 'skill');
        await expect(call('propose_skill', skill(at))).resolves.toMatchObject({
          status: 'draft',
        });
      });

      it('propose_procedure: a new Procedure’s name up to NAME_MAX_LENGTH', async () => {
        const procedure = (name: string) => ({
          procedure: { name, description: 'Legacy 309.', steps: [] },
        });
        const over = nameOf(NAME_MAX_LENGTH + 1, 'proc');
        await expect(call('propose_procedure', procedure(over))).rejects.toMatchObject({
          name: 'NameTooLongError',
          details: { path: 'procedure.name', maxLength: NAME_MAX_LENGTH },
        });
        expect(await count('procedures', 'name', over)).toBe(0);

        const at = nameOf(NAME_MAX_LENGTH, 'proc');
        await expect(call('propose_procedure', procedure(at))).resolves.toMatchObject({
          status: 'draft',
        });
      });

      it('propose_procedure: a next version may keep a name the Procedure already has, however long', async () => {
        const id = randomUUID();
        const long = nameOf(NAME_MAX_LENGTH + 20, 'proc');
        await admin((client) =>
          client.query(
            `insert into procedures (workspace_id, id, version, status, name, description, steps,
               proposed_by, published_by, published_at)
             values ($1, $2, 1, 'published', $3, 'Named before the cap.', '[]', $4, $4, now())`,
            [workspaceId, id, long, ownerId],
          ),
        );
        const next = (name: string) => ({
          procedureId: id,
          procedure: { name, description: 'Its next version.', steps: [] },
        });
        await expect(
          call('propose_procedure', next(nameOf(NAME_MAX_LENGTH + 1, 'proc'))),
        ).rejects.toMatchObject({
          name: 'NameTooLongError',
          details: { path: 'procedure.name', maxLength: NAME_MAX_LENGTH },
        });
        await expect(call('propose_procedure', next(long))).resolves.toMatchObject({
          id,
          version: 2,
          status: 'draft',
        });
      });

      it('propose_worker_definition: definition.name up to WORKER_DEFINITION_NAME_MAX_LENGTH', async () => {
        const params = (name: string) => ({
          kind: 'worker',
          definition: { name, systemPrompt: 'Legacy 309.' },
        });
        const over = nameOf(WORKER_DEFINITION_NAME_MAX_LENGTH + 1, 'wd');
        await expect(call('propose_worker_definition', params(over))).rejects.toMatchObject({
          name: 'NameTooLongError',
          details: { path: 'definition.name', maxLength: WORKER_DEFINITION_NAME_MAX_LENGTH },
        });
        const stored = await admin(async (client) => {
          const result = await client.query(
            `select 1 from worker_definitions where workspace_id = $1 and definition->>'name' = $2`,
            [workspaceId, over],
          );
          return result.rowCount;
        });
        expect(stored).toBe(0);

        const at = nameOf(WORKER_DEFINITION_NAME_MAX_LENGTH, 'wd');
        await expect(call('propose_worker_definition', params(at))).resolves.toMatchObject({
          status: 'draft',
        });
      });

      it('propose_worker_definition: a next version may keep a name the definition already has, however long', async () => {
        const id = randomUUID();
        const long = nameOf(WORKER_DEFINITION_NAME_MAX_LENGTH + 20, 'wd');
        await admin((client) =>
          client.query(
            `insert into worker_definitions
               (workspace_id, id, version, kind, status, definition, proposed_by, published_by,
                published_at)
             values ($1, $2, 1, 'worker', 'published', $3::jsonb, $4, $4, now())`,
            [workspaceId, id, JSON.stringify({ name: long, systemPrompt: 'v1' }), ownerId],
          ),
        );
        const next = (name: string) => ({
          kind: 'worker',
          definitionId: id,
          definition: { name, systemPrompt: 'v2' },
        });
        await expect(
          call(
            'propose_worker_definition',
            next(nameOf(WORKER_DEFINITION_NAME_MAX_LENGTH + 1, 'wd')),
          ),
        ).rejects.toMatchObject({
          name: 'NameTooLongError',
          details: { path: 'definition.name', maxLength: WORKER_DEFINITION_NAME_MAX_LENGTH },
        });
        await expect(call('propose_worker_definition', next(long))).resolves.toMatchObject({
          id,
          version: 2,
          status: 'draft',
        });
      });

      it('propose_ontology_change: a new type’s name up to NAME_MAX_LENGTH; one the workspace has published keeps working', async () => {
        // A long ObjectType / LinkType / ActionType the workspace published before the cap (a pack's,
        // or an earlier proposal's).
        const object = nameOf(NAME_MAX_LENGTH + 20, 'Obj');
        const link = nameOf(NAME_MAX_LENGTH + 20, 'link');
        const action = nameOf(NAME_MAX_LENGTH + 20, 'act');
        const published: OntologyDefinition = {
          objectTypes: [{ name: object, description: 'Published before the cap.' }],
          linkTypes: [{ name: link, domain: object, range: object, description: 'Long too.' }],
          actionTypes: [
            { name: action, description: 'Long too.', mode: 'observe', blastRadius: 'low' },
          ],
        };
        const family = await admin((client) =>
          publishOntologyVersion(client, workspaceId, {
            origin: 'human',
            definition: published,
            principalId: ownerId,
          }),
        );

        // Its next version carries them on.
        await expect(
          call('propose_ontology_change', {
            id: family.id,
            change: {
              ...published,
              objectTypes: [{ name: object, description: 'Carried on, described anew.' }],
            },
          }),
        ).resolves.toMatchObject({ status: 'draft' });

        // A new name past the cap is refused, wherever it sits, with where it is.
        const shortObject = nameOf(NAME_MAX_LENGTH, 'Obj');
        const cases = [
          {
            change: {
              objectTypes: [{ name: nameOf(NAME_MAX_LENGTH + 1, 'Obj'), description: 'New.' }],
              linkTypes: [{ name: 'rel', domain: object, range: object, description: 'd' }],
            },
            path: 'change.objectTypes.0.name',
          },
          {
            change: {
              objectTypes: [{ name: shortObject, description: 'New.' }],
              linkTypes: [
                { name: link, domain: shortObject, range: object, description: 'Carried on.' },
                {
                  name: nameOf(NAME_MAX_LENGTH + 1, 'link'),
                  domain: shortObject,
                  range: shortObject,
                  description: 'New.',
                },
              ],
            },
            path: 'change.linkTypes.1.name',
          },
          {
            id: family.id,
            change: {
              ...published,
              actionTypes: [
                ...(published.actionTypes ?? []),
                {
                  name: nameOf(NAME_MAX_LENGTH + 1, 'act'),
                  description: 'New.',
                  mode: 'observe',
                  blastRadius: 'low',
                },
              ],
            },
            path: 'change.actionTypes.1.name',
          },
        ];
        for (const { path: where, ...params } of cases) {
          await expect(call('propose_ontology_change', params)).rejects.toMatchObject({
            name: 'NameTooLongError',
            details: { path: where, maxLength: NAME_MAX_LENGTH },
          });
        }
        const drafts = await admin(async (client) => {
          const result = await client.query<{ n: string }>(
            `select count(*)::text as n from ontology_versions
             where workspace_id = $1 and status = 'draft'`,
            [workspaceId],
          );
          return Number(result.rows[0]?.n);
        });
        expect(drafts).toBe(1);

        // At the cap, a new name is accepted.
        await expect(
          call('propose_ontology_change', {
            change: {
              objectTypes: [{ name: shortObject, description: 'New.' }],
              linkTypes: [
                { name: 'rel', domain: shortObject, range: shortObject, description: 'd' },
              ],
            },
          }),
        ).resolves.toMatchObject({ status: 'draft' });
      });
    });
  },
);
