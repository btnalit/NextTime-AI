import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Capability, getCapability } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';
import {
  type Seeded,
  humanCaller,
  newWorkspace,
  paramsFor,
  registerSeededGatekeeper,
  seedWorkspace,
  workspaceDigest,
} from './traversal-fixture.js';

/**
 * Batch D4 (docs/test-coverage-gaps-2026-11-06.md §5.7, gap G6): a capability with side effects,
 * called twice with the same params, does what docs/contracts/capability-matrix.yaml says it does
 * (`repeat`, guard rule M6). The table drives the test: every row that declares an answer is
 * exercised here, so a declaration nobody checks cannot exist — a row whose first call the
 * fixture cannot make succeed fails, and needs a recipe below (or stays `unclear`).
 *
 * What each answer means, as asserted (per #493 on batch D4):
 * - `idempotent`: the second call succeeds and returns the same entity (same `id`, when it has
 *   one); every row the workspace owns is unchanged — outbox included, since a second outbox event
 *   is an external action done twice — except `audit_records`, which gains exactly the second
 *   call's own dispatch row (each call is audited, "审计只增不减") and no domain row (an `x.y`
 *   action: a second one would record a transition that did not happen).
 * - `creates`: the second call succeeds and returns a different entity (a new `id`).
 * - `repeats`: the second call succeeds, on the same entity (same `id`), and changes its state.
 * - `conflict: <code>`: the second call is refused with that wire error code, as a typed 4xx
 *   (`mapCapabilityError`, what HTTP and WS send); nothing changes, and the audit gains nothing
 *   but refusal records (`outcome: 'refused'`).
 *
 * Each row runs in a fresh, seeded workspace (traversal-fixture.ts), as its owner by the human
 * channel. What a capability does inside its gatekeeper (an execution-level idempotency store) is
 * another layer, not this column.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MATRIX = path.join(KERNEL_ROOT, '..', '..', 'docs', 'contracts', 'capability-matrix.yaml');

/** What a recipe gets: the seeded workspace, its owner's caller, its member, and the pool. */
interface RecipeContext {
  readonly pool: Pool;
  readonly caller: ResolvedCaller;
  readonly seed: Seeded;
  readonly memberId: string;
}

/** One extra case: sets the workspace up before the first call and returns the params; `first`
 *  is what the first call must answer, so the case provably took the path it is named for. */
interface Recipe {
  readonly setUp: (ctx: RecipeContext) => Promise<Record<string, unknown>>;
  readonly first?: unknown;
}

/** Extra cases for a row, beyond the one with schema-built params on the bare seed. A declaration
 *  holds on every path, so a row whose answer depends on state gets a case per state (per #493 on
 *  batch D4). */
const RECIPES: Readonly<Record<string, Readonly<Record<string, Recipe>>>> = {
  stop_agent: {
    // The bare seed has no Turn, so the schema-built case only walks the idle path
    // (`stopped: false` twice). Here a Turn is running first — `send_chat_message` starts one,
    // and with no agent runtime wired nothing ends it — so both calls take the stop path.
    'a running Turn': {
      setUp: async ({ pool, caller, seed }) => {
        await dispatchCapability({ pool }, caller, 'send_chat_message', {
          chatId: seed.chatId,
          text: 'run, so that it can be stopped',
        });
        return { chatId: seed.chatId };
      },
      first: { stopped: true },
    },
  },
  // Legacy 647: a second grant of one scope returns the first. Both name a person, which the
  // schema walk cannot pick (`principalId` falls back to an Operation's id), so these rows run their
  // recipes only (`RECIPES_ONLY`).
  grant_capability: {
    'the member, the seeded gate': {
      setUp: async ({ seed, memberId }) => ({
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
      }),
    },
  },
  connect_gatekeeper: {
    'the member, the seeded gate': {
      setUp: async ({ pool, seed, memberId }) => {
        await registerSeededGatekeeper(pool, seed);
        return { gatekeeperId: seed.gatekeeperId, principalId: memberId };
      },
    },
  },
};

/** Rows whose schema-built params cannot make a first call succeed on the bare seed — a param
 *  naming something the walk has no value for — run their recipes instead of that case. */
const RECIPES_ONLY: ReadonlySet<string> = new Set(['grant_capability', 'connect_gatekeeper']);

interface Declared {
  readonly capability: Capability;
  readonly repeat: string;
  /** The recipe case this is, or undefined for schema-built params on the bare seed. */
  readonly recipe?: string;
}

function declaredRows(): Declared[] {
  const matrix = parse(readFileSync(MATRIX, 'utf8')) as {
    capabilities: Record<string, { repeat?: string }>;
  };
  const out: Declared[] = [];
  for (const [name, row] of Object.entries(matrix.capabilities)) {
    if (row.repeat === undefined || row.repeat.startsWith('unclear:')) continue;
    const capability = getCapability(name);
    if (capability === undefined) throw new Error(`matrix row ${name} has no capability`);
    const recipes = Object.keys(RECIPES[name] ?? {});
    if (RECIPES_ONLY.has(name) && recipes.length === 0) {
      throw new Error(`matrix row ${name} runs its recipes only, and has none`);
    }
    if (!RECIPES_ONLY.has(name)) out.push({ capability, repeat: row.repeat });
    for (const recipe of recipes) {
      out.push({ capability, repeat: row.repeat, recipe });
    }
  }
  return out;
}

/** The entity a result names: its own `id`, or the `id` of its one object-valued field. */
function entityId(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  const nested = Object.values(record).filter(
    (value): value is Record<string, unknown> =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { id?: unknown }).id === 'string',
  );
  return nested.length === 1 ? (nested[0]?.id as string) : undefined;
}

interface AuditRow {
  readonly id: string;
  readonly action: string;
  readonly actor_principal_id: string | null;
  readonly payload: Record<string, unknown>;
}

describe.runIf(DATABASE_URL !== undefined)(
  'a second identical call does what capability-matrix.yaml says — batch D4 / G6 (integration, real Postgres)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool?.end();
    });

    async function rowsBut(workspaceId: string): Promise<Record<string, string>> {
      const { audit_records: _audit, ...rest } = await workspaceDigest(pool, workspaceId);
      return rest;
    }

    async function auditRows(workspaceId: string): Promise<AuditRow[]> {
      const result = await pool.query<AuditRow>(
        'select id, action, actor_principal_id, payload from audit_records where workspace_id = $1',
        [workspaceId],
      );
      return result.rows;
    }

    const declared = declaredRows();

    it('the matrix declares some rows (the walk is not empty)', () => {
      expect(declared.length).toBeGreaterThan(0);
    });

    it.each(
      declared.map(
        (row) =>
          [
            row.recipe === undefined
              ? row.capability.name
              : `${row.capability.name} — ${row.recipe}`,
            row,
          ] as const,
      ),
    )('%s', async (_name, { capability, repeat, recipe }) => {
      expect(capability.scope, 'a platform row needs a platform fixture first').not.toBe(
        'platform',
      );
      const workspace = await newWorkspace(pool, `repeat-${capability.name}`, ['owner', 'member']);
      const ownerId = workspace.principals.get('owner') as string;
      const seed = await seedWorkspace(
        pool,
        workspace.workspaceId,
        ownerId,
        `repeat-${randomUUID()}`,
      );
      const caller = humanCaller(workspace.workspaceId, ownerId, 'owner');
      const chosen = recipe === undefined ? undefined : RECIPES[capability.name]?.[recipe];
      const params =
        chosen === undefined
          ? paramsFor(capability.paramsSchema, seed)
          : await chosen.setUp({
              pool,
              caller,
              seed,
              memberId: workspace.principals.get('member') as string,
            });
      const call = () => dispatchCapability({ pool }, caller, capability.name, params);

      let first: unknown;
      try {
        first = await call();
      } catch (error) {
        throw new Error(
          `${capability.name} declares repeat: ${repeat}, but its first call failed (${String(error)}) — fix the recipe or add one to RECIPES, or declare it unclear`,
        );
      }
      if (chosen?.first !== undefined) expect(first).toEqual(chosen.first);
      const rowsAfterFirst = await rowsBut(workspace.workspaceId);
      const auditAfterFirst = new Set(
        (await auditRows(workspace.workspaceId)).map((row) => row.id),
      );

      let second: unknown;
      let refusal: unknown;
      try {
        second = await call();
      } catch (error) {
        refusal = error;
      }
      const rowsAfterSecond = await rowsBut(workspace.workspaceId);
      const newAudit = (await auditRows(workspace.workspaceId)).filter(
        (row) => !auditAfterFirst.has(row.id),
      );

      if (repeat.startsWith('conflict: ')) {
        expect(refusal, 'the second call must be refused').toBeDefined();
        const mapped = mapCapabilityError(refusal);
        expect(mapped.code).toBe(repeat.slice('conflict: '.length));
        expect(mapped.status).toBeGreaterThanOrEqual(400);
        expect(mapped.status).toBeLessThan(500);
        expect(rowsAfterSecond).toEqual(rowsAfterFirst);
        expect(newAudit.filter((row) => row.payload.outcome !== 'refused')).toEqual([]);
        return;
      }

      expect(refusal, 'the second call must succeed').toBeUndefined();
      if (repeat === 'idempotent') {
        const firstId = entityId(first);
        if (firstId !== undefined) expect(entityId(second)).toBe(firstId);
        expect(rowsAfterSecond).toEqual(rowsAfterFirst);
        expect(newAudit.map((row) => row.action)).toEqual([capability.name]);
        expect(newAudit[0]?.actor_principal_id).toBe(ownerId);
      } else if (repeat === 'creates') {
        const firstId = entityId(first);
        expect(firstId, 'creates: the result names the entity it made').toBeDefined();
        expect(entityId(second)).not.toBe(firstId);
        // A new id with nothing stored for it would not be a second entity (per #488).
        expect(rowsAfterSecond).not.toEqual(rowsAfterFirst);
      } else if (repeat === 'repeats') {
        const firstId = entityId(first);
        expect(firstId, 'repeats: the result names the entity it acted on').toBeDefined();
        expect(entityId(second)).toBe(firstId);
        expect(rowsAfterSecond).not.toEqual(rowsAfterFirst);
      } else {
        throw new Error(`unknown repeat declaration ${repeat} (guard M6 should have refused it)`);
      }
    });
  },
);
