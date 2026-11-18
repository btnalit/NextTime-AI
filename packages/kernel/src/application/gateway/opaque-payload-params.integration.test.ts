import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { InvalidCapabilityParamsError, dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * `propose_skill`, `propose_procedure` and `propose_operation` register their payload (`skill`,
 * `procedure`, `operation`) as an opaque object and parse it in the handler. A payload that does
 * not fit is refused as any params problem is — `InvalidCapabilityParamsError` (400
 * `invalid_params`), its issues under the payload's field, the first one named in the message —
 * and nothing is written. Before, the handler's `ZodError` reached the routes unmapped: a 500.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'opaque payloads refused as params (integration, real Postgres, dispatchCapability)',
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

    /** The refusal `name` with `params` gives — it must be an `InvalidCapabilityParamsError`. */
    async function refusal(
      name: string,
      params: Record<string, unknown>,
    ): Promise<InvalidCapabilityParamsError> {
      const err = await dispatchCapability({ pool }, owner(), name, params).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(InvalidCapabilityParamsError);
      return err as InvalidCapabilityParamsError;
    }

    function pathsOf(err: InvalidCapabilityParamsError): string[] {
      return (err.issues as { path: PropertyKey[] }[]).map((issue) =>
        issue.path.map(String).join('.'),
      );
    }

    /** Rows of `table` in the workspace, written as the database owner (no row security). */
    async function rows(table: string): Promise<number> {
      return withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ n: string }>(
            `select count(*)::text as n from ${table} where workspace_id = $1`,
            [workspaceId],
          );
          return Number(result.rows[0]?.n);
        },
        { skipRoleSwitch: true },
      );
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
            'opaque-payload-params',
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

    it('propose_skill: a missing field, a wrong type, a key it does not take', async () => {
      const missing = await refusal('propose_skill', {
        skill: { name: 'triage', description: 'Triage alerts' },
      });
      expect(pathsOf(missing)).toEqual(['skill.markdown']);
      expect(missing.message).toMatch(
        /^invalid params for capability "propose_skill": skill\.markdown: /,
      );

      const wrongType = await refusal('propose_skill', {
        skill: { name: 7, description: 'Triage alerts', markdown: '# Triage' },
      });
      expect(pathsOf(wrongType)).toEqual(['skill.name']);

      const extra = await refusal('propose_skill', {
        skill: { name: 'triage', description: 'd', markdown: '# m', owner: 'someone' },
      });
      expect(pathsOf(extra)).toEqual(['skill']);
      expect(extra.message).toContain('"owner"');

      // Not an object at all; several issues at once, the rest counted.
      expect(pathsOf(await refusal('propose_skill', { skill: 'triage' }))).toEqual(['skill']);
      const several = await refusal('propose_skill', { skill: {} });
      expect(pathsOf(several)).toEqual(['skill.name', 'skill.description', 'skill.markdown']);
      expect(several.message).toMatch(/ \(and 2 more\)$/);

      expect(await rows('skills')).toBe(0);
    });

    it('propose_procedure: steps that are not a list', async () => {
      const err = await refusal('propose_procedure', {
        procedure: { name: 'rotate', description: 'Rotate keys', steps: 'all of them' },
      });
      expect(pathsOf(err)).toEqual(['procedure.steps']);
      expect(err.message).toMatch(
        /^invalid params for capability "propose_procedure": procedure\.steps: /,
      );
      expect(await rows('procedures')).toBe(0);
    });

    it('propose_operation: an Operation missing what it needs, before any gate is looked up', async () => {
      const err = await refusal('propose_operation', {
        gatekeeperId: randomUUID(),
        operation: { name: 'restart_service' },
      });
      expect(pathsOf(err).length).toBeGreaterThan(0);
      for (const place of pathsOf(err)) expect(place.startsWith('operation.')).toBe(true);
      expect(err.message).toMatch(
        /^invalid params for capability "propose_operation": operation\./,
      );
      expect(await rows('activities')).toBe(0);
    });
  },
);
