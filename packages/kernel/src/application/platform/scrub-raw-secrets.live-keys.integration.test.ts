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
import {
  LIVE_API_KEY_COMPARE_WINDOW,
  RAW_SECRET_SCRUB_AUDIT_ACTION,
  scrubRawSecrets,
} from './scrub-raw-secrets.js';

/**
 * application/platform/scrub-raw-secrets.live-keys.integration.test: DB-gated (real Postgres;
 * auto-skip without DATABASE_URL). Platform API keys written into stored rows before legacy 168's
 * review masked them: the audit rows that hold one are counted (`auditPayloads`), and every row of
 * the database is compared, by hash, against the keys issued (`liveApiKeys`). Seeds a workspace
 * whose service Principal and whose person's membership each hold a key, the key wherever one could
 * have been pasted or echoed — a person's chat message, an agent's reply, a tool-call result, an
 * agent Turn's summary (after `Bearer`, which the rewrite hides), a Task's input and, in an array,
 * its result, an Operation call's params, an audit row's params copy, in a table without a primary
 * key the last row of the first window and, as an object's key, the last row past it, and in a
 * table keyed by text a text array and the primary key itself — plus a retired key's shape and a
 * clean audit row; then: the rows are listed by table and primary key only, each once, never a key
 * (a key that is the primary key is masked) or its hash; an executing run lists the Turn before it
 * hides the key, and a later run no longer can; once both keys are rotated, no seeded row is
 * listed.
 *
 * Keys are minted per run (`api_key_hash` is unique across the database, and test databases are
 * reused); the scrub reads the whole database, so assertions are about the seeded rows, and a run
 * takes as long as the shared test database is large.
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
      gatekeeper: randomUUID(),
      chat: randomUUID(),
      turn: randomUUID(),
      userMessage: randomUUID(),
      assistantMessage: randomUUID(),
      toolMessage: randomUUID(),
      task: randomUUID(),
      actionRequest: randomUUID(),
      auditLive: randomUUID(),
      auditRetired: randomUUID(),
      auditClean: randomUUID(),
    };
    /** A table without a primary key, its rows named by `ctid`. */
    const unkeyed = `scrub_live_keys_${randomUUID().replaceAll('-', '')}`;
    /** A table keyed by text, with a text array column. */
    const named = `scrub_live_keys_named_${randomUUID().replaceAll('-', '')}`;
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

    /** A run, with every row it lists by `onLiveApiKey` and `onCounted`. */
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
      const ours = live.filter(
        (row) =>
          row.table === unkeyed || row.table === named || seeded.has(row.row.at(-1) as string),
      );
      return {
        result,
        counted,
        ours,
        /** The seeded rows listed, as `table row principal` — the other test files' rows aside. */
        listed: ours
          .map((row) =>
            row.table === unkeyed
              ? `unkeyed ${row.principalId}`
              : row.table === named
                ? `named ${row.row.join('/')} ${row.principalId}`
                : `${row.table} ${row.row.at(-1)} ${row.principalId}`,
          )
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
      // More rows than a window, inserted in order (`ctid` order, the table being new): a key in
      // the last row of the first window, read once although the next window starts after it,
      // and another, as an object's key, in the last row.
      await pool.query(`create table ${unkeyed} (n integer, doc jsonb)`);
      const filler = `insert into ${unkeyed} select n, jsonb_build_object('n', n) from generate_series($1::integer, $2::integer) n`;
      await pool.query(filler, [1, LIVE_API_KEY_COMPARE_WINDOW - 1]);
      await pool.query(`insert into ${unkeyed} values ($1, $2::jsonb)`, [
        LIVE_API_KEY_COMPARE_WINDOW,
        JSON.stringify({ note: `collector ${serviceKey}` }),
      ]);
      await pool.query(filler, [LIVE_API_KEY_COMPARE_WINDOW + 1, LIVE_API_KEY_COMPARE_WINDOW + 49]);
      await pool.query(`insert into ${unkeyed} values ($1, $2::jsonb)`, [
        LIVE_API_KEY_COMPARE_WINDOW + 50,
        JSON.stringify({ headers: { [memberKey]: true } }),
      ]);
      // A key in a text array, and a key that is the row's primary key: listed masked.
      await pool.query(`create table ${named} (name text primary key, tags text[])`);
      await pool.query(
        `insert into ${named} values ('tagged', $1::text[]), ($2, '{}'), ('plain', '{collector}')`,
        [['collector', serviceKey], memberKey],
      );
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
          `insert into objects (workspace_id, id, object_type, properties)
           values ($1, $2, 'Gatekeeper', '{"name": "collector"}'::jsonb)`,
          [workspaceId, ids.gatekeeper],
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
        // A person pasting their key, the agent echoing the other; neither is ever rewritten.
        await client.query(
          `insert into chat_messages (workspace_id, id, chat_id, turn_id, role, content, sequence)
           values ($1, $2, $3, null, 'user', $4::jsonb, 1),
                  ($1, $5, $3, $6, 'assistant', $7::jsonb, 2)`,
          [
            workspaceId,
            ids.userMessage,
            ids.chat,
            JSON.stringify({ text: `use my key ${memberKey} for this` }),
            ids.assistantMessage,
            ids.turn,
            JSON.stringify({ text: `Done — the collector authenticates as ${serviceKey}.` }),
          ],
        );
        // Standing alone in a JSON value: kept by the rewrite, counted as a key's shape.
        await client.query(
          `insert into chat_messages (workspace_id, id, chat_id, turn_id, role, content, sequence)
           values ($1, $2, $3, $4, 'tool', $5::jsonb, 3)`,
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
        // Two keys in one row: one line each. The result's is in an array.
        await client.query(
          `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id, worker_definition_version, input, result)
           values ($1, $2, 'completed', $3, $4, 1, $5::jsonb, $6::jsonb)`,
          [
            workspaceId,
            ids.task,
            ids.member,
            randomUUID(),
            JSON.stringify({ job: 'collect', with: serviceKey }),
            JSON.stringify({ steps: ['logged in', `as ${memberKey}`] }),
          ],
        );
        // An Operation call's own params, kept as given: it is executed from them.
        await client.query(
          `insert into action_requests
             (workspace_id, id, gatekeeper_id, action_kind, blast_radius, on_behalf_of, actor_runtime, params)
           values ($1, $2, $3, 'opCollect', 'low', $4, 'human', $5::jsonb)`,
          [
            workspaceId,
            ids.actionRequest,
            ids.gatekeeper,
            ids.member,
            JSON.stringify({ apiKey: serviceKey }),
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
      await pool.query(`drop table if exists ${unkeyed}`);
      await pool.query(`drop table if exists ${named}`);
      await pool.end();
    });

    const EVERY_COPY = [
      `action_requests ${ids.actionRequest} ${ids.service}`,
      `activities ${ids.turn} ${ids.service}`,
      `audit_records ${ids.auditLive} ${ids.service}`,
      `chat_messages ${ids.assistantMessage} ${ids.service}`,
      `chat_messages ${ids.toolMessage} ${ids.member}`,
      `chat_messages ${ids.userMessage} ${ids.member}`,
      `named [redacted] ${ids.member}`,
      `named tagged ${ids.service}`,
      `tasks ${ids.task} ${ids.member}`,
      `tasks ${ids.task} ${ids.service}`,
      `unkeyed ${ids.member}`,
      `unkeyed ${ids.service}`,
    ].sort();

    it('lists every stored copy of a key still issued by ids only — the table and row, the Principal, the user', async () => {
      const { result, counted, ours, listed, live } = await run(false);
      expect(listed).toEqual(EVERY_COPY);
      expect(ours.find((row) => row.row.at(-1) === ids.userMessage)).toEqual({
        table: 'chat_messages',
        row: [workspaceId, ids.userMessage],
        principalWorkspaceId: workspaceId,
        principalId: ids.member,
        principalKind: 'human',
        userId,
      });
      expect(ours.find((row) => row.row.at(-1) === ids.auditLive)).toMatchObject({
        row: [ids.auditLive],
        principalKind: 'service',
        userId: null,
      });
      expect(ours.find((row) => row.table === unkeyed)?.row).toEqual([
        expect.stringMatching(/^\(\d+,\d+\)$/),
      ]);
      expect(
        ours.find((row) => row.table === named && row.principalId === ids.member)?.row,
      ).toEqual(['[redacted]']);
      // Two Principals, twelve copies: the keys to rotate are counted once each.
      expect(new Set(ours.map((row) => row.principalId)).size).toBe(2);
      expect(result.liveApiKeys.keys).toBeGreaterThanOrEqual(2);
      expect(result.liveApiKeys.keys).toBeLessThan(result.liveApiKeys.found);
      expect(result.liveApiKeys.found).toBe(live.length);
      expect(result.liveApiKeys.tables).toBeGreaterThan(50);
      expect(result.liveApiKeys.rows).toBeGreaterThan(LIVE_API_KEY_COMPARE_WINDOW);
      // The audit rows holding a key's shape are counted, issued or not; the clean one is not.
      expect(counted).toContainEqual({ category: 'auditPayloads', id: ids.auditLive });
      expect(counted).toContainEqual({ category: 'auditPayloads', id: ids.auditRetired });
      expect(counted).not.toContainEqual({ category: 'auditPayloads', id: ids.auditClean });
      expect(counted).toContainEqual({ category: 'toolCallRecordKeyShapes', id: ids.toolMessage });
      for (const leak of leaks) {
        expect(JSON.stringify({ result, live, counted })).not.toContain(leak);
      }
    }, 300_000);

    it('an executing run lists the key it then hides; a later run cannot see it, nor any key once rotated', async () => {
      const executed = await run(true);
      expect(executed.listed).toEqual(EVERY_COPY);
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
        EVERY_COPY.filter((line) => line !== `activities ${ids.turn} ${ids.service}`),
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
    }, 300_000);
  },
);
