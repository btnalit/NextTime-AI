import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_REGISTRY, ROLE_VALUES, roleMayUseCapability } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import {
  type Seeded,
  humanCaller,
  newWorkspace,
  paramsFor,
  seedWorkspace,
  workspaceDigest,
} from './traversal-fixture.js';

/**
 * Batch D2 (docs/test-coverage-gaps-2026-11-06.md §5.7, gap G10): a role the registry does not
 * let use a capability is refused by the kernel itself — through `dispatchCapability`, the one
 * door every channel (HTTP, WS, the agent tool bridge) comes in by — and the refused call leaves
 * the workspace exactly as it was. roles.test.ts proves the predicate (`roleMayUseCapability`);
 * nothing proved that dispatch consults it for every capability, before any handler runs, so a
 * handler moved ahead of the check, or a capability dispatched around it, would go unseen.
 *
 * Over the whole registry, every workspace capability × every human role the predicate refuses:
 * the call, with params built from the capability's schema and pointed at real rows (so a
 * handler that did run would have something to act on), throws `ForbiddenError` naming that role,
 * and after the whole walk a digest of every row the workspace owns is unchanged — no write, no
 * audit row, no outbox event. (Whether a role refusal should leave a `refused` audit row is an
 * open question to #493, batch D3; today it leaves none, and this test pins that.)
 *
 * The allowed side is not walked here: calling every write as a role that may use it, with
 * made-up params, would run real handlers for nothing. That roles do clear what the registry
 * gives them is roles.test.ts's and the e2e journeys' job.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Every workspace capability a person's console could call (platform ones are another plane). */
const WORKSPACE_CAPABILITIES = CAPABILITY_REGISTRY.filter(
  (capability) => capability.scope !== 'platform' && !capability.adminAgentOnly,
);

/** The refused (role, capability) pairs; 325 today, over 62 workspace tables. Below this, the walk lost its
 *  subject (a registry or role-rule change worth looking at, not a pass). */
const MIN_REFUSED_PAIRS = 100;

describe.runIf(DATABASE_URL !== undefined)(
  'role refusals over the whole registry — batch D2 / G10 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let seed: Seeded;
    let principals: ReadonlyMap<string, string>;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const workspace = await newWorkspace(pool, 'role-refusal', ROLE_VALUES);
      principals = workspace.principals;
      seed = await seedWorkspace(
        pool,
        workspace.workspaceId,
        workspace.principals.get('owner') as string,
        `role-refusal-${randomUUID()}`,
      );
    });

    afterAll(async () => {
      await pool?.end();
    });

    it('every refused role × capability is a 403 from dispatch, and the workspace is untouched', async () => {
      const before = await workspaceDigest(pool, seed.workspaceId);
      const wrong: string[] = [];
      let refused = 0;
      for (const role of ROLE_VALUES) {
        const caller = humanCaller(seed.workspaceId, principals.get(role) as string, role);
        for (const capability of WORKSPACE_CAPABILITIES) {
          if (roleMayUseCapability(role, capability)) continue;
          refused += 1;
          const params = paramsFor(capability.paramsSchema, seed);
          const outcome = await dispatchCapability({ pool }, caller, capability.name, params).then(
            () => 'answered',
            (error: unknown) =>
              error instanceof ForbiddenError && error.message.includes(`"${role}"`)
                ? null
                : `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          );
          if (outcome !== null) wrong.push(`${role} → ${capability.name}: ${outcome}`);
        }
      }
      expect(wrong).toEqual([]);
      expect(refused).toBeGreaterThanOrEqual(MIN_REFUSED_PAIRS);
      expect(await workspaceDigest(pool, seed.workspaceId)).toEqual(before);
    });
  },
);
