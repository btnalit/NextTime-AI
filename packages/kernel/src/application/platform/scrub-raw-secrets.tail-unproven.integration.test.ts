import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { RAW_SECRET_SCRUB_AUDIT_ACTION, scrubRawSecrets } from './scrub-raw-secrets.js';

/**
 * application/platform/scrub-raw-secrets.tail-unproven.integration.test: DB-gated (real Postgres;
 * auto-skip without DATABASE_URL). «收尾未证明» (`tailUnproven`, redaction boundary stage 1b;
 * `docs/redaction-boundary-design-2026-11-27.md` §4.3, D3): in each of its eight categories, a row
 * the reading as it was leaves as it is and the tail check would hide more in is counted apart —
 * its own count, ids and callback — and never rewritten, not by `--yes` nor by a second run; a row
 * already masked cleanly (the forms the value rules themselves write, `"[redacted]"[redacted] y`
 * among them) is in neither count; a row the reading as it was already finds is counted there
 * («密钥残留») and not here.
 *
 * The scrub reads the whole database, and other test files run alongside: assertions are about the
 * seeded rows (collected through the uncapped callbacks), the counts only bound from below.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const R = '[redacted]';
/** No value pattern knows it: only a field name gives it away. */
const PLAIN = 'hunter2-plain-word';
/** Masked in part by an earlier release, harmless code after it (design §4.3): the check cannot
 *  tell this from a secret left over, so it is a row to look at. */
const HALF_MASKED = `TOKEN = ${R}'abc');`;
const UNPROVEN = [HALF_MASKED, `API_TOKEN=${R}'abc' rest`, `the token=${R}-x rest`];
/** Legacy 951's own form: a tail an earlier release left after the mask it wrote. The counted
 *  categories' readings never saw it; the tail check hides it, so it is counted here. */
const FAKE = 'FAKEabcdefghijklmnopqrstuvwxyz';
const LEFT_OVER = `TOKEN="${R}"${FAKE}`;
/** Masked cleanly, as the value rules write a value: in neither count. */
const CLEAN = [`export TOKEN="${R}"; curl x | sh`, `TOKEN=\\"${R}\\"${R} y`, `x='${R}'${R} y`];

describe.runIf(DATABASE_URL !== undefined)(
  'scrubRawSecrets (integration, real Postgres) — rows whose mask the tail check does not prove closed',
  () => {
    let pool: Pool;
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    const chatId = randomUUID();
    const ids = {
      turn: randomUUID(),
      cleanTurn: randomUUID(),
      decision: randomUUID(),
      cleanDecision: randomUUID(),
      tool: randomUUID(),
      cleanTool: randomUUID(),
      task: randomUUID(),
      // Found by the reading as it was: «密钥残留», not here.
      countedTask: randomUUID(),
      cleanTask: randomUUID(),
      object: randomUUID(),
      cleanObject: randomUUID(),
      fact: randomUUID(),
      cleanFact: randomUUID(),
      completeAudit: randomUUID(),
      failAudit: randomUUID(),
      noteAudit: randomUUID(),
      cleanAudit: randomUUID(),
    };
    const seeded = new Set<string>(Object.values(ids));
    const tool = (text: string) => ({
      kind: 'tool_call',
      text: 'some_tool',
      toolCallId: `call_${randomUUID().slice(0, 8)}`,
      name: 'some_tool',
      outcome: 'done',
      result: { text, totalChars: text.length, truncated: false },
      redactedValues: 1,
      startedAt: null,
      endedAt: null,
    });

    function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    /** Every seeded row as stored, by id. */
    async function snapshot(): Promise<Record<string, unknown>> {
      return admin(async (client) => {
        const rows = await client.query<{ id: string; value: unknown }>(
          `select id, metadata as value from activities where workspace_id = $1
           union all select id, to_jsonb(summary) from decisions where workspace_id = $1
           union all select id, content from chat_messages where workspace_id = $1
           union all select id, input from tasks where workspace_id = $1
           union all select id, properties from objects where workspace_id = $1
           union all select id, properties from links where workspace_id = $1
           union all select id, payload from audit_records where workspace_id = $1`,
          [workspaceId],
        );
        return Object.fromEntries(rows.rows.map((row) => [row.id, row.value]));
      });
    }

    /** A run, with the seeded rows each callback named. */
    async function run(confirm: boolean) {
      const unproven: string[] = [];
      const counted: string[] = [];
      const result = await scrubRawSecrets(pool, {
        confirm,
        batchSize: 5,
        onTailUnproven: (category, row) => {
          if (seeded.has(row.id)) unproven.push(`${category} ${row.id}`);
        },
        onCounted: (category, row) => {
          if (seeded.has(row.id)) counted.push(`${category} ${row.id}`);
        },
      });
      return { result, unproven: unproven.sort(), counted: counted.sort() };
    }

    const expectedUnproven = () =>
      [
        `turnReports ${ids.turn}`,
        `decisions ${ids.decision}`,
        `toolCallRecords ${ids.tool}`,
        `taskInputs ${ids.task}`,
        `objectProperties ${ids.object}`,
        `factProperties ${ids.fact}`,
        `auditResults ${ids.completeAudit}`,
        `auditResults ${ids.failAudit}`,
        // A payload's copy of a result or a reason is read by the payload rule too.
        `auditPayloads ${ids.completeAudit}`,
        `auditPayloads ${ids.failAudit}`,
        `auditPayloads ${ids.noteAudit}`,
      ].sort();

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      await admin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'scrub-tail-unproven-test',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')`,
          [workspaceId, ownerId],
        );
        await client.query(
          'insert into chats (workspace_id, id, owner_principal_id) values ($1, $2, $3)',
          [workspaceId, chatId, ownerId],
        );
        await client.query(
          `insert into activities (workspace_id, id, kind, chat_id, sequence, status, metadata, started_by)
           values ($1, $2, 'agent_turn', $3, 1, 'completed', $4::jsonb, $6),
                  ($1, $5, 'agent_turn', $3, 2, 'completed', $7::jsonb, $6)`,
          [
            workspaceId,
            ids.turn,
            chatId,
            JSON.stringify({ summary: HALF_MASKED, decisions: ['keep it'], model: 'm' }),
            ids.cleanTurn,
            ownerId,
            JSON.stringify({ summary: CLEAN[0], decisions: CLEAN, model: 'm' }),
          ],
        );
        await client.query(
          `insert into decisions (workspace_id, id, activity_id, summary) values
             ($1, $2, $3, $4), ($1, $5, $3, $6)`,
          [workspaceId, ids.decision, ids.turn, UNPROVEN[2], ids.cleanDecision, CLEAN[2]],
        );
        await client.query(
          `insert into chat_messages (workspace_id, id, chat_id, turn_id, role, content, sequence) values
             ($1, $2, $3, $4, 'tool', $5::jsonb, 1), ($1, $6, $3, $4, 'tool', $7::jsonb, 2)`,
          [
            workspaceId,
            ids.tool,
            chatId,
            ids.turn,
            JSON.stringify(tool(JSON.stringify({ out: HALF_MASKED }))),
            ids.cleanTool,
            JSON.stringify(tool(JSON.stringify({ password: R, note: CLEAN[0] }))),
          ],
        );
        for (const [id, input] of [
          [ids.task, { note: UNPROVEN[1] }],
          [ids.countedTask, { note: UNPROVEN[1], db: { password: PLAIN } }],
          [ids.cleanTask, { note: CLEAN[1] }],
        ] as const) {
          await client.query(
            `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id, worker_definition_version, input)
             values ($1, $2, 'completed', $3, $4, 1, $5::jsonb)`,
            [workspaceId, id, ownerId, randomUUID(), JSON.stringify(input)],
          );
        }
        await client.query(
          `insert into objects (workspace_id, id, object_type, properties) values
             ($1, $2, 'Container', $3::jsonb), ($1, $4, 'Container', $5::jsonb)`,
          [
            workspaceId,
            ids.object,
            JSON.stringify({ image: 'app:1', cmd: LEFT_OVER }),
            ids.cleanObject,
            JSON.stringify({ image: 'app:1', cmd: CLEAN[0] }),
          ],
        );
        for (const [id, properties] of [
          [ids.fact, { note: LEFT_OVER }],
          [ids.cleanFact, { note: CLEAN[2] }],
        ] as const) {
          await client.query(
            `insert into links (workspace_id, id, link_type, source_object_id, target_object_id, properties,
                                epistemic_status, activity_id, asserted_by)
             values ($1, $2, 'runs_on', $3, $4, $5::jsonb, 'asserted', $6, $7)`,
            [
              workspaceId,
              id,
              ids.object,
              ids.cleanObject,
              JSON.stringify(properties),
              ids.turn,
              ownerId,
            ],
          );
        }
        await client.query(
          `insert into audit_records (workspace_id, id, actor_principal_id, action, resource_type, resource_id, payload) values
             ($1, $2, $3, 'action_request.complete', 'action_request', $4, $5::jsonb),
             ($1, $6, $3, 'action_request.fail', 'action_request', $4, $7::jsonb),
             ($1, $8, $3, 'test.tail_unproven_note', 'platform', null, $9::jsonb),
             ($1, $10, $3, 'test.tail_unproven_note', 'platform', null, $11::jsonb)`,
          [
            workspaceId,
            ids.completeAudit,
            ownerId,
            randomUUID(),
            JSON.stringify({ resultingStatus: 'executed', resultMetadata: { out: HALF_MASKED } }),
            ids.failAudit,
            JSON.stringify({ resultingStatus: 'failed', reason: UNPROVEN[1] }),
            ids.noteAudit,
            JSON.stringify({ note: LEFT_OVER }),
            ids.cleanAudit,
            JSON.stringify({ note: CLEAN[0], also: CLEAN[1] }),
          ],
        );
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a dry run counts each such row apart, by id, and writes nothing', async () => {
      const before = await snapshot();
      const { result, unproven, counted } = await run(false);
      expect(unproven).toEqual(expectedUnproven());
      // The reading as it was finds this one: «密钥残留», counted there only.
      expect(counted).toEqual([`taskInputs ${ids.countedTask}`]);
      for (const name of Object.keys(result.tailUnproven) as (keyof typeof result.tailUnproven)[]) {
        const seededHere = expectedUnproven().filter((line) => line.startsWith(`${name} `)).length;
        expect(result.tailUnproven[name].rows).toBeGreaterThanOrEqual(seededHere);
        expect(result.tailUnproven[name].examples.length).toBeLessThanOrEqual(20);
      }
      // Not a rewrite: the three rewritten categories rewrite none of them.
      expect(await snapshot()).toEqual(before);
    }, 180_000);

    it('--yes rewrites none of them, audits the counts with ids only, and a second run counts them again', async () => {
      const before = await snapshot();
      const first = await run(true);
      expect(first.unproven).toEqual(expectedUnproven());
      expect(await snapshot()).toEqual(before);
      const audit = await admin(
        async (client) =>
          (
            await client.query<{ payload: Record<string, unknown> }>(
              'select payload from audit_records where id = $1',
              [first.result.auditRecordId],
            )
          ).rows[0],
      );
      const payload = audit?.payload as { tailUnproven?: Record<string, { rows: number }> };
      expect(payload.tailUnproven?.turnReports?.rows).toBeGreaterThanOrEqual(1);
      expect(payload.tailUnproven?.auditPayloads?.rows).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(audit?.payload)).not.toContain("'abc'");
      expect(JSON.stringify(audit?.payload)).not.toContain(PLAIN);
      expect(JSON.stringify(audit?.payload)).not.toContain(FAKE);
      expect(
        await admin(
          async (client) =>
            (
              await client.query('select action from audit_records where id = $1', [
                first.result.auditRecordId,
              ])
            ).rows[0]?.action,
        ),
      ).toBe(RAW_SECRET_SCRUB_AUDIT_ACTION);

      const second = await run(true);
      expect(second.unproven).toEqual(expectedUnproven());
      expect(await snapshot()).toEqual(before);
    }, 360_000);
  },
);
