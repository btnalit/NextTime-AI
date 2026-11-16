import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
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
import {
  recordSourceObservation,
  registerPrivateSource,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { dispatchCapability } from './dispatch.js';
import { DecisionReferenceError } from './handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Legacy 308 (integration, real Postgres; auto-skip without DATABASE_URL): `record_decision`
 * relates a Decision only to Facts its caller can read. An id that names no Fact, a Fact from
 * another person's private Source, and the `exposes` Fact of someone else's Operation draft are
 * refused alike — 400 `unresolved_references` listing them, and no Decision written — while a
 * Fact the caller can read is accepted whatever its status (an invalidated one still exists).
 * The rule is the caller's own visibility: the draft's proposer relates its draft's Fact.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

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

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 308 — record_decision relates only Facts its caller can read (integration, real Postgres)',
  () => {
    let pool: Pool;
    const store = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let proposerId: string;

    let publishedExposesFactId: string;
    let draftExposesFactId: string;
    let proposersPrivateFactId: string;
    let invalidatedOwnFactId: string;
    const suffix = randomUUID().slice(0, 8);

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
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

    function humanCaller(principalId: string): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId,
          id: principalId,
          kind: 'human',
          role: 'member',
          displayName: null,
        },
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

    /** The principal's entry agent in the middle of a Turn: a real `entry` session, a Chat, and a
     *  Turn started the way the console starts one (`send_chat_message`). */
    async function entryAgentInTurn(
      principalId: string,
    ): Promise<{ caller: ResolvedCaller; turnId: string }> {
      const sid = await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'entry', $2, 'active') returning id`,
          [workspaceId, principalId],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('test setup: no session');
        return id;
      });
      const human = humanCaller(principalId);
      const chat = (await dispatchCapability({ pool }, human, 'new_chat', {})) as { id: string };
      const { turnId } = (await dispatchCapability({ pool }, human, 'send_chat_message', {
        chatId: chat.id,
        text: 'hi',
      })) as { turnId: string };
      const now = Math.floor(Date.now() / 1000);
      return {
        caller: {
          channel: 'handle',
          claims: {
            ws: workspaceId,
            sid,
            obo: principalId,
            scope: { capabilities: ['record_decision'], resources: {} },
            jti: randomUUID(),
            iat: now,
            exp: now + 600,
          },
        },
        turnId,
      };
    }

    /** A Fact observed through `owner`'s private Source — readable to that principal alone. */
    async function privateFact(owner: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: owner }, async (client) => {
        const host = await store.upsertObject(client, workspaceId, {
          objectType: 'test.host',
          identity: { hostname: `r308-${randomUUID()}` },
        });
        const service = await store.upsertObject(client, workspaceId, {
          objectType: 'test.service',
          identity: { name: `r308-svc-${randomUUID()}` },
        });
        const source = await registerPrivateSource(client, workspaceId, {
          kind: 'test.collector',
          ownerPrincipalId: owner,
        });
        const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
        await recordSourceObservation(client, workspaceId, {
          sourceId: source.id,
          activityId: activity.id,
        });
        const fact = await store.assertFact(
          client,
          workspaceId,
          { id: owner, kind: 'human' },
          {
            linkType: 'test.runs_on',
            sourceObjectId: service.id,
            targetObjectId: host.id,
            activityId: activity.id,
            properties: { port: 80 },
          },
        );
        return fact.id;
      });
    }

    async function exposesFactOf(gatekeeperId: string, name: string): Promise<string> {
      return admin(async (client) => {
        const operation = await getOperation(client, workspaceId, gatekeeperId, name);
        if (!operation) throw new Error(`test setup: Operation ${name} not found`);
        const result = await client.query<{ id: string }>(
          `select id from links
           where workspace_id = $1 and link_type = 'exposes' and target_object_id = $2
           order by recorded_at desc limit 1`,
          [workspaceId, operation.id],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error(`test setup: no exposes Fact for ${name}`);
        return id;
      });
    }

    async function decisionsOf(turnId: string): Promise<Array<{ rationale: unknown }>> {
      return admin(async (client) => {
        const result = await client.query<{ rationale: unknown }>(
          'select rationale from decisions where workspace_id = $1 and activity_id = $2',
          [workspaceId, turnId],
        );
        return result.rows;
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
            'record-decision-references-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      memberId = await insertPrincipal('member', 'member');
      proposerId = await insertPrincipal('member', 'proposer');

      const inTx = <T>(fn: (client: PoolClient) => Promise<T>) =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
      const activity = await inTx((client) =>
        startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        }),
      );
      const { gatekeeperId } = await inTx((client) =>
        registerGatekeeper(client, workspaceId, {
          name: `r308-gate-${suffix}`,
          transportKind: 'http',
          target: 'record-decision-references-test-system',
          endpoint: `https://gate-${randomUUID()}.record-decision-test.invalid`,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      const publishedName = `r308.published.${suffix}`;
      const draftName = `r308.draft.${suffix}`;
      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [testOperation(publishedName)],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        }),
      );
      await inTx((client) =>
        publishOperation(client, workspaceId, { gatekeeperId, name: publishedName }),
      );
      // The proposer's Worker proposal: a draft only its proposer and reviewers see.
      await withWorkspace(pool, { workspaceId, principalId: proposerId }, (client) =>
        proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: testOperation(draftName),
          proposedBy: { id: proposerId, kind: 'agent' },
          activityId: activity.id,
        }),
      );
      publishedExposesFactId = await exposesFactOf(gatekeeperId, publishedName);
      draftExposesFactId = await exposesFactOf(gatekeeperId, draftName);
      proposersPrivateFactId = await privateFact(proposerId);
      invalidatedOwnFactId = await privateFact(memberId);
      await withWorkspace(pool, { workspaceId, principalId: memberId }, (client) =>
        store.invalidateFact(
          client,
          workspaceId,
          { id: memberId, kind: 'human' },
          { factId: invalidatedOwnFactId, reason: 'gone' },
        ),
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('refuses ids that name no Fact, or a Fact the caller cannot read, alike — and records nothing', async () => {
      const { caller, turnId } = await entryAgentInTurn(memberId);
      const unknownId = randomUUID();
      const refused = await dispatchCapability({ pool }, caller, 'record_decision', {
        summary: 'restart the service',
        relatedFactIds: [
          publishedExposesFactId,
          unknownId,
          draftExposesFactId,
          proposersPrivateFactId,
          unknownId.toUpperCase(),
        ],
      }).catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(DecisionReferenceError);
      const error = refused as DecisionReferenceError;
      expect(error.code).toBe('unresolved_references');
      // Each once (in any case), as first sent, in the order sent; the readable one is not listed.
      expect(error.details.unresolved.relatedFactIds).toEqual([
        unknownId,
        draftExposesFactId,
        proposersPrivateFactId,
      ]);
      expect(error.message).toContain('names 3 Facts that are not there or not readable to you');
      expect(await decisionsOf(turnId)).toEqual([]);
    });

    it('records a Decision on Facts the caller can read, an invalidated one included', async () => {
      const { caller, turnId } = await entryAgentInTurn(memberId);
      const recorded = (await dispatchCapability({ pool }, caller, 'record_decision', {
        summary: 'keep the old host',
        // The same Fact again in upper case: one id, checked once, as Postgres reads it.
        relatedFactIds: [
          publishedExposesFactId,
          invalidatedOwnFactId,
          publishedExposesFactId.toUpperCase(),
        ],
      })) as { id: string; turnId: string };
      expect(recorded.turnId).toBe(turnId);
      expect(await decisionsOf(turnId)).toEqual([
        {
          rationale: {
            relatedFactIds: [
              publishedExposesFactId,
              invalidatedOwnFactId,
              publishedExposesFactId.toUpperCase(),
            ],
            relatedTaskId: null,
          },
        },
      ]);
    });

    it('reads with the caller’s own visibility: the proposer relates its draft’s Fact and its private Fact', async () => {
      const { caller, turnId } = await entryAgentInTurn(proposerId);
      await dispatchCapability({ pool }, caller, 'record_decision', {
        summary: 'publish the draft next week',
        relatedFactIds: [draftExposesFactId, proposersPrivateFactId],
      });
      expect(await decisionsOf(turnId)).toHaveLength(1);
    });
  },
);
