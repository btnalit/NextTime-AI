import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FactWire } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { entryScope } from '../../governance/capability/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/entry-context-graph.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) regression for real-model round 4, where dependency_chat ("哪个服务依赖哪个") went
 * 0/10 with no code change. The entry agent's injected context was "the 20 most recent Facts",
 * a collector writes ~100 Facts per call with one shared `recorded_at`, and the one `depends_on`
 * edge was in that context only by chance — with no capability that lists Facts by link type,
 * an agent that did not happen to see it could not find it.
 *
 * This proves, without a model, the three things the fix guarantees through a real entry Handle
 * (the platform's own `entryScope` for a member):
 *   1. `get_entry_context` is deterministic under `recorded_at` ties and carries the complete
 *      per-link-type counts, so the `depends_on` edge is visible as a count even when no recent
 *      Fact names it;
 *   2. `list_facts({linkType:'depends_on'})` returns that edge with both endpoints named — the
 *      whole answer to the question, in one call, whatever the recent sample holds;
 *   3. pagination over a tie group neither skips nor repeats a Fact, and a link type the graph
 *      does not hold comes back empty (the agent's cue to say there is no such data).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** How the host-inventory collector's phase 3 looks: one call, one transaction, many Facts. */
const BATCH_SERVICES = 40;
/** Written in a later transaction, so every one is newer than the collector batch. */
const LATER_FACTS = 25;

interface NodeDetail {
  readonly id: string;
  readonly typeName: string;
  readonly name?: string;
}
interface ListFactsResult {
  readonly items: readonly FactWire[];
  readonly nodeDetails: readonly NodeDetail[];
  readonly nextCursor?: string;
  readonly truncated?: true;
}
interface EntryContext {
  readonly facts: readonly FactWire[];
  readonly factCountsByLinkType: readonly { linkType: string; count: number }[];
}

describe.runIf(DATABASE_URL !== undefined)(
  'real-model round 4 — entry context and list_facts answer a relationship question deterministically (integration, real Postgres)',
  () => {
    const store = new SqlGraphStore();
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let kernelId: string;
    let postgresId: string;
    let dependsOnFactId: string;
    const batchFactIds: string[] = [];
    const laterFactIds: string[] = [];

    /** An entry agent's Handle acting for `obo`, carrying exactly the scope the platform issues
     *  an entry Handle for a member — so a capability missing from the entry ceiling 403s here. */
    function entryHandle(obo: string): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo,
          scope: entryScope({}, { role: 'member' }),
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    const call = <T>(name: string, params: Record<string, unknown>) =>
      dispatchCapability({ pool }, entryHandle(memberId), name, params) as Promise<T>;

    async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function container(client: PoolClient, serviceName: string) {
      return store.upsertObject(client, workspaceId, {
        objectType: 'Container',
        identity: { composeProjectId: '00000000-0000-4000-8000-000000000001', serviceName },
        properties: { state: 'running' },
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      memberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'entry-context-graph-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, ownerId, memberId],
          );
        },
        { skipRoleSwitch: true },
      );

      // The collector batch: one transaction, so every Fact shares one `recorded_at`. The one
      // `depends_on` edge is asserted first, exactly as nothing in the write order favours it.
      await asOwner(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.collector_batch',
          principalId: ownerId,
        });
        const host = await store.upsertObject(client, workspaceId, {
          objectType: 'Host',
          identity: { hostname: 'host-1' },
        });
        const kernel = await container(client, 'kernel');
        const postgres = await container(client, 'postgres');
        kernelId = kernel.id;
        postgresId = postgres.id;
        const assert = async (linkType: string, sourceObjectId: string, targetObjectId: string) => {
          const fact = await store.assertFact(
            client,
            workspaceId,
            { id: ownerId, kind: 'human' },
            { linkType, sourceObjectId, targetObjectId, activityId: activity.id },
          );
          batchFactIds.push(fact.id);
          return fact.id;
        };
        dependsOnFactId = await assert('depends_on', kernel.id, postgres.id);
        await assert('runs_on', kernel.id, host.id);
        await assert('runs_on', postgres.id, host.id);
        for (let index = 0; index < BATCH_SERVICES; index += 1) {
          const service = await container(client, `svc-${index}`);
          await assert('runs_on', service.id, host.id);
        }
      });

      // Later writes: newer than the whole batch, so the recent window holds none of it.
      await asOwner(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.later_writes',
          principalId: ownerId,
        });
        for (let index = 0; index < LATER_FACTS; index += 1) {
          const a = await container(client, `later-a-${index}`);
          const b = await container(client, `later-b-${index}`);
          const fact = await store.assertFact(
            client,
            workspaceId,
            { id: ownerId, kind: 'human' },
            {
              linkType: 'attached_to',
              sourceObjectId: a.id,
              targetObjectId: b.id,
              activityId: activity.id,
            },
          );
          laterFactIds.push(fact.id);
        }
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('precondition: the collector batch shares one recorded_at — the tie the old query left unordered', async () => {
      const distinct = await asOwner(async (client) => {
        const result = await client.query<{ n: number }>(
          'select count(distinct recorded_at)::int as n from links where workspace_id = $1 and id = any($2::uuid[])',
          [workspaceId, batchFactIds],
        );
        return result.rows[0]?.n;
      });
      expect(batchFactIds).toHaveLength(BATCH_SERVICES + 3);
      expect(distinct).toBe(1);
    });

    it('get_entry_context: the recent sample is deterministic and the counts show every link type', async () => {
      const first = await call<EntryContext>('get_entry_context', {});
      const second = await call<EntryContext>('get_entry_context', {});

      // The later writes share one recorded_at too, so which 20 of the 25 come back is decided by
      // the tiebreaker alone: the 20 largest ids. Without it, the pick is whatever the sort returns.
      expect(first.facts.map((fact) => fact.id)).toEqual(
        [...laterFactIds].sort().reverse().slice(0, 20),
      );
      expect(second.facts.map((fact) => fact.id)).toEqual(first.facts.map((fact) => fact.id));
      // The sample holds none of the collector batch — it cannot answer the question by itself...
      expect(first.facts.map((fact) => fact.id)).not.toContain(dependsOnFactId);
      // ...but the overview says a depends_on edge exists, and how many of each type there are.
      expect(first.factCountsByLinkType).toEqual([
        { linkType: 'attached_to', count: LATER_FACTS },
        { linkType: 'depends_on', count: 1 },
        { linkType: 'runs_on', count: BATCH_SERVICES + 2 },
      ]);
    });

    it('graph_overview returns the same counts on their own, through the same entry Handle', async () => {
      const overview = await call<{ factCountsByLinkType: EntryContext['factCountsByLinkType'] }>(
        'graph_overview',
        {},
      );
      const context = await call<EntryContext>('get_entry_context', {});
      expect(overview).toEqual({ factCountsByLinkType: context.factCountsByLinkType });
    });

    it('list_facts answers "哪个服务依赖哪个" in one call, naming both endpoints', async () => {
      const result = await call<ListFactsResult>('list_facts', { linkType: 'depends_on' });

      expect(result.items.map((fact) => fact.id)).toEqual([dependsOnFactId]);
      expect(result.items[0]).toMatchObject({
        linkType: 'depends_on',
        sourceObjectId: kernelId,
        targetObjectId: postgresId,
      });
      expect(result.nodeDetails).toEqual([
        { id: kernelId, typeName: 'Container', name: 'kernel' },
        { id: postgresId, typeName: 'Container', name: 'postgres' },
      ]);
      expect(result.nextCursor).toBeUndefined();
    });

    it('list_facts pages through a recorded_at tie group without skipping or repeating a Fact', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page: ListFactsResult = await call<ListFactsResult>('list_facts', {
          linkType: 'runs_on',
          limit: 7,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map((fact) => fact.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 20);

      const expected = batchFactIds.filter((id) => id !== dependsOnFactId);
      expect(seen).toHaveLength(expected.length);
      expect(new Set(seen).size).toBe(expected.length);
      expect([...seen].sort()).toEqual([...expected].sort());
      // One tie group, so the order is the tiebreaker's: id descending.
      expect(seen).toEqual([...expected].sort().reverse());
    });

    it('list_facts for a link type the graph does not hold is empty, and an oversized limit is clamped and flagged', async () => {
      const none = await call<ListFactsResult>('list_facts', { linkType: 'replicates_to' });
      expect(none).toEqual({ items: [], nodeDetails: [] });

      const clamped = await call<ListFactsResult>('list_facts', {
        linkType: 'runs_on',
        limit: 10_000,
      });
      expect(clamped.items).toHaveLength(BATCH_SERVICES + 2);
      expect(clamped.truncated).toBe(true);
    });

    // Last: it changes the graph the tests above read.
    it('an invalidated Fact leaves list_facts and the counts — both describe only active Facts', async () => {
      await asOwner((client) =>
        store.invalidateFact(
          client,
          workspaceId,
          { id: ownerId, kind: 'human' },
          { factId: dependsOnFactId, reason: 'test' },
        ),
      );

      const listed = await call<ListFactsResult>('list_facts', { linkType: 'depends_on' });
      expect(listed).toEqual({ items: [], nodeDetails: [] });
      const context = await call<EntryContext>('get_entry_context', {});
      expect(context.factCountsByLinkType.map((entry) => entry.linkType)).toEqual([
        'attached_to',
        'runs_on',
      ]);
    });
  },
);
