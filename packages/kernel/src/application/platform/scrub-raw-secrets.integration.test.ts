import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { RAW_SECRET_SCRUB_AUDIT_ACTION, scrubRawSecrets } from './scrub-raw-secrets.js';

/**
 * application/platform/scrub-raw-secrets.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL). Seeds, in a workspace of its own, the rows STATUS legacy 183–187 left
 * behind — an agent Turn's report, an agent's Decision, a stored tool-call record, a Task input, a
 * connection target, a Gatekeeper endpoint, two audit rows — plus their clean or out-of-scope
 * neighbours, then: a dry run writes nothing; an executing run rewrites exactly the three copies
 * people read, leaves the counted rows (and every neighbour) as they were, and writes one
 * unattributed audit row that names no value; a second run rewrites nothing of this workspace.
 *
 * The scrub reads the whole database, and other test files run alongside: assertions are about the
 * seeded rows, and the counts only bound from below.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Synthetic, Handle-shaped (`.gitleaks.toml` allows this signature segment). */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
/** Synthetic — spelled out from the alphabet, which `.gitleaks.toml` allows. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
/** No value pattern knows it: only a field name gives it away. */
const PLAIN = 'hunter2-plain-word';

describe.runIf(DATABASE_URL !== undefined)(
  'scrubRawSecrets (integration, real Postgres) — legacy 183–187 rows written before the fix',
  () => {
    let pool: Pool;
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    const ids = {
      turn: randomUUID(),
      approvalActivity: randomUUID(),
      agentDecision: randomUUID(),
      approvalDecision: randomUUID(),
      chat: randomUUID(),
      toolMessage: randomUUID(),
      cleanToolMessage: randomUUID(),
      task: randomUUID(),
      connectionRequest: randomUUID(),
      gatekeeper: randomUUID(),
      completeAudit: randomUUID(),
      failAudit: randomUUID(),
      scrubbedAudit: randomUUID(),
    };
    const turnMetadata = {
      summary: `ran env: CAPABILITY_HANDLE=${HANDLE}`,
      decisions: [`use PGPASSWORD=${FAKE}`, 'keep the plain one'],
      model: 'm',
    };
    const toolContent = {
      kind: 'tool_call',
      text: 'some_tool',
      toolCallId: 'call_1',
      name: 'some_tool',
      outcome: 'done',
      args: { text: '{"password":"[redacted]"}', totalChars: 30, truncated: false },
      result: {
        text: `{\n  "user": "bob",\n  "password": "${PLAIN}",\n  "note": "token=${FAKE}"\n}`,
        totalChars: 70,
        truncated: false,
      },
      redactedValues: 1,
      startedAt: null,
      endedAt: null,
    };
    const cleanToolContent = {
      ...toolContent,
      toolCallId: 'call_2',
      result: { text: 'ok', totalChars: 2, truncated: false },
    };
    const taskInput = { job: 'migrate', db: { password: PLAIN } };

    function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function snapshot() {
      return admin(async (client) => {
        const one = async (sql: string, params: unknown[]) =>
          (await client.query(sql, params)).rows[0];
        return {
          turn: (
            await one('select metadata from activities where workspace_id = $1 and id = $2', [
              workspaceId,
              ids.turn,
            ])
          )?.metadata,
          agentDecision: (
            await one('select summary from decisions where workspace_id = $1 and id = $2', [
              workspaceId,
              ids.agentDecision,
            ])
          )?.summary,
          approvalDecision: (
            await one('select summary from decisions where workspace_id = $1 and id = $2', [
              workspaceId,
              ids.approvalDecision,
            ])
          )?.summary,
          tool: (
            await one('select content from chat_messages where workspace_id = $1 and id = $2', [
              workspaceId,
              ids.toolMessage,
            ])
          )?.content,
          cleanTool: (
            await one('select content from chat_messages where workspace_id = $1 and id = $2', [
              workspaceId,
              ids.cleanToolMessage,
            ])
          )?.content,
          task: (
            await one('select input from tasks where workspace_id = $1 and id = $2', [
              workspaceId,
              ids.task,
            ])
          )?.input,
          target: (
            await one(
              'select target from connection_requests where workspace_id = $1 and id = $2',
              [workspaceId, ids.connectionRequest],
            )
          )?.target,
          gatekeeper: (
            await one('select properties from objects where workspace_id = $1 and id = $2', [
              workspaceId,
              ids.gatekeeper,
            ])
          )?.properties,
          audits: (
            await client.query(
              'select id, payload from audit_records where workspace_id = $1 and id = any($2::uuid[]) order by id',
              [workspaceId, [ids.completeAudit, ids.failAudit, ids.scrubbedAudit]],
            )
          ).rows,
        };
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      await admin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'scrub-raw-secrets-test',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')`,
          [workspaceId, ownerId],
        );
        await client.query(
          'insert into chats (workspace_id, id, owner_principal_id) values ($1, $2, $3)',
          [workspaceId, ids.chat, ownerId],
        );
        await client.query(
          `insert into activities (workspace_id, id, kind, chat_id, sequence, status, metadata, started_by)
           values ($1, $2, 'agent_turn', $3, 1, 'completed', $4::jsonb, $5)`,
          [workspaceId, ids.turn, ids.chat, JSON.stringify(turnMetadata), ownerId],
        );
        await client.query(
          `insert into activities (workspace_id, id, kind, status, started_by)
           values ($1, $2, 'approval_decision', 'completed', $3)`,
          [workspaceId, ids.approvalActivity, ownerId],
        );
        await client.query(
          `insert into decisions (workspace_id, id, activity_id, summary) values
             ($1, $2, $3, $4), ($1, $5, $6, $7)`,
          [
            workspaceId,
            ids.agentDecision,
            ids.turn,
            `rotate it; the old one was PGPASSWORD=${FAKE}`,
            ids.approvalDecision,
            ids.approvalActivity,
            `approved; PGPASSWORD=${FAKE}`,
          ],
        );
        await client.query(
          `insert into chat_messages (workspace_id, id, chat_id, turn_id, role, content, sequence) values
             ($1, $2, $3, $4, 'tool', $5::jsonb, 1), ($1, $6, $3, $4, 'tool', $7::jsonb, 2)`,
          [
            workspaceId,
            ids.toolMessage,
            ids.chat,
            ids.turn,
            JSON.stringify(toolContent),
            ids.cleanToolMessage,
            JSON.stringify(cleanToolContent),
          ],
        );
        await client.query(
          `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id, worker_definition_version, input)
           values ($1, $2, 'completed', $3, $4, 1, $5::jsonb)`,
          [workspaceId, ids.task, ownerId, randomUUID(), JSON.stringify(taskInput)],
        );
        await client.query(
          `insert into connection_requests (workspace_id, id, kind, target, requested_by)
           values ($1, $2, 'http', $3, $4)`,
          [
            workspaceId,
            ids.connectionRequest,
            `https://ops:${FAKE}@grafana.example.invalid`,
            ownerId,
          ],
        );
        await client.query(
          `insert into objects (workspace_id, id, object_type, properties) values ($1, $2, 'Gatekeeper', $3::jsonb)`,
          [
            workspaceId,
            ids.gatekeeper,
            JSON.stringify({
              transportKind: 'http',
              target: 'grafana',
              endpoint: `https://gate.example.invalid/?token=${FAKE}`,
            }),
          ],
        );
        await client.query(
          `insert into audit_records (workspace_id, id, actor_principal_id, action, resource_type, resource_id, payload) values
             ($1, $2, $3, 'action_request.complete', 'action_request', $4, $5::jsonb),
             ($1, $6, $3, 'action_request.fail', 'action_request', $7, $8::jsonb),
             ($1, $9, $3, 'action_request.complete', 'action_request', $10, $11::jsonb)`,
          [
            workspaceId,
            ids.completeAudit,
            ownerId,
            randomUUID(),
            JSON.stringify({
              resultingStatus: 'executed',
              resultMetadata: { issued: { token: 'issued-plain-value' } },
            }),
            ids.failAudit,
            randomUUID(),
            JSON.stringify({
              resultingStatus: 'failed',
              reason: `mysql: PGPASSWORD=${FAKE} rejected`,
            }),
            ids.scrubbedAudit,
            randomUUID(),
            JSON.stringify({
              resultingStatus: 'executed',
              resultMetadata: { issued: { token: '[redacted]' } },
              resultRedaction: { redactedValues: 1, paths: ['issued.token'] },
            }),
          ],
        );
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a dry run reports the seeded rows and writes nothing', async () => {
      const before = await snapshot();
      const result = await scrubRawSecrets(pool, { confirm: false, batchSize: 3 });
      expect(result.executed).toBe(false);
      expect(result.auditRecordId).toBeNull();
      expect(await snapshot()).toEqual(before);
      for (const name of ['turnReports', 'decisions', 'toolCallRecords'] as const) {
        expect(result.categories[name].affected).toBeGreaterThanOrEqual(1);
        expect(result.categories[name].examples).toEqual([]);
      }
      const listed = (name: keyof typeof result.categories) =>
        result.categories[name].examples.map((e) => e.id);
      // Examples are capped; a crowded test database may list others first.
      for (const [name, id] of [
        ['taskInputs', ids.task],
        ['connectionTargets', ids.connectionRequest],
        ['gatekeeperAddresses', ids.gatekeeper],
      ] as const) {
        expect(result.categories[name].affected).toBeGreaterThanOrEqual(1);
        if (result.categories[name].affected <= 20) expect(listed(name)).toContain(id);
      }
      expect(result.categories.auditResults.affected).toBeGreaterThanOrEqual(2);
    });

    it('--yes rewrites the three copies people read, counts the rest, and audits counts only', async () => {
      const result = await scrubRawSecrets(pool, { confirm: true, batchSize: 3 });
      expect(result.executed).toBe(true);
      const after = await snapshot();

      expect(after.turn).toEqual({
        summary: 'ran env: CAPABILITY_HANDLE=[redacted]',
        decisions: ['use PGPASSWORD=[redacted]', 'keep the plain one'],
        model: 'm',
      });
      expect(after.agentDecision).toBe('rotate it; the old one was PGPASSWORD=[redacted]');
      // A person's Decision is not agent text: out of this scrub's scope.
      expect(after.approvalDecision).toBe(`approved; PGPASSWORD=${FAKE}`);
      expect(after.tool).toEqual({
        ...toolContent,
        result: {
          ...toolContent.result,
          text: '{\n  "user": "bob",\n  "password": "[redacted]",\n  "note": "token=[redacted]"\n}',
        },
        redactedValues: 3,
      });
      expect(after.cleanTool).toEqual(cleanToolContent);

      // Counted, never rewritten.
      expect(after.task).toEqual(taskInput);
      expect(after.target).toBe(`https://ops:${FAKE}@grafana.example.invalid`);
      expect(after.gatekeeper).toMatchObject({
        endpoint: `https://gate.example.invalid/?token=${FAKE}`,
      });
      expect(JSON.stringify(after.audits)).toContain('issued-plain-value');

      const audit = await admin(
        async (client) =>
          (
            await client.query<{
              action: string;
              actor_user_id: string | null;
              payload: Record<string, unknown>;
            }>('select action, actor_user_id, payload from audit_records where id = $1', [
              result.auditRecordId,
            ])
          ).rows[0],
      );
      expect(audit).toMatchObject({
        action: RAW_SECRET_SCRUB_AUDIT_ACTION,
        actor_user_id: null,
        payload: { channel: 'cli', attributedActor: false, completed: true },
      });
      for (const leak of [HANDLE, FAKE, PLAIN, 'issued-plain-value']) {
        expect(JSON.stringify(audit)).not.toContain(leak);
      }
    });

    it('a second run rewrites nothing it already rewrote', async () => {
      const before = await snapshot();
      const second = await scrubRawSecrets(pool, { confirm: true, batchSize: 50 });
      expect(await snapshot()).toEqual(before);
      expect(second.auditRecordId).not.toBeNull();
    });
  },
);
