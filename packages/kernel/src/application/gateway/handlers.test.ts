import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import type { AgentRuntime, StartTurnInput } from '../host-bridge/index.js';
import { hashApiKey } from './auth.js';
import { dispatchCapability } from './dispatch.js';
import { setAgentRuntimeForHandlers } from './handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for the S1.4 chat and
 * entry-agent capability handlers wired in this module's handlers.ts (docs/development-tasks.md
 * S1.4 deliverables 2 and 6), exercised through `dispatchCapability` directly (not through
 * `interfaces/http`, which is out of this task's ownership — see interfaces/ws/server.test.ts for
 * the WS-transport equivalent of the same handlers).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role = 'member',
): ResolvedCaller {
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

describe.runIf(DATABASE_URL !== undefined)(
  'gateway/handlers — S1.4 chat + entry-agent (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let otherId: string;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(displayName: string, apiKey?: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
           values ($1, $2, 'human', 'member', $3, $4)`,
            [workspaceId, id, displayName, apiKey ? hashApiKey(apiKey) : null],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('gateway-handlers-s1-4-test');
      ownerId = await adminInsertPrincipal('owner');
      otherId = await adminInsertPrincipal('other');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('new_chat -> send_chat_message -> get_chat_history round-trip through dispatchCapability, with audit records', async () => {
      const caller = humanCaller(workspaceId, ownerId);

      const chat = (await dispatchCapability({ pool }, caller, 'new_chat', { title: 't' })) as {
        id: string;
      };
      expect(chat.id).toBeTruthy();

      const sendResult = (await dispatchCapability({ pool }, caller, 'send_chat_message', {
        chatId: chat.id,
        text: 'hello from a handler test',
      })) as { messageId: string; sequence: number; turnId: string };
      expect(sendResult.sequence).toBe(1);

      const list = (await dispatchCapability({ pool }, caller, 'list_chats', {})) as {
        id: string;
      }[];
      expect(list.some((c) => c.id === chat.id)).toBe(true);

      const history = (await dispatchCapability({ pool }, caller, 'get_chat_history', {
        chatId: chat.id,
      })) as { messages: { text: string; role: string }[] };
      expect(history.messages).toHaveLength(1);
      expect(history.messages[0]).toMatchObject({
        role: 'user',
        text: 'hello from a handler test',
      });

      const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, { action: 'send_chat_message', resourceId: chat.id }),
      );
      expect(audit).toHaveLength(1);
    });

    it('a second send_chat_message while running throws — dispatchCapability surfaces the error (§9.4)', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const chat = (await dispatchCapability({ pool }, caller, 'new_chat', {})) as { id: string };
      await dispatchCapability({ pool }, caller, 'send_chat_message', {
        chatId: chat.id,
        text: 'one',
      });

      await expect(
        dispatchCapability({ pool }, caller, 'send_chat_message', { chatId: chat.id, text: 'two' }),
      ).rejects.toThrow();
    });

    it("a different principal cannot see or act on another user's private chat (isolation, G4)", async () => {
      const ownerCaller = humanCaller(workspaceId, ownerId);
      const otherCaller = humanCaller(workspaceId, otherId);
      const chat = (await dispatchCapability({ pool }, ownerCaller, 'new_chat', {})) as {
        id: string;
      };

      await expect(
        dispatchCapability({ pool }, otherCaller, 'get_chat_history', { chatId: chat.id }),
      ).rejects.toThrow();
      await expect(
        dispatchCapability({ pool }, otherCaller, 'send_chat_message', {
          chatId: chat.id,
          text: 'x',
        }),
      ).rejects.toThrow();

      const otherList = (await dispatchCapability({ pool }, otherCaller, 'list_chats', {})) as {
        id: string;
      }[];
      expect(otherList.some((c) => c.id === chat.id)).toBe(false);
    });

    it('subscribe_chat authorizes and audits without mutating anything', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const chat = (await dispatchCapability({ pool }, caller, 'new_chat', {})) as { id: string };

      const result = (await dispatchCapability({ pool }, caller, 'subscribe_chat', {
        chatId: chat.id,
      })) as { subscribed: boolean };
      expect(result.subscribed).toBe(true);

      const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, { action: 'subscribe_chat', resourceId: chat.id }),
      );
      expect(audit).toHaveLength(1);
    });

    it('stop_agent calls AgentRuntime.stopTurn for the running Turn, and is a safe no-op with none running', async () => {
      const stopped: string[] = [];
      const fakeRuntime: AgentRuntime = {
        startTurn: async (_input: StartTurnInput) => {},
        stopTurn: async (turnId: string) => {
          stopped.push(turnId);
        },
      };
      setAgentRuntimeForHandlers(fakeRuntime);

      const caller = humanCaller(workspaceId, ownerId);
      const chat = (await dispatchCapability({ pool }, caller, 'new_chat', {})) as { id: string };

      // No running Turn yet.
      const idleResult = (await dispatchCapability({ pool }, caller, 'stop_agent', {
        chatId: chat.id,
      })) as { stopped: boolean };
      expect(idleResult.stopped).toBe(false);
      expect(stopped).toHaveLength(0);

      const { turnId } = (await dispatchCapability({ pool }, caller, 'send_chat_message', {
        chatId: chat.id,
        text: 'hi',
      })) as { turnId: string };

      const runningResult = (await dispatchCapability({ pool }, caller, 'stop_agent', {
        chatId: chat.id,
      })) as { stopped: boolean };
      expect(runningResult.stopped).toBe(true);
      expect(stopped).toEqual([turnId]);
    });

    it('get_entry_context (Handle channel) returns S1 scope: empty approvals/tasks/precedents, recent facts', async () => {
      // dispatchCapability operates on an already-resolved ResolvedCaller (dispatch.test.ts's own
      // `humanCaller()` pattern for the human channel) — resolveCaller/verifyHandle's own signature
      // verification is S1.3/S1.9 scope, already covered there; this test only needs a
      // structurally-valid `claims` object, not a real signed token.
      const store = new SqlGraphStore();
      const factId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const a = await store.upsertObject(client, workspaceId, { objectType: 'test.entry-ctx' });
          const b = await store.upsertObject(client, workspaceId, { objectType: 'test.entry-ctx' });
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.run',
            principalId: ownerId,
          });
          const fact = await store.assertFact(
            client,
            workspaceId,
            { id: ownerId, kind: 'human' },
            {
              linkType: 'test.entry-ctx-rel',
              sourceObjectId: a.id,
              targetObjectId: b.id,
              activityId: activity.id,
            },
          );
          return fact.id;
        },
      );

      const caller: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: ownerId,
          scope: { capabilities: ['get_entry_context', 'report_turn'], resources: {} },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      };

      const context = (await dispatchCapability({ pool }, caller, 'get_entry_context', {})) as {
        pendingApprovals: unknown[];
        tasks: unknown[];
        facts: { id: string }[];
        precedents: unknown[];
      };

      expect(context.pendingApprovals).toEqual([]);
      expect(context.tasks).toEqual([]);
      expect(context.precedents).toEqual([]);
      expect(context.facts.some((f) => f.id === factId)).toBe(true);
    });

    it('report_turn ends the Turn with the summary in metadata, and is idempotent on a second call', async () => {
      const humanCallerForSend = humanCaller(workspaceId, ownerId);
      const chat = (await dispatchCapability({ pool }, humanCallerForSend, 'new_chat', {})) as {
        id: string;
      };
      const { turnId } = (await dispatchCapability(
        { pool },
        humanCallerForSend,
        'send_chat_message',
        {
          chatId: chat.id,
          text: 'hi',
        },
      )) as { turnId: string };

      const handleCaller: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: ownerId,
          scope: { capabilities: ['report_turn'], resources: {} },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      };

      const first = (await dispatchCapability({ pool }, handleCaller, 'report_turn', {
        turnId,
        summary: 'did the thing',
      })) as { turnId: string; status: string };
      expect(first.status).toBe('completed');

      const row = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{
            status: string;
            ended_at: Date;
            metadata: { summary: string };
          }>(
            'select status, ended_at, metadata from activities where workspace_id = $1 and id = $2',
            [workspaceId, turnId],
          );
          return result.rows[0];
        },
      );
      expect(row?.status).toBe('completed');
      expect(row?.metadata.summary).toBe('did the thing');
      const firstEndedAt = row?.ended_at;

      // Idempotent: reporting again does not throw and does not change ended_at.
      const second = (await dispatchCapability({ pool }, handleCaller, 'report_turn', {
        turnId,
        summary: 'did the thing (again)',
      })) as { status: string };
      expect(second.status).toBe('completed');

      const row2 = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ ended_at: Date }>(
            'select ended_at from activities where workspace_id = $1 and id = $2',
            [workspaceId, turnId],
          );
          return result.rows[0];
        },
      );
      expect(row2?.ended_at.getTime()).toBe(firstEndedAt?.getTime());
    });

    it("report_turn on a turn belonging to another principal's chat is rejected (not found, isolation)", async () => {
      const ownerCaller = humanCaller(workspaceId, ownerId);
      const chat = (await dispatchCapability({ pool }, ownerCaller, 'new_chat', {})) as {
        id: string;
      };
      const { turnId } = (await dispatchCapability({ pool }, ownerCaller, 'send_chat_message', {
        chatId: chat.id,
        text: 'hi',
      })) as { turnId: string };

      const otherHandleCaller: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: otherId,
          scope: { capabilities: ['report_turn'], resources: {} },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      };

      await expect(
        dispatchCapability({ pool }, otherHandleCaller, 'report_turn', {
          turnId,
          summary: 'not mine to report',
        }),
      ).rejects.toThrow();
    });

    // S2.11 deliverable 4: `Turn --generated--> Decision`.
    it('record_decision (Handle channel) records a Decision whose activity_id is the running Turn', async () => {
      const humanCallerForSend = humanCaller(workspaceId, ownerId);
      const chat = (await dispatchCapability({ pool }, humanCallerForSend, 'new_chat', {})) as {
        id: string;
      };
      const { turnId } = (await dispatchCapability(
        { pool },
        humanCallerForSend,
        'send_chat_message',
        { chatId: chat.id, text: 'hi' },
      )) as { turnId: string };

      const handleCaller: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: ownerId,
          scope: { capabilities: ['record_decision'], resources: {} },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      };

      const result = (await dispatchCapability({ pool }, handleCaller, 'record_decision', {
        summary: 'chose option A',
        relatedFactIds: [],
      })) as { id: string; status: string; turnId: string };
      expect(result.status).toBe('proposed');
      expect(result.turnId).toBe(turnId);

      const row = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const r = await client.query<{
            activity_id: string;
            summary: string;
            status: string;
            decided_by: string | null;
          }>(
            'select activity_id, summary, status, decided_by from decisions where workspace_id = $1 and id = $2',
            [workspaceId, result.id],
          );
          return r.rows[0];
        },
      );
      expect(row?.activity_id).toBe(turnId);
      expect(row?.summary).toBe('chose option A');
      expect(row?.status).toBe('proposed');
      expect(row?.decided_by).toBeNull();

      // Leave the Turn ended, so it cannot be mistaken for a still-running Turn by a later test.
      await dispatchCapability({ pool }, handleCaller, 'report_turn', {
        turnId,
        summary: 'done',
      });
    });

    it('record_decision with no running Turn is rejected (NoActiveTurnError)', async () => {
      // `otherId` never has a chat/Turn created for it anywhere in this file — used here
      // specifically so this test's outcome cannot depend on execution order against the Turn the
      // previous test created (and ended) for `ownerId`.
      const handleCaller: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: otherId,
          scope: { capabilities: ['record_decision'], resources: {} },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      };
      await expect(
        dispatchCapability({ pool }, handleCaller, 'record_decision', { summary: 'no turn' }),
      ).rejects.toThrow();
    });
  },
);

// -------------------------------------------------------------------------------------------
// S2.6 worker-definition-registry handlers + I16 graph-write-path guard (docs/development-
// tasks.md S2.6 deliverables 3-4: "Handle 通道 assert_fact(WorkerDefinition …) 403").
// -------------------------------------------------------------------------------------------

function handleCallerWithScope(
  workspaceId: string,
  onBehalfOf: string,
  capabilities: readonly string[],
): ResolvedCaller {
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo: onBehalfOf,
      scope: { capabilities: [...capabilities], resources: {} },
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'gateway/handlers — S2.6 worker-definition registry + I16 (integration, real Postgres)',
  () => {
    let pool: Pool;
    const graphStore = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(role: Role, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('gateway-handlers-s2-6-test');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      builderId = await adminInsertPrincipal('builder', 'builder');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('propose_worker_definition (handle channel) creates an owned draft', async () => {
      const caller = handleCallerWithScope(workspaceId, builderId, ['propose_worker_definition']);

      const result = (await dispatchCapability({ pool }, caller, 'propose_worker_definition', {
        kind: 'worker',
        definition: { systemPrompt: 'you are a worker' },
      })) as { id: string; version: number; status: string; proposedBy: string };

      expect(result.version).toBe(1);
      expect(result.status).toBe('draft');
      expect(result.proposedBy).toBe(builderId);
    });

    it('publish_worker_definition is rejected on the handle channel (I16, human-only)', async () => {
      const proposeCaller = handleCallerWithScope(workspaceId, builderId, [
        'propose_worker_definition',
      ]);
      const draft = (await dispatchCapability(
        { pool },
        proposeCaller,
        'propose_worker_definition',
        {
          kind: 'worker',
          definition: { systemPrompt: 'x' },
        },
      )) as { id: string; version: number };

      // No handle scope grants publish_worker_definition at all (it is channel:'human'-only and
      // therefore excluded from every valid Handle scope, governance/capability/handles.ts
      // assertValidScope) — a handle-channel caller is rejected regardless of claimed scope.
      const publishAttemptCaller = handleCallerWithScope(workspaceId, ownerId, [
        'publish_worker_definition',
      ]);
      await expect(
        dispatchCapability({ pool }, publishAttemptCaller, 'publish_worker_definition', {
          definitionId: draft.id,
          version: draft.version,
        }),
      ).rejects.toThrow();
    });

    it('publish_worker_definition (human channel, owner) publishes and projects a WorkerDefinition graph Object', async () => {
      const proposeCaller = handleCallerWithScope(workspaceId, builderId, [
        'propose_worker_definition',
      ]);
      const draft = (await dispatchCapability(
        { pool },
        proposeCaller,
        'propose_worker_definition',
        {
          kind: 'entry',
          definition: { systemPrompt: 'you are the entry agent', capabilities: ['get_object'] },
        },
      )) as { id: string; version: number };

      const published = (await dispatchCapability(
        { pool },
        humanCaller(workspaceId, ownerId, 'owner'),
        'publish_worker_definition',
        { definitionId: draft.id, version: draft.version },
      )) as { status: string; publishedBy: string };
      expect(published.status).toBe('published');
      expect(published.publishedBy).toBe(ownerId);

      const listed = (await dispatchCapability(
        { pool },
        handleCallerWithScope(workspaceId, ownerId, ['list_worker_definitions']),
        'list_worker_definitions',
        { kind: 'entry' },
      )) as { id: string }[];
      expect(listed.some((d) => d.id === draft.id)).toBe(true);

      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const objects = await graphStore.search(client, workspaceId, {
          query: '',
          objectType: 'WorkerDefinition',
        });
        expect(
          objects.some(
            (o) =>
              o.identityKey?.definitionId === draft.id && o.identityKey?.version === draft.version,
          ),
        ).toBe(true);
      });
    });

    it('deprecate_worker_definition is rejected on the handle channel (I16, human-only)', async () => {
      const proposeCaller = handleCallerWithScope(workspaceId, builderId, [
        'propose_worker_definition',
      ]);
      const draft = (await dispatchCapability(
        { pool },
        proposeCaller,
        'propose_worker_definition',
        {
          kind: 'worker',
          definition: { systemPrompt: 'x' },
        },
      )) as { id: string; version: number };
      await dispatchCapability(
        { pool },
        humanCaller(workspaceId, ownerId, 'owner'),
        'publish_worker_definition',
        {
          definitionId: draft.id,
          version: draft.version,
        },
      );

      await expect(
        dispatchCapability(
          { pool },
          handleCallerWithScope(workspaceId, ownerId, ['deprecate_worker_definition']),
          'deprecate_worker_definition',
          { definitionId: draft.id, version: draft.version },
        ),
      ).rejects.toThrow();
    });

    it('assert_fact(WorkerDefinition …) from the Handle channel is rejected 403 (I16 graph write path)', async () => {
      const proposeCaller = handleCallerWithScope(workspaceId, builderId, [
        'propose_worker_definition',
      ]);
      const draft = (await dispatchCapability(
        { pool },
        proposeCaller,
        'propose_worker_definition',
        {
          kind: 'worker',
          definition: { systemPrompt: 'x' },
        },
      )) as { id: string; version: number };
      await dispatchCapability(
        { pool },
        humanCaller(workspaceId, ownerId, 'owner'),
        'publish_worker_definition',
        { definitionId: draft.id, version: draft.version },
      );

      const workerDefinitionObjectId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const objects = await graphStore.search(client, workspaceId, {
            query: '',
            objectType: 'WorkerDefinition',
          });
          const match = objects.find(
            (o) =>
              o.identityKey?.definitionId === draft.id && o.identityKey?.version === draft.version,
          );
          if (!match) throw new Error('expected a projected WorkerDefinition Object');
          return match.id;
        },
      );

      const assertFactCaller = handleCallerWithScope(workspaceId, builderId, ['assert_fact']);
      await expect(
        dispatchCapability({ pool }, assertFactCaller, 'assert_fact', {
          objectId: workerDefinitionObjectId,
          linkType: 'test_link',
          value: 'anything',
        }),
      ).rejects.toMatchObject({ name: 'MetaOntologyWriteForbiddenError' });
    });

    it('assert_fact on a non-meta-ontology Object from the Handle channel is not blocked by I16 (falls through to the pre-existing not-implemented gap)', async () => {
      const plainObjectId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const object = await graphStore.upsertObject(client, workspaceId, {
            objectType: 'test.plain',
            properties: {},
          });
          return object.id;
        },
      );

      const assertFactCaller = handleCallerWithScope(workspaceId, builderId, ['assert_fact']);
      await expect(
        dispatchCapability({ pool }, assertFactCaller, 'assert_fact', {
          objectId: plainObjectId,
          linkType: 'test_link',
          value: 'anything',
        }),
      ).rejects.toMatchObject({ name: 'AssertFactWriteNotImplementedError' });
    });
  },
);
