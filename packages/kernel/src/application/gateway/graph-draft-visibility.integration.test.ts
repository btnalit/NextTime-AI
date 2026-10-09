import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Operation, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  getOperation,
  importManifest,
  proposeOperation,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/graph-draft-visibility.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) dispatch-level coverage of STATUS leftover 123 — the generic graph reads apply
 * D-26's Operation-draft rule. A draft Operation Object (someone else's `propose_operation`, or a
 * gate's imported manifest the owner proposed) is invisible to a member who did not propose it,
 * through `search`, `get_object`, `traverse` (nodes, nodeDetails, edges), `state_at`, `list_facts`
 * (items, nodeDetails), `explain`, `resolve_refs`, and the per-link-type counts of `graph_overview`
 * and `get_entry_context` (plus its recent Facts) — exactly like an id that does not exist.
 * Its proposer, builders and the owner see it. On the Handle channel the viewer is the Handle's
 * `obo` with that principal's role. Published Operations stay visible to everyone.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const GRAPH_READS = [
  'search',
  'get_object',
  'traverse',
  'state_at',
  'list_facts',
  'graph_overview',
  'explain',
  'get_entry_context',
] as const;

function testOperation(name: string): Operation {
  return {
    name,
    description: 'A test operation.',
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  };
}

interface WireObject {
  readonly id: string;
  readonly properties: Record<string, unknown>;
}
interface WireFact {
  readonly id: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
}

describe.runIf(DATABASE_URL !== undefined)(
  'leftover 123 — generic graph reads hide Operation drafts like D-26 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;
    let proposerId: string;
    let otherMemberId: string;

    let gatekeeperId: string;
    let publishedId: string;
    let memberDraftId: string;
    let importDraftId: string;
    let memberDraftExposesFactId: string;
    const suffix = randomUUID().slice(0, 8);
    const publishedName = `gvis.published.${suffix}`;
    const importDraftName = `gvis.import-draft.${suffix}`;
    const memberDraftName = `gvis.member-draft.${suffix}`;

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

    /** An agent Handle acting for `obo` — an entry agent or a Worker; the read is narrowed for that
     *  principal and their workspace role, looked up by the handler. */
    function handleCaller(obo: string): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      const scope: CapabilityScope = { capabilities: [...GRAPH_READS], resources: {} };
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo,
          scope,
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function insertPrincipal(role: Role, name: string): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
          [workspaceId, id, role, name],
        ),
      );
      return id;
    }

    async function operationObjectId(name: string): Promise<string> {
      const record = await inTx((client) => getOperation(client, workspaceId, gatekeeperId, name));
      if (!record) throw new Error(`test setup: Operation ${name} not found`);
      return record.id;
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
            'graph-draft-visibility-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      builderId = await insertPrincipal('builder', 'builder');
      proposerId = await insertPrincipal('member', 'proposer');
      otherMemberId = await insertPrincipal('member', 'other-member');

      const activity = await inTx((client) =>
        startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        }),
      );
      gatekeeperId = (
        await inTx((client) =>
          registerGatekeeper(client, workspaceId, {
            name: `gvis-gate-${suffix}`,
            transportKind: 'http',
            target: 'graph-draft-visibility-test-system',
            endpoint: `https://gate-${randomUUID()}.graph-visibility-test.invalid`,
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          }),
        )
      ).gatekeeperId;
      // A gate's own manifest: imported as owner-proposed drafts; one is published.
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [testOperation(publishedName), testOperation(importDraftName)],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        }),
      );
      await inTx((client) =>
        publishOperation(client, workspaceId, { gatekeeperId, name: publishedName }),
      );
      // A member's Worker proposal: proposedBy = the member the Task acts for.
      await withWorkspace(pool, { workspaceId, principalId: proposerId }, (client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation(memberDraftName),
          proposedBy: { id: proposerId, kind: 'agent' },
          activityId: activity.id,
        }),
      );

      publishedId = await operationObjectId(publishedName);
      importDraftId = await operationObjectId(importDraftName);
      memberDraftId = await operationObjectId(memberDraftName);
      memberDraftExposesFactId = await admin(async (client) => {
        const result = await client.query<{ id: string }>(
          `select id from links
           where workspace_id = $1 and link_type = 'exposes' and target_object_id = $2
           order by recorded_at desc limit 1`,
          [workspaceId, memberDraftId],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('test setup: no exposes Fact for the member draft');
        return id;
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    /** Which of the three Operation Objects each generic read reveals to `caller`. */
    async function visibleThrough(caller: ResolvedCaller) {
      const call = (name: string, params: Record<string, unknown>) =>
        dispatchCapability({ pool }, caller, name, params);
      const ids = [publishedId, importDraftId, memberDraftId];
      const at = new Date(Date.now() + 1000).toISOString();

      const searched = (await call('search', {
        query: `.${suffix}`,
        objectType: 'Operation',
      })) as { items: readonly WireObject[] };

      const got: string[] = [];
      for (const objectId of ids) {
        const object = (await call('get_object', { objectId })) as WireObject | null;
        if (object) got.push(object.id);
      }

      const walked = (await call('traverse', { fromId: gatekeeperId, depth: 1 })) as {
        nodes: readonly string[];
        edges: readonly { sourceObjectId: string; targetObjectId: string }[];
        nodeDetails: readonly { id: string }[];
      };

      const stateAt: string[] = [];
      for (const objectId of ids) {
        const state = (await call('state_at', { objectId, at })) as {
          object: WireObject | null;
          facts: readonly WireFact[];
        };
        if (state.object) stateAt.push(state.object.id);
        // A hidden Object has no Facts either (each one touches it) — same as an unknown id.
        if (!state.object) expect(state.facts).toEqual([]);
      }
      const gateState = (await call('state_at', { objectId: gatekeeperId, at })) as {
        facts: readonly WireFact[];
      };

      const listed = (await call('list_facts', { linkType: 'exposes' })) as {
        items: readonly WireFact[];
        nodeDetails: readonly { id: string }[];
      };

      return {
        search: searched.items.map((item) => item.id).sort(),
        getObject: got.sort(),
        traverseNodes: walked.nodes.filter((id) => ids.includes(id)).sort(),
        traverseDetails: walked.nodeDetails
          .map((node) => node.id)
          .filter((id) => ids.includes(id))
          .sort(),
        traverseEdgeTargets: walked.edges
          .flatMap((edge) => [edge.sourceObjectId, edge.targetObjectId])
          .filter((id) => ids.includes(id))
          .filter((id, index, all) => all.indexOf(id) === index)
          .sort(),
        stateAt: stateAt.sort(),
        gateFactTargets: gateState.facts
          .map((fact) => fact.targetObjectId)
          .filter((id) => ids.includes(id))
          .filter((id, index, all) => all.indexOf(id) === index)
          .sort(),
        listFactsTargets: listed.items
          .map((fact) => fact.targetObjectId)
          .filter((id) => ids.includes(id))
          .filter((id, index, all) => all.indexOf(id) === index)
          .sort(),
        listFactsDetails: listed.nodeDetails
          .map((node) => node.id)
          .filter((id) => ids.includes(id))
          .sort(),
      };
    }

    function expectEverywhere(
      seen: Awaited<ReturnType<typeof visibleThrough>>,
      expected: readonly string[],
    ) {
      const sorted = [...expected].sort();
      expect(seen.search).toEqual(sorted);
      expect(seen.getObject).toEqual(sorted);
      expect(seen.traverseNodes).toEqual(sorted);
      expect(seen.traverseDetails).toEqual(sorted);
      expect(seen.traverseEdgeTargets).toEqual(sorted);
      expect(seen.stateAt).toEqual(sorted);
      expect(seen.gateFactTargets).toEqual(sorted);
      expect(seen.listFactsTargets).toEqual(sorted);
      expect(seen.listFactsDetails).toEqual(sorted);
    }

    it('another member sees only the published Operation, through every graph read', async () => {
      expectEverywhere(await visibleThrough(humanCaller(otherMemberId, 'member')), [publishedId]);
    });

    it('the proposer sees the published Operation plus their own draft, not the import draft', async () => {
      expectEverywhere(await visibleThrough(humanCaller(proposerId, 'member')), [
        publishedId,
        memberDraftId,
      ]);
    });

    it('builder and owner see every draft', async () => {
      for (const [principalId, role] of [
        [builderId, 'builder'],
        [ownerId, 'owner'],
      ] as const) {
        expectEverywhere(await visibleThrough(humanCaller(principalId, role)), [
          publishedId,
          importDraftId,
          memberDraftId,
        ]);
      }
    });

    it('an agent Handle sees what the principal it acts for sees', async () => {
      expectEverywhere(await visibleThrough(handleCaller(otherMemberId)), [publishedId]);
      expectEverywhere(await visibleThrough(handleCaller(proposerId)), [
        publishedId,
        memberDraftId,
      ]);
      expectEverywhere(await visibleThrough(handleCaller(ownerId)), [
        publishedId,
        importDraftId,
        memberDraftId,
      ]);
    });

    it('traverse from a hidden draft returns nothing, like an unknown id', async () => {
      const fromDraft = (await dispatchCapability(
        { pool },
        humanCaller(otherMemberId, 'member'),
        'traverse',
        { fromId: memberDraftId, depth: 2 },
      )) as { nodes: readonly string[]; edges: readonly unknown[] };
      expect(fromDraft.nodes).toEqual([]);
      expect(fromDraft.edges).toEqual([]);

      const asProposer = (await dispatchCapability(
        { pool },
        humanCaller(proposerId, 'member'),
        'traverse',
        { fromId: memberDraftId, depth: 1 },
      )) as { nodes: readonly string[] };
      expect(asProposer.nodes).toContain(gatekeeperId);
    });

    it('explain on the exposes Fact of a hidden draft is not found; its proposer and reviewers explain it', async () => {
      for (const caller of [humanCaller(otherMemberId, 'member'), handleCaller(otherMemberId)]) {
        await expect(
          dispatchCapability({ pool }, caller, 'explain', { nodeId: memberDraftExposesFactId }),
        ).rejects.toMatchObject({ name: 'ExplainNodeNotFoundError' });
      }
      // The same error an id that names nothing gets.
      await expect(
        dispatchCapability({ pool }, humanCaller(otherMemberId, 'member'), 'explain', {
          nodeId: randomUUID(),
        }),
      ).rejects.toMatchObject({ name: 'ExplainNodeNotFoundError' });

      for (const caller of [
        humanCaller(proposerId, 'member'),
        humanCaller(builderId, 'builder'),
        handleCaller(ownerId),
      ]) {
        const explained = (await dispatchCapability({ pool }, caller, 'explain', {
          nodeId: memberDraftExposesFactId,
        })) as { nodeType: string; fact?: { targetObjectId: string } };
        expect(explained.nodeType).toBe('fact');
        expect(explained.fact?.targetObjectId).toBe(memberDraftId);
      }
    });

    it('resolve_refs does not name a hidden draft', async () => {
      const refsFor = async (principalId: string, role: Role) =>
        (
          (await dispatchCapability({ pool }, humanCaller(principalId, role), 'resolve_refs', {
            ids: [publishedId, memberDraftId],
          })) as { items: readonly { id: string }[] }
        ).items
          .map((item) => item.id)
          .sort();
      expect(await refsFor(otherMemberId, 'member')).toEqual([publishedId]);
      expect(await refsFor(proposerId, 'member')).toEqual([publishedId, memberDraftId].sort());
    });

    it("get_entry_context's recent Facts never name a hidden draft", async () => {
      const recentTargets = async (obo: string) =>
        (
          (await dispatchCapability({ pool }, handleCaller(obo), 'get_entry_context', {})) as {
            facts: readonly WireFact[];
          }
        ).facts.flatMap((fact) => [fact.sourceObjectId, fact.targetObjectId]);
      expect(await recentTargets(otherMemberId)).not.toContain(memberDraftId);
      expect(await recentTargets(otherMemberId)).not.toContain(importDraftId);
      expect(await recentTargets(proposerId)).toContain(memberDraftId);
    });

    it.each(['get_entry_context', 'graph_overview'] as const)(
      "%s's per-link-type counts do not count a hidden draft's Facts",
      async (capability) => {
        const exposesCount = async (obo: string) =>
          (
            (await dispatchCapability({ pool }, handleCaller(obo), capability, {})) as {
              factCountsByLinkType: readonly { linkType: string; count: number }[];
            }
          ).factCountsByLinkType.find((entry) => entry.linkType === 'exposes')?.count;
        // The gate exposes three Operations: one published, one import draft, one member draft.
        expect(await exposesCount(otherMemberId)).toBe(1);
        expect(await exposesCount(proposerId)).toBe(2);
        expect(await exposesCount(ownerId)).toBe(3);
      },
    );
  },
);
