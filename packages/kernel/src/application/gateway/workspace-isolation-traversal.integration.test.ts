import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_REGISTRY, type Capability } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';
import {
  type Seeded,
  humanCaller,
  newWorkspace,
  paramsFor,
  seedWorkspace,
  seededIds,
} from './traversal-fixture.js';

/**
 * Batch D1 (docs/test-coverage-gaps-2026-11-06.md §6, gap G12): what workspace A holds never
 * reaches workspace B through any read. Isolation is a design floor ("隔离与审计只增不减") and RLS
 * is where it is enforced, but nothing walked every read a B member can make and looked for A's
 * data in the answer — 37 test files touch cross-workspace cases, each for its own feature.
 *
 * The invariant, over the whole registry rather than per capability: workspace A gets one of each
 * kind of row a read could return (objects of several types, a chat, an action request), every
 * one carrying a marker string in what a reader would see. Then B's owner — the widest role —
 * calls every workspace `observe` capability through `dispatchCapability`, with params built from
 * the capability's own schema and every id-shaped field pointed at A's rows. Whatever comes back
 * must name neither the marker, nor A's workspace id, nor any of A's row ids. A call may fail (an
 * unknown id, a param the builder could not satisfy) — failing is not leaking — but enough must
 * succeed that the walk proves something, so the count of answered reads is asserted too.
 *
 * A new `observe` capability is walked the moment it is registered; nothing here names one.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Below this, the walk answered too few reads to mean anything (98 workspace reads today, 56 of
 *  them without required params). */
const MIN_ANSWERED = 50;

/** Every read a workspace member can make; platform reads are a different trust boundary. */
const WORKSPACE_READS = CAPABILITY_REGISTRY.filter(
  (capability: Capability) => capability.mode === 'observe' && capability.scope !== 'platform',
);

describe.runIf(DATABASE_URL !== undefined)(
  'workspace isolation over every read — batch D1 / G12 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let a: Seeded;
    let workspaceB: string;
    let ownerIdB: string;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const marker = `leak-marker-${randomUUID()}`;
      const workspaceA = await newWorkspace(pool, `isolation-a ${marker}`);
      const ownerIdA = workspaceA.principals.get('owner') as string;
      a = await seedWorkspace(pool, workspaceA.workspaceId, ownerIdA, marker);

      const b = await newWorkspace(pool, 'isolation-b');
      workspaceB = b.workspaceId;
      ownerIdB = b.principals.get('owner') as string;
    });

    afterAll(async () => {
      await pool?.end();
    });

    /** Calls every workspace read as `caller`, with `paramsOf`'s params; returns which reads
     *  answered and which answers named any of `forbidden`. */
    async function walk(
      caller: ResolvedCaller,
      paramsOf: (capability: Capability) => Record<string, unknown>,
      forbidden: readonly string[],
    ): Promise<{ answered: Set<string>; hits: string[] }> {
      const answered = new Set<string>();
      const hits: string[] = [];
      for (const capability of WORKSPACE_READS) {
        const params = paramsOf(capability);
        let result: unknown;
        try {
          result = await dispatchCapability({ pool }, caller, capability.name, params);
        } catch {
          continue; // refused, or params the builder could not satisfy — not a leak
        }
        answered.add(capability.name);
        const text = JSON.stringify(result) ?? '';
        for (const value of forbidden) {
          if (text.includes(value))
            hits.push(`${capability.name}(${JSON.stringify(params)}) → ${value}`);
        }
      }
      return { answered, hits };
    }

    const byId = (capability: Capability): Record<string, unknown> =>
      paramsFor(capability.paramsSchema, a);

    it("the same walk, as A's own owner, finds A's rows — the seed is reachable and the check bites", async () => {
      const ownerA = humanCaller(a.workspaceId, a.ownerId, 'owner');
      const listed = await walk(ownerA, () => ({}), [a.marker]);
      const fetched = await walk(ownerA, byId, [a.marker]);
      const found = new Set([...listed.hits, ...fetched.hits].map((hit) => hit.split('(')[0]));
      // Lists and by-id reads alike: the chat, the gate, the Operation and the request each surface.
      for (const name of [
        'list_chats',
        'list_gatekeepers',
        'list_pending',
        'get_object',
        'get_action',
      ]) {
        expect(found).toContain(name);
      }
    });

    it("no read a B owner can make answers with anything of A's", async () => {
      const ownerB = humanCaller(workspaceB, ownerIdB, 'owner');
      // Pass 1, no params: nothing B asked for names A, so none of A's ids may come back either.
      const listed = await walk(ownerB, () => ({}), [a.marker, a.workspaceId, ...seededIds(a)]);
      // Pass 2, every id-shaped param pointed at A's rows. Each B call is itself audited in B with
      // its params (dispatch.ts), so B's own audit reads now echo A's ids back — that is B's record
      // of what B asked, not A's data. A's data is what carries the marker, which no param ever
      // holds (free-text params get the fixture's PROBE), and A's workspace id, which no param names.
      const fetched = await walk(ownerB, byId, [a.marker, a.workspaceId]);

      expect([...listed.hits, ...fetched.hits]).toEqual([]);
      expect(new Set([...listed.answered, ...fetched.answered]).size).toBeGreaterThanOrEqual(
        MIN_ANSWERED,
      );
    });
  },
);
