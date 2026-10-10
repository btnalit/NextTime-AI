import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { insertPendingContextItem } from '../linkage/index.js';
import { dispatchCapability } from './dispatch.js';
import { TurnNotFoundError } from './handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for `get_entry_context` /
 * `report_turn` delivery (2026-10-02 review R-57, maintainer decision D-23), through
 * `dispatchCapability`:
 *   - with a `turnId`, every call of the Turn returns the same items, and `report_turn` for it
 *     acknowledges them;
 *   - a Chat only sees its own items;
 *   - without a `turnId` an interactive / MCP session peeks (consumes nothing), while an entry
 *     session — an entry image built before `turnId` existed — is attributed to its running Turn.
 * Each test uses its own principal so the items of one test never show up in another.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

interface EntryContext {
  pendingApprovals: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
}

describe.runIf(DATABASE_URL !== undefined)(
  'gateway — get_entry_context leases per Turn, report_turn acknowledges (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let nextOutboxId = 5000;

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

    async function adminInsertPrincipal(): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'member', 'p')",
            [workspaceId, id],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    function humanCaller(principalId: string, role: Role = 'member'): ResolvedCaller {
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

    /** A Handle caller whose `sid` is a real `sessions` row of `kind` (`entry` for the resident
     *  entry container, `mcp_session` for an `issue_handle` interactive / MCP session). */
    async function handleCaller(
      principalId: string,
      kind: 'entry' | 'mcp_session',
    ): Promise<ResolvedCaller> {
      const sid = await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $2, 'active') returning id`,
          [workspaceId, principalId, kind],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('failed to insert session');
        return id;
      });
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid,
          obo: principalId,
          scope: {
            capabilities: ['get_entry_context', 'report_turn', 'record_decision'],
            resources: {},
          },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      };
    }

    async function newChatFor(principalId: string): Promise<string> {
      const chat = (await dispatchCapability(
        { pool },
        humanCaller(principalId),
        'new_chat',
        {},
      )) as {
        id: string;
      };
      return chat.id;
    }

    /** Starts a Turn the way the console does (`send_chat_message`). */
    async function startTurn(principalId: string, chatId: string): Promise<string> {
      const { turnId } = (await dispatchCapability(
        { pool },
        humanCaller(principalId),
        'send_chat_message',
        { chatId, text: 'hi' },
      )) as { turnId: string };
      return turnId;
    }

    async function insertTaskItem(principalId: string, chatId: string, taskId: string) {
      nextOutboxId += 1;
      await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        insertPendingContextItem(client, workspaceId, {
          principalId,
          chatId,
          kind: 'task_completed',
          subjectId: taskId,
          payload: { taskId, status: 'completed' },
          sourceOutboxId: String(nextOutboxId),
        }),
      );
    }

    async function getEntryContext(
      caller: ResolvedCaller,
      params: { turnId?: string } = {},
    ): Promise<EntryContext> {
      return (await dispatchCapability(
        { pool },
        caller,
        'get_entry_context',
        params,
      )) as EntryContext;
    }

    function taskIds(context: EntryContext): unknown[] {
      return context.tasks.map((item) => item.taskId);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('gateway-entry-context-test');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('two LLM calls (or a retry) of one Turn both see the batch; after report_turn it is gone', async () => {
      const principalId = await adminInsertPrincipal();
      const entry = await handleCaller(principalId, 'entry');
      const chatId = await newChatFor(principalId);
      const taskId = randomUUID();
      await insertTaskItem(principalId, chatId, taskId);
      const turnId = await startTurn(principalId, chatId);

      expect(taskIds(await getEntryContext(entry, { turnId }))).toEqual([taskId]);
      expect(taskIds(await getEntryContext(entry, { turnId }))).toEqual([taskId]);

      await dispatchCapability({ pool }, entry, 'report_turn', { turnId, summary: 'done' });

      expect(taskIds(await getEntryContext(entry, { turnId }))).toEqual([]);
      const nextTurnId = await startTurn(principalId, chatId);
      expect(taskIds(await getEntryContext(entry, { turnId: nextTurnId }))).toEqual([]);
    });

    it('stores what the agent reports — Turn summary, decisions, a recorded Decision — with secret-looking values scrubbed (legacy 183)', async () => {
      // Synthetic, Handle-shaped (`.gitleaks.toml` allows this signature segment).
      const handle =
        'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
      const fake = 'abcdefghijklmnopqrstuvwxyz0123';
      const principalId = await adminInsertPrincipal();
      const entry = await handleCaller(principalId, 'entry');
      const chatId = await newChatFor(principalId);
      const turnId = await startTurn(principalId, chatId);

      const decision = (await dispatchCapability({ pool }, entry, 'record_decision', {
        summary: `rotate the key; old one was PGPASSWORD=${fake}`,
      })) as { id: string };
      await dispatchCapability({ pool }, entry, 'report_turn', {
        turnId,
        summary: `ran env: CAPABILITY_HANDLE=${handle}`,
        decisions: [`call it with Authorization: Bearer ${handle}`, 'keep the plain one'],
      });

      const stored = await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const turn = await client.query<{ metadata: Record<string, unknown> }>(
          'select metadata from activities where workspace_id = $1 and id = $2',
          [workspaceId, turnId],
        );
        const decisionRow = await client.query<{ summary: string }>(
          'select summary from decisions where workspace_id = $1 and id = $2',
          [workspaceId, decision.id],
        );
        return { turn: turn.rows[0]?.metadata, decision: decisionRow.rows[0]?.summary };
      });
      expect(JSON.stringify(stored)).not.toContain('eyJhbGci');
      expect(JSON.stringify(stored)).not.toContain(fake);
      expect(stored.turn).toMatchObject({
        summary: 'ran env: CAPABILITY_HANDLE=[redacted]',
        decisions: ['call it with Authorization: [redacted]', 'keep the plain one'],
      });
      expect(stored.decision).toBe('rotate the key; old one was PGPASSWORD=[redacted]');
    });

    it('an interactive (peek) read does not consume the entry agent’s items', async () => {
      const principalId = await adminInsertPrincipal();
      const entry = await handleCaller(principalId, 'entry');
      const interactive = await handleCaller(principalId, 'mcp_session');
      const chatId = await newChatFor(principalId);
      const taskId = randomUUID();
      await insertTaskItem(principalId, chatId, taskId);

      expect(taskIds(await getEntryContext(interactive))).toEqual([taskId]);
      expect(taskIds(await getEntryContext(interactive))).toEqual([taskId]);

      const turnId = await startTurn(principalId, chatId);
      expect(taskIds(await getEntryContext(entry, { turnId }))).toEqual([taskId]);
      // Still visible to the peek until the Turn is reported.
      expect(taskIds(await getEntryContext(interactive))).toEqual([taskId]);
      await dispatchCapability({ pool }, entry, 'report_turn', { turnId, summary: 'done' });
      expect(taskIds(await getEntryContext(interactive))).toEqual([]);
    });

    it('an item raised from chat A is not visible to chat B of the same principal', async () => {
      const principalId = await adminInsertPrincipal();
      const entry = await handleCaller(principalId, 'entry');
      const chatA = await newChatFor(principalId);
      const chatB = await newChatFor(principalId);
      const taskId = randomUUID();
      await insertTaskItem(principalId, chatA, taskId);

      const turnB = await startTurn(principalId, chatB);
      expect(taskIds(await getEntryContext(entry, { turnId: turnB }))).toEqual([]);
      await dispatchCapability({ pool }, entry, 'report_turn', { turnId: turnB, summary: 'b' });

      const turnA = await startTurn(principalId, chatA);
      expect(taskIds(await getEntryContext(entry, { turnId: turnA }))).toEqual([taskId]);
    });

    it('an entry image that sends no turnId is attributed to its running Turn and acknowledged by its report_turn', async () => {
      const principalId = await adminInsertPrincipal();
      const entry = await handleCaller(principalId, 'entry');
      const chatId = await newChatFor(principalId);
      const taskId = randomUUID();
      await insertTaskItem(principalId, chatId, taskId);

      // No running Turn: a peek, nothing consumed.
      expect(taskIds(await getEntryContext(entry))).toEqual([taskId]);

      const turnId = await startTurn(principalId, chatId);
      expect(taskIds(await getEntryContext(entry))).toEqual([taskId]);
      expect(taskIds(await getEntryContext(entry))).toEqual([taskId]);
      await dispatchCapability({ pool }, entry, 'report_turn', { turnId, summary: 'done' });
      expect(taskIds(await getEntryContext(entry))).toEqual([]);
    });

    it('a turnId that is not one of the caller’s own Turns is TurnNotFoundError', async () => {
      const owner = await adminInsertPrincipal();
      const other = await adminInsertPrincipal();
      const chatId = await newChatFor(owner);
      const ownersTurn = await startTurn(owner, chatId);
      const otherEntry = await handleCaller(other, 'entry');

      await expect(getEntryContext(otherEntry, { turnId: ownersTurn })).rejects.toBeInstanceOf(
        TurnNotFoundError,
      );
      await expect(getEntryContext(otherEntry, { turnId: randomUUID() })).rejects.toBeInstanceOf(
        TurnNotFoundError,
      );
    });
  },
);
