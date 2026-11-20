import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { platformKeyShapes } from '../../governance/redaction/index.js';
import { hashApiKey } from '../gateway/auth.js';
import type { LiveApiKeyRow, ScrubRawSecretsResult } from './scrub-raw-secrets.js';
import { RAW_SECRET_SCRUB_AUDIT_ACTION, scrubRawSecrets } from './scrub-raw-secrets.js';

/**
 * application/platform/scrub-raw-secrets.live-keys.integration.test: DB-gated (real Postgres;
 * auto-skip without DATABASE_URL). Platform API keys written into stored rows before legacy 168's
 * review masked them: the audit rows that hold one are counted (`auditPayloads`), and every stored
 * copy the scrub reads is compared, by hash, against the keys issued (`liveApiKeys`). Seeds a
 * workspace whose service Principal and whose person's membership each hold a key, the key in an
 * audit row's params copy, a Task input, an agent Turn's summary (after `Bearer`, which the rewrite
 * hides) and a tool-call result (standing alone, which it keeps) — plus a retired key's shape and a
 * clean audit row; then: the rows are listed by ids only, never a key or its hash; an executing
 * run lists the Turn before it hides the key, and a later run no longer can; once both keys are
 * rotated, no seeded row is listed.
 *
 * Keys are minted per run (`api_key_hash` is unique across the database, and test databases are
 * reused); the scrub reads the whole database, so assertions are about the seeded rows.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** A key as `generateApiKey` mints one, redrawn in the rare case it lacks the shape's mix. */
function mintKey(): string {
  for (;;) {
    const key = randomBytes(32).toString('base64url');
    if (platformKeyShapes(key).length === 1) return key;
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'scrubRawSecrets (integration, real Postgres) — platform API keys still issued (legacy 168 review)',
  () => {
    let pool: Pool;
    let userId: string;
    const workspaceId = randomUUID();
    const ids = {
      member: randomUUID(),
      service: randomUUID(),
      chat: randomUUID(),
      turn: randomUUID(),
      toolMessage: randomUUID(),
      task: randomUUID(),
      auditLive: randomUUID(),
      auditRetired: randomUUID(),
      auditClean: randomUUID(),
    };
    const serviceKey = mintKey();
    const memberKey = mintKey();
    const retiredKey = mintKey();
    const leaks = [
      serviceKey,
      memberKey,
      retiredKey,
      hashApiKey(serviceKey),
      hashApiKey(memberKey),
      hashApiKey(retiredKey),
    ];

    function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ids.member }, fn, {
        skipRoleSwitch: true,
      });
    }

    /** A run, with every row it lists by `onLiveApiKey` and `onCounted`, and every line's text. */
    async function run(confirm: boolean) {
      const live: LiveApiKeyRow[] = [];
      const counted: { category: string; id: string }[] = [];
      const result: ScrubRawSecretsResult = await scrubRawSecrets(pool, {
        confirm,
        batchSize: 200,
        onLiveApiKey: (row) => live.push(row),
        onCounted: (category, row) => counted.push({ category, id: row.id }),
      });
      const seeded = new Set<string>(Object.values(ids));
      return {
        result,
        counted,
        /** The seeded rows listed, as `category id principal` — the other test files' rows aside. */
        listed: live
          .filter((row) => seeded.has(row.id))
          .map((row) => `${row.category} ${row.id} ${row.principalId}`)
          .sort(),
        live,
      };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      userId = (
        await pool.query<{ id: string }>(
          'insert into users (login, display_name) values ($1, $1) returning id',
          [`live-keys-${workspaceId}`],
        )
      ).rows[0]?.id as string;
      await admin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'scrub-live-keys-test',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash, user_id)
           values ($1, $2, 'human', 'owner', 'member', $3, $4),
                  ($1, $5, 'service', 'member', 'backup collector', $6, null)`,
          [
            workspaceId,
            ids.member,
            hashApiKey(memberKey),
            userId,
            ids.service,
            hashApiKey(serviceKey),
          ],
        );
        await client.query(
          'insert into chats (workspace_id, id, owner_principal_id) values ($1, $2, $3)',
          [workspaceId, ids.chat, ids.member],
        );
        // After `Bearer`, the key the rewrite hides.
        await client.query(
          `insert into activities (workspace_id, id, kind, chat_id, sequence, status, metadata, started_by)
           values ($1, $2, 'agent_turn', $3, 1, 'completed', $4::jsonb, $5)`,
          [
            workspaceId,
            ids.turn,
            ids.chat,
            JSON.stringify({ summary: `called it with Authorization: Bearer ${serviceKey}` }),
            ids.member,
          ],
        );
        // Standing alone in a JSON value: kept by the rewrite, counted as a key's shape.
        await client.query(
          `insert into chat_messages (workspace_id, id, chat_id, turn_id, role, content, sequence)
           values ($1, $2, $3, $4, 'tool', $5::jsonb, 1)`,
          [
            workspaceId,
            ids.toolMessage,
            ids.chat,
            ids.turn,
            JSON.stringify({
              kind: 'tool_call',
              text: 'some_tool',
              toolCallId: 'call_1',
              name: 'some_tool',
              outcome: 'done',
              args: { text: '{}', totalChars: 2, truncated: false },
              result: { text: `{"x": "${memberKey}"}`, totalChars: 49, truncated: false },
              redactedValues: 0,
              startedAt: null,
              endedAt: null,
            }),
          ],
        );
        await client.query(
          `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id, worker_definition_version, input)
           values ($1, $2, 'completed', $3, $4, 1, $5::jsonb)`,
          [
            workspaceId,
            ids.task,
            ids.member,
            randomUUID(),
            JSON.stringify({ job: 'collect', with: serviceKey }),
          ],
        );
        await client.query(
          `insert into audit_records (workspace_id, id, actor_principal_id, action, resource_type, resource_id, payload) values
             ($1, $2, $3, 'issue_service_handle', 'session', $4, $5::jsonb),
             ($1, $6, $3, 'issue_service_handle', 'session', $4, $7::jsonb),
             ($1, $8, $3, 'issue_service_handle', 'session', $4, $9::jsonb)`,
          [
            workspaceId,
            ids.auditLive,
            ids.member,
            randomUUID(),
            JSON.stringify({ params: { note: `for the collector, key ${serviceKey}` } }),
            ids.auditRetired,
            JSON.stringify({ params: { note: `rotated away from ${retiredKey}` } }),
            ids.auditClean,
            JSON.stringify({ params: { note: 'nothing to see' } }),
          ],
        );
      });
    });

    afterAll(async () => {
      // Whatever happened above, leave no key issued whose value sits in a stored row.
      await admin((client) =>
        client.query(
          'update principals set api_key_hash = null where workspace_id = $1 and id = any($2::uuid[])',
          [workspaceId, [ids.member, ids.service]],
        ),
      );
      await pool.end();
    });

    it('lists every stored copy of a key still issued by ids only — the row, the Principal, the user', async () => {
      const { result, counted, listed, live } = await run(false);
      expect(listed).toEqual(
        [
          `auditPayloads ${ids.auditLive} ${ids.service}`,
          `taskInputs ${ids.task} ${ids.service}`,
          `toolCallRecords ${ids.toolMessage} ${ids.member}`,
          `turnReports ${ids.turn} ${ids.service}`,
        ].sort(),
      );
      const member = live.find((row) => row.id === ids.toolMessage);
      expect(member).toEqual({
        category: 'toolCallRecords',
        workspaceId,
        id: ids.toolMessage,
        principalWorkspaceId: workspaceId,
        principalId: ids.member,
        principalKind: 'human',
        userId,
      });
      expect(live.find((row) => row.id === ids.auditLive)).toMatchObject({
        principalKind: 'service',
        userId: null,
      });
      // The *KeyShapes re-reads and auditResults compare nothing: one line per row and key.
      expect(live.filter((row) => row.id === ids.toolMessage)).toHaveLength(1);
      expect(result.liveApiKeys.keys).toBeGreaterThanOrEqual(2);
      expect(result.liveApiKeys.found).toBe(live.length);
      // The audit rows holding a key's shape are counted, issued or not; the clean one is not.
      expect(counted).toContainEqual({ category: 'auditPayloads', id: ids.auditLive });
      expect(counted).toContainEqual({ category: 'auditPayloads', id: ids.auditRetired });
      expect(counted).not.toContainEqual({ category: 'auditPayloads', id: ids.auditClean });
      expect(counted).toContainEqual({ category: 'toolCallRecordKeyShapes', id: ids.toolMessage });
      for (const leak of leaks) {
        expect(JSON.stringify({ result, live, counted })).not.toContain(leak);
      }
    });

    it('an executing run lists the key it then hides; a later run cannot see it, nor any key once rotated', async () => {
      const executed = await run(true);
      expect(executed.listed).toContain(`turnReports ${ids.turn} ${ids.service}`);
      const audit = await admin(
        async (client) =>
          (
            await client.query<{ payload: Record<string, unknown> }>(
              'select payload from audit_records where id = $1 and action = $2',
              [executed.result.auditRecordId, RAW_SECRET_SCRUB_AUDIT_ACTION],
            )
          ).rows[0],
      );
      expect(audit?.payload).toHaveProperty('liveApiKeys.keys', executed.result.liveApiKeys.keys);
      for (const leak of leaks) expect(JSON.stringify(audit)).not.toContain(leak);
      const summary = await admin(
        async (client) =>
          (
            await client.query<{ summary: string }>(
              `select metadata ->> 'summary' as summary from activities where workspace_id = $1 and id = $2`,
              [workspaceId, ids.turn],
            )
          ).rows[0]?.summary,
      );
      expect(summary).toContain('[redacted]');
      expect(summary).not.toContain(serviceKey);

      // The rewrite hid the Turn's copy: only the first run's list has it.
      const after = await run(false);
      expect(after.listed).toEqual(
        [
          `auditPayloads ${ids.auditLive} ${ids.service}`,
          `taskInputs ${ids.task} ${ids.service}`,
          `toolCallRecords ${ids.toolMessage} ${ids.member}`,
        ].sort(),
      );

      // Re-keyed (`rotate_api_key`) and dropped (a person's password change): nothing left.
      await admin(async (client) => {
        await client.query(
          'update principals set api_key_hash = $3 where workspace_id = $1 and id = $2',
          [workspaceId, ids.service, hashApiKey(mintKey())],
        );
        await client.query(
          'update principals set api_key_hash = null where workspace_id = $1 and id = $2',
          [workspaceId, ids.member],
        );
      });
      const rotated = await run(false);
      expect(rotated.listed).toEqual([]);
      // The audit rows stay as written (I11) and stay counted.
      expect(rotated.counted).toContainEqual({ category: 'auditPayloads', id: ids.auditLive });
    });
  },
);
