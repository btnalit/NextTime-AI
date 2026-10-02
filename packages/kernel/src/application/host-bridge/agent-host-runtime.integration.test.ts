import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KernelToAgentHostFrame } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/keys.js';
import { createUser } from '../identity/index.js';
import { AgentHostRuntime } from './agent-host-runtime.js';
import type { AgentRuntimeEvent } from './agent-runtime.js';

/**
 * Integration test (real Postgres; auto-skips without DATABASE_URL) for R-05's runtime half:
 * `AgentHostRuntime.ensureEntryHandle` refuses a disabled principal, or a principal whose platform
 * user is disabled — no entry session, no Handle, the Turn fails. Real database because the user
 * half is read from inside a *workspace* transaction (`users_workspace_members`, migration core
 * 0021): a policy that hid the row would read as "active" and silently let the Handle through.
 * agent-host-runtime.test.ts covers the same decision against a fake pool.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'AgentHostRuntime entry Handle refusal (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let privateKey: CryptoKey;

    function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: randomUUID() }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function insertPrincipal(userId: string): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, 'human', 'member', 'entry refusal test', $3)`,
          [workspaceId, id, userId],
        ),
      );
      return id;
    }

    async function newUser(): Promise<string> {
      const user = await createUser(pool, {
        login: `entry-refusal-${randomUUID().slice(0, 8)}`,
        displayName: 'Entry Refusal User',
      });
      return user.id;
    }

    async function startTurnFor(principalId: string): Promise<{
      readonly events: AgentRuntimeEvent[];
      readonly sent: KernelToAgentHostFrame[];
      readonly turnId: string;
    }> {
      const events: AgentRuntimeEvent[] = [];
      const sent: KernelToAgentHostFrame[] = [];
      const runtime = new AgentHostRuntime({
        pool,
        sink: {
          handle(event) {
            events.push(event);
          },
        },
        privateKey,
        kernelLlmUrl: 'http://llm-proxy:8082',
        log: () => {},
      });
      runtime.connect({ send: (frame) => sent.push(frame) });
      const turnId = randomUUID();
      await runtime.startTurn({
        workspaceId,
        chatId: randomUUID(),
        turnId,
        principalId,
        prompt: 'hello',
      });
      // Settle the accept wait so no timer outlives the test.
      if (sent.length > 0) runtime.handleFrame({ type: 'turnAccepted', turnId });
      return { events, sent, turnId };
    }

    async function entryArtifacts(
      principalId: string,
    ): Promise<{ sessions: number; handles: number }> {
      return admin(async (client) => {
        const sessions = await client.query<{ n: string }>(
          `select count(*)::text as n from sessions
            where workspace_id = $1 and principal_id = $2 and kind = 'entry'`,
          [workspaceId, principalId],
        );
        const handles = await client.query<{ n: string }>(
          `select count(*)::text as n from capability_handles
            where workspace_id = $1 and on_behalf_of = $2`,
          [workspaceId, principalId],
        );
        return {
          sessions: Number(sessions.rows[0]?.n ?? '0'),
          handles: Number(handles.rows[0]?.n ?? '0'),
        };
      });
    }

    function expectRefused(result: Awaited<ReturnType<typeof startTurnFor>>): void {
      expect(result.sent).toEqual([]);
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: 'turnEnded', status: 'failed', turnId: result.turnId }),
      );
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await admin((client) =>
        client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'agent-host-runtime-entry-refusal',
        ]),
      );
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('control: an enabled member with an active user gets an entry Handle and the Turn starts', async () => {
      const principalId = await insertPrincipal(await newUser());
      const result = await startTurnFor(principalId);

      expect(result.sent).toHaveLength(1);
      expect(result.sent[0]).toMatchObject({ type: 'startTurn', principalId });
      expect(await entryArtifacts(principalId)).toEqual({ sessions: 1, handles: 1 });
    });

    it('a disabled principal: no entry session, no Handle, the Turn fails', async () => {
      const principalId = await insertPrincipal(await newUser());
      await admin((client) =>
        client.query(
          'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
          [workspaceId, principalId],
        ),
      );

      expectRefused(await startTurnFor(principalId));
      expect(await entryArtifacts(principalId)).toEqual({ sessions: 0, handles: 0 });
    });

    it('an enabled principal whose platform user is disabled: refused the same way', async () => {
      const userId = await newUser();
      const principalId = await insertPrincipal(userId);
      await admin((client) =>
        client.query("update users set status = 'disabled' where id = $1", [userId]),
      );

      expectRefused(await startTurnFor(principalId));
      expect(await entryArtifacts(principalId)).toEqual({ sessions: 0, handles: 0 });
    });
  },
);
