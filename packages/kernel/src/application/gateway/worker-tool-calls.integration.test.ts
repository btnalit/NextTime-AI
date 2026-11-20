import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_WITHHELD_VALUE,
  type CapabilityScope,
  MAX_WORKER_RUN_TOOL_CALL_RECORDS,
  type ReportedToolCall,
  type Role,
  type ToolCallMessageContent,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/worker-tool-calls.integration.test (legacy 155): DB-gated (auto-skip without
 * DATABASE_URL) coverage of a Worker's tool-call records — `report_tool_calls` (a WorkerRun's
 * Handle writes its own run's records, redacted, the first record of an id kept, at most 200) and
 * `get_task_tool_calls` (read back as `get_task` is: the owner, the requester; anyone else gets the
 * 404 an unknown Task gets). Tasks / WorkerRuns / sessions are seeded directly under the admin login
 * role (no Worker runtime here), as task-operation-visibility.integration.test.ts does.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Synthetic values only: one a value pattern finds (a GitHub token's shape), one only its field
 *  name gives away. */
const FAKE_TOKEN = `ghp_${'F'.repeat(36)}`;
const FAKE_PASSWORD = 'FAKE-plain-word-7531';

const WORKER_SCOPE: CapabilityScope = {
  capabilities: ['get_task', 'report_task_result', 'report_tool_calls'],
  resources: {},
};

interface TaskToolCallsPage {
  readonly taskId: string;
  readonly items: readonly {
    readonly workerRunId: string;
    readonly sequence: number;
    readonly reportedAt: string;
    readonly content: ToolCallMessageContent;
  }[];
  readonly nextCursor?: string;
}

interface Counts {
  readonly workerRunId: string;
  readonly stored: number;
  readonly alreadyStored: number;
  readonly overLimit: number;
}

function call(toolCallId: string, extra: Partial<ReportedToolCall> = {}): ReportedToolCall {
  return {
    toolCallId,
    name: 'bash',
    outcome: 'done',
    args: { command: 'uptime' },
    result: { content: [{ type: 'text', text: 'up 3 days' }] },
    startedAt: '2026-11-20T08:00:00.000Z',
    endedAt: '2026-11-20T08:00:01.000Z',
    ...extra,
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'legacy 155 — a Worker run’s tool calls are recorded and read back (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;
    let requesterId: string;
    let otherMemberId: string;

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

    function handleCaller(obo: string, sid: string, scope = WORKER_SCOPE): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: { ws: workspaceId, sid, obo, scope, jti: randomUUID(), iat: now, exp: now + 600 },
      };
    }

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

    /** One WorkerRun of `taskId`, its `worker_run` session acting for `onBehalfOf`. */
    async function seedRun(
      taskId: string,
      onBehalfOf: string,
      options: { readonly status?: string; readonly startedAt?: Date } = {},
    ): Promise<{ sessionId: string; workerRunId: string }> {
      return admin(async (client) => {
        const session = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'worker_run', $2, 'active') returning id`,
          [workspaceId, onBehalfOf],
        );
        const sessionId = session.rows[0]?.id as string;
        const run = await client.query<{ id: string }>(
          `insert into worker_runs (workspace_id, status, task_id, session_id, started_at)
           values ($1, $2, $3, $4, $5) returning id`,
          [
            workspaceId,
            options.status ?? 'running',
            taskId,
            sessionId,
            options.startedAt ?? new Date(),
          ],
        );
        return { sessionId, workerRunId: run.rows[0]?.id as string };
      });
    }

    /** A running Task on behalf of `onBehalfOf` with one running WorkerRun. */
    async function seedTask(
      onBehalfOf: string,
    ): Promise<{ taskId: string; sessionId: string; workerRunId: string }> {
      const taskId = await admin(async (client) => {
        const task = await client.query<{ id: string }>(
          `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id,
                              worker_definition_version, input)
           values ($1, 'running', $2, $3, 1, '{}'::jsonb) returning id`,
          [workspaceId, onBehalfOf, randomUUID()],
        );
        return task.rows[0]?.id as string;
      });
      return { taskId, ...(await seedRun(taskId, onBehalfOf)) };
    }

    function report(caller: ResolvedCaller, calls: readonly ReportedToolCall[]): Promise<Counts> {
      return dispatchCapability({ pool }, caller, 'report_tool_calls', {
        calls,
      }) as Promise<Counts>;
    }

    function read(
      caller: ResolvedCaller,
      params: { taskId: string; limit?: number; cursor?: string },
    ): Promise<TaskToolCallsPage> {
      return dispatchCapability(
        { pool },
        caller,
        'get_task_tool_calls',
        params,
      ) as Promise<TaskToolCallsPage>;
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
            'worker-tool-calls-test-workspace',
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
      requesterId = await insertPrincipal('member', 'requester');
      otherMemberId = await insertPrincipal('member', 'other-member');
    });

    afterAll(async () => {
      await pool.end();
    });

    it("records the run's calls, redacted as a chat Turn's, and reads them back in order", async () => {
      const { taskId, sessionId, workerRunId } = await seedTask(requesterId);
      const worker = handleCaller(requesterId, sessionId);

      const counts = await report(worker, [
        call('call-1', {
          args: {
            command: `curl -H 'token: ${FAKE_TOKEN}' https://example.invalid/`,
            password: FAKE_PASSWORD,
          },
          // The result repeats the hidden argument: hidden there too (legacy 185).
          result: { content: [{ type: 'text', text: `login as admin:${FAKE_PASSWORD} ok` }] },
        }),
        call('call-2', {
          outcome: 'failed',
          result: { content: [{ type: 'text', text: 'exit 1' }] },
        }),
        // An unfinished call keeps no result, whatever was sent.
        call('call-3', {
          outcome: 'not_finished',
          result: { content: [{ type: 'text', text: 'x' }] },
          endedAt: null,
        }),
      ]);
      expect(counts).toEqual({ workerRunId, stored: 3, alreadyStored: 0, overLimit: 0 });

      const page = await read(humanCaller(requesterId, 'member'), { taskId });
      expect(page.taskId).toBe(taskId);
      expect(page.nextCursor).toBeUndefined();
      expect(
        page.items.map((item) => [item.workerRunId, item.sequence, item.content.toolCallId]),
      ).toEqual([
        [workerRunId, 1, 'call-1'],
        [workerRunId, 2, 'call-2'],
        [workerRunId, 3, 'call-3'],
      ]);
      const [first, second, third] = page.items.map((item) => item.content);
      expect(first).toMatchObject({ kind: 'tool_call', name: 'bash', outcome: 'done' });
      expect(first?.args?.text).not.toContain(FAKE_TOKEN);
      expect(first?.args?.text).not.toContain(FAKE_PASSWORD);
      expect(first?.args?.text).toContain('[redacted]');
      expect(first?.result?.text).toBe('login as admin:[redacted] ok');
      expect(first?.redactedValues).toBeGreaterThanOrEqual(3);
      expect(first?.startedAt).toBe('2026-11-20T08:00:00.000Z');
      expect(second?.outcome).toBe('failed');
      expect(third).toMatchObject({ outcome: 'not_finished', endedAt: null });
      expect(third?.result).toBeUndefined();
      expect(JSON.stringify(page)).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(page)).not.toContain(FAKE_PASSWORD);
    });

    it('keeps the first record of a call id: a second report of it stores nothing', async () => {
      const { taskId, sessionId, workerRunId } = await seedTask(requesterId);
      const worker = handleCaller(requesterId, sessionId);

      await report(worker, [call('call-1', { args: { command: 'first' } })]);
      const again = await report(worker, [
        call('call-1', { args: { command: 'second' } }),
        call('call-2'),
        // Twice in one report: the first is kept.
        call('call-2', { args: { command: 'third' } }),
      ]);
      expect(again).toEqual({ workerRunId, stored: 1, alreadyStored: 2, overLimit: 0 });

      const page = await read(humanCaller(ownerId, 'owner'), { taskId });
      expect(page.items.map((item) => [item.sequence, item.content.args?.text])).toEqual([
        [1, '{"command":"first"}'],
        [2, '{"command":"uptime"}'],
      ]);
    });

    it(`keeps at most ${MAX_WORKER_RUN_TOOL_CALL_RECORDS} records for a run and counts the rest`, async () => {
      const { taskId, sessionId, workerRunId } = await seedTask(requesterId);
      const worker = handleCaller(requesterId, sessionId);
      for (let batch = 0; batch < MAX_WORKER_RUN_TOOL_CALL_RECORDS / 50; batch += 1) {
        const counts = await report(
          worker,
          Array.from({ length: 50 }, (_, i) => call(`call-${batch * 50 + i}`)),
        );
        expect(counts.stored).toBe(50);
      }
      const over = await report(worker, [call('call-0'), call('one-more'), call('and-another')]);
      expect(over).toEqual({ workerRunId, stored: 0, alreadyStored: 1, overLimit: 2 });

      const sequences = await admin(async (client) => {
        const result = await client.query<{ max: number; count: number }>(
          `select max(sequence)::int as max, count(*)::int as count from worker_run_tool_calls
            where workspace_id = $1 and worker_run_id = $2`,
          [workspaceId, workerRunId],
        );
        return result.rows[0];
      });
      expect(sequences).toEqual({
        max: MAX_WORKER_RUN_TOOL_CALL_RECORDS,
        count: MAX_WORKER_RUN_TOOL_CALL_RECORDS,
      });
      const firstPage = await read(humanCaller(requesterId, 'member'), { taskId });
      expect(firstPage.items).toHaveLength(100);
    });

    it('stores U+0000 and half a surrogate pair visibly instead of refusing calls already made', async () => {
      const { taskId, sessionId } = await seedTask(requesterId);
      await report(handleCaller(requesterId, sessionId), [
        call('call\u0000nul', { args: { command: 'printf a\u0000b' }, name: 'half\ud83d' }),
      ]);
      const page = await read(humanCaller(requesterId, 'member'), { taskId });
      const content = page.items[0]?.content;
      expect(content?.toolCallId).toBe('call\\u{0}nul');
      expect(content?.name).toBe('half�');
      // The arguments' text is JSON: U+0000 in it is already written `\u0000`.
      expect(content?.args?.text).toBe('{"command":"printf a\\u0000b"}');
    });

    it('is refused to any session that is no running WorkerRun’s, and changes nothing', async () => {
      const { taskId, sessionId } = await seedTask(requesterId);
      // An entry agent's Handle holds the name too (its ceiling, for the Workers it starts).
      await expect(
        report(handleCaller(requesterId, randomUUID()), [call('call-1')]),
      ).rejects.toMatchObject({ name: 'ForbiddenError' });

      // A run that has ended keeps what it has.
      const ended = await seedRun(taskId, requesterId, { status: 'terminated' });
      await expect(
        report(handleCaller(requesterId, ended.sessionId), [call('call-1')]),
      ).rejects.toMatchObject({ name: 'ForbiddenError' });

      // A Handle without the capability is refused at the door.
      await expect(
        report(
          handleCaller(requesterId, sessionId, { capabilities: ['get_task'], resources: {} }),
          [call('call-1')],
        ),
      ).rejects.toMatchObject({ name: 'ForbiddenError' });
      expect((await read(humanCaller(ownerId, 'owner'), { taskId })).items).toEqual([]);
    });

    it('audits each report without the calls: the run, the counts and what was redacted', async () => {
      const { taskId, sessionId, workerRunId } = await seedTask(requesterId);
      await report(handleCaller(requesterId, sessionId), [
        call('call-1\u0000', { args: { password: FAKE_PASSWORD } }),
      ]);
      const rows = await admin(async (client) => {
        const result = await client.query<{
          actor_principal_id: string;
          resource_type: string;
          resource_id: string;
          payload: Record<string, unknown>;
        }>(
          `select actor_principal_id, resource_type, resource_id, payload from audit_records
            where workspace_id = $1 and action = 'report_tool_calls' and payload->>'workerRunId' = $2`,
          [workspaceId, workerRunId],
        );
        return result.rows;
      });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.actor_principal_id).toBe(requesterId);
      expect(row?.resource_type).toBe('task');
      expect(row?.resource_id).toBe(taskId);
      expect(row?.payload).toMatchObject({
        workerRunId,
        callCount: 1,
        stored: 1,
        alreadyStored: 0,
        overLimit: 0,
        recordRedactedValues: 1,
        recordUnstorableEscaped: 1,
        params: { calls: AUDIT_WITHHELD_VALUE },
        withheldParams: ['calls'],
      });
      expect(JSON.stringify(row?.payload)).not.toContain('bash');
      expect(JSON.stringify(row?.payload)).not.toContain(FAKE_PASSWORD);
    });

    it('is read by whoever may read the Task; anyone else gets the 404 an unknown Task gets', async () => {
      const { taskId, sessionId } = await seedTask(requesterId);
      await report(handleCaller(requesterId, sessionId), [call('call-1')]);

      expect((await read(humanCaller(ownerId, 'owner'), { taskId })).items).toHaveLength(1);
      expect((await read(humanCaller(requesterId, 'member'), { taskId })).items).toHaveLength(1);
      for (const caller of [
        humanCaller(otherMemberId, 'member'),
        // A builder is not a reviewer of Tasks: only the owner overrides (D-21).
        humanCaller(builderId, 'builder'),
      ]) {
        await expect(read(caller, { taskId })).rejects.toMatchObject({ name: 'TaskNotFoundError' });
      }
      await expect(
        read(humanCaller(ownerId, 'owner'), { taskId: randomUUID() }),
      ).rejects.toMatchObject({ name: 'TaskNotFoundError' });
      // People only: an agent's Handle never holds it.
      await expect(
        dispatchCapability(
          { pool },
          handleCaller(requesterId, sessionId, {
            capabilities: ['get_task_tool_calls'],
            resources: {},
          }),
          'get_task_tool_calls',
          { taskId },
        ),
      ).rejects.toMatchObject({ name: 'ForbiddenError' });
    });

    it('pages through every run of the Task, the runs in the order they started', async () => {
      const { taskId, sessionId, workerRunId } = await seedTask(requesterId);
      // A retry's run, started after the first.
      const retry = await seedRun(taskId, requesterId, {
        startedAt: new Date(Date.now() + 60_000),
      });
      await report(handleCaller(requesterId, retry.sessionId), [call('r-1'), call('r-2')]);
      await report(handleCaller(requesterId, sessionId), [call('a-1'), call('a-2'), call('a-3')]);

      const reader = humanCaller(requesterId, 'member');
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await read(reader, { taskId, limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(
          ...page.items.map(
            (item) => `${item.workerRunId === workerRunId ? 'a' : 'r'}:${item.sequence}`,
          ),
        );
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(seen).toEqual(['a:1', 'a:2', 'a:3', 'r:1', 'r:2']);
      expect(pages).toBe(3);

      // A cursor the kernel did not make reads from the first record.
      const fromStart = await read(reader, { taskId, limit: 1, cursor: 'not-a-cursor' });
      expect(fromStart.items[0]?.content.toolCallId).toBe('a-1');
    });

    it('is written once: the application role may not change or remove a record', async () => {
      const { sessionId, workerRunId } = await seedTask(requesterId);
      await report(handleCaller(requesterId, sessionId), [call('call-1')]);
      for (const statement of [
        `update worker_run_tool_calls set content = '{}'::jsonb where worker_run_id = '${workerRunId}'`,
        `delete from worker_run_tool_calls where worker_run_id = '${workerRunId}'`,
      ]) {
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
            client.query(statement),
          ),
        ).rejects.toThrow(/permission denied/);
      }
    });

    // #501 T1: the table's row-level security, as the application role of another workspace.
    it('is another workspace’s to neither read nor write', async () => {
      const { sessionId, workerRunId } = await seedTask(requesterId);
      await report(handleCaller(requesterId, sessionId), [call('call-1')]);
      const otherWorkspaceId = randomUUID();
      const otherOwnerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: otherWorkspaceId, principalId: otherOwnerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            otherWorkspaceId,
            'worker-tool-calls-other-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'other owner')`,
            [otherWorkspaceId, otherOwnerId],
          );
        },
        { skipRoleSwitch: true },
      );
      const asOther = <T>(fn: (client: PoolClient) => Promise<T>) =>
        withWorkspace(pool, { workspaceId: otherWorkspaceId, principalId: otherOwnerId }, fn);

      const seen = await asOther((client) =>
        client.query<{ count: string }>(
          'select count(*)::text as count from worker_run_tool_calls where worker_run_id = $1',
          [workerRunId],
        ),
      );
      expect(seen.rows[0]?.count).toBe('0');
      // Written into this workspace's run from the other one: the policy's check refuses it.
      await expect(
        asOther((client) =>
          client.query(
            `insert into worker_run_tool_calls
               (workspace_id, worker_run_id, tool_call_id, sequence, content)
             values ($1, $2, 'planted', 99, $3::jsonb)`,
            [
              workspaceId,
              workerRunId,
              JSON.stringify({ kind: 'tool_call', toolCallId: 'planted', text: 'planted' }),
            ],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      const kept = await admin((client) =>
        client.query<{ tool_call_id: string }>(
          'select tool_call_id from worker_run_tool_calls where worker_run_id = $1',
          [workerRunId],
        ),
      );
      expect(kept.rows.map((row) => row.tool_call_id)).toEqual(['call-1']);
    });
  },
);
