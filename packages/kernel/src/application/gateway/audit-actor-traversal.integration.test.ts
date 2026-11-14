import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_REGISTRY, type Capability, capabilityHasSideEffects } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';
import { humanCaller, newWorkspace, paramsFor, seedWorkspace } from './traversal-fixture.js';

/**
 * Batch D3 (docs/test-coverage-gaps-2026-11-06.md §5.7, gap G11): every audit row a call leaves
 * names the caller it came from — its workspace, its acting Principal, and through which channel.
 * dispatch.ts writes the call's own row; many handlers write domain rows of their own beside it
 * (`chat.rename`, `action_request.approve`, …), each with its own `actorPrincipalId`, and nothing
 * checked those against the caller across the registry.
 *
 * The walk: every workspace capability, as a person (the owner's console session) and as a
 * Handle acting for that person (an ordinary agent session, not an admin agent's), with params
 * built from the capability's schema and pointed at seeded rows. Whatever each call leaves in
 * `audit_records`:
 * - every row is in the caller's workspace with the caller's Principal as actor, and no platform
 *   user (`actor_user_id` is the platform plane's); no row lands in any other workspace or on
 *   the platform plane;
 * - a call that succeeded leaves its own row (`action` = the capability), whose payload says the
 *   channel it came by and whom it was for (`onBehalfOf`), and carries no acting-session fields —
 *   those are an admin agent's (`sessionKind` / `sessionId`, dispatch.ts `actingSessionFields`);
 * - a call that failed leaves nothing, or only a refusal record (`outcome: 'refused'`), which
 *   names the same actor.
 *
 * What is pinned is today's model, per #493 on batch D3: `actor_principal_id` is who is
 * responsible (the person, for an agent acting for them); the channel is told apart in the payload.
 * The planned `acting_through` column and Handle-channel refusal records (kernel thread) will
 * tighten these assertions when they land. Made-up params mean most writes fail before they write,
 * so the walk's floor is on calls that did succeed, observe and side-effecting alike.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Every workspace capability a person or an ordinary agent could call. */
const WORKSPACE_CAPABILITIES = CAPABILITY_REGISTRY.filter(
  (capability) => capability.scope !== 'platform' && !capability.adminAgentOnly,
);

/** Floors on what the walk saw succeed, so it is not vacuous. Today, as a person: 59 reads and 10
 *  side-effecting calls (new_chat, send_chat_message, archive_chat, approve, …); as a Handle: 21
 *  reads (most writes a Handle may make need params made-up ones do not satisfy). */
const MIN_READS = 45;
const MIN_WRITES = 8;
const MIN_HANDLE_READS = 15;

interface AuditRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly actor_principal_id: string | null;
  readonly actor_user_id: string | null;
  readonly action: string;
  readonly payload: Record<string, unknown>;
}

function handleCaller(
  workspaceId: string,
  principalId: string,
  capabilities: string[],
): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo: principalId,
      scope: { capabilities, resources: {} },
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'audit actor over the whole registry — batch D3 / G11 (integration, real Postgres)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool?.end();
    });

    /** Where a walk's audit rows start: every row a call of it writes is written after this
     *  (its transaction's `now()` is later), so a walk compares only its own rows — not, as it did,
     *  every id in a database that a full run has filled (legacy 721: tens of thousands of ids sent
     *  with every call outgrew the test's timeout). */
    async function walkStart(): Promise<{ since: Date; seen: Set<string> }> {
      const result = await pool.query<{ now: Date }>('select clock_timestamp() as now');
      const since = result.rows[0]?.now;
      if (since === undefined) throw new Error('no clock_timestamp()');
      return { since, seen: new Set() };
    }

    async function auditRowsSince(start: { since: Date; seen: Set<string> }): Promise<AuditRow[]> {
      const rows = await pool.query<AuditRow>(
        `select id, workspace_id, actor_principal_id, actor_user_id, action, payload
         from audit_records where created_at >= $1 and not (id = any($2::uuid[]))`,
        [start.since, [...start.seen]],
      );
      for (const row of rows.rows) start.seen.add(row.id);
      return rows.rows;
    }

    /** Walks `capabilities` as the owner of a fresh seeded workspace, by `channel`; returns the
     *  problems found and which capabilities succeeded. */
    async function walk(
      channel: 'human' | 'handle',
      capabilities: readonly Capability[],
    ): Promise<{ problems: string[]; reads: Set<string>; writes: Set<string> }> {
      // A second Principal, so a row naming the wrong actor is one the schema would accept.
      const workspace = await newWorkspace(pool, `audit-actor-${channel}`, ['owner', 'member']);
      const ownerId = workspace.principals.get('owner') as string;
      const seed = await seedWorkspace(
        pool,
        workspace.workspaceId,
        ownerId,
        `audit-${randomUUID()}`,
      );
      const caller =
        channel === 'human'
          ? humanCaller(workspace.workspaceId, ownerId, 'owner')
          : handleCaller(
              workspace.workspaceId,
              ownerId,
              capabilities.map((capability) => capability.name),
            );
      const problems: string[] = [];
      const reads = new Set<string>();
      const writes = new Set<string>();
      const seen = await walkStart();

      for (const capability of capabilities) {
        let succeeded = true;
        try {
          await dispatchCapability(
            { pool },
            caller,
            capability.name,
            paramsFor(capability.paramsSchema, seed),
          );
        } catch {
          succeeded = false;
        }
        const rows = await auditRowsSince(seen);
        const where = `${channel} ${capability.name}${succeeded ? '' : ' (failed)'}`;
        for (const row of rows) {
          if (row.workspace_id !== workspace.workspaceId) {
            problems.push(
              `${where}: row ${row.action} in workspace ${row.workspace_id ?? 'platform'}`,
            );
          }
          if (row.actor_principal_id !== ownerId || row.actor_user_id !== null) {
            problems.push(
              `${where}: row ${row.action} actor ${row.actor_principal_id} / user ${row.actor_user_id}`,
            );
          }
          if (!succeeded && row.payload.outcome !== 'refused') {
            problems.push(`${where}: a failed call left ${row.action} without outcome 'refused'`);
          }
        }
        if (!succeeded) continue;
        (capabilityHasSideEffects(capability) ? writes : reads).add(capability.name);
        const own = rows.filter((row) => row.action === capability.name);
        if (own.length !== 1) {
          problems.push(`${where}: ${own.length} rows with action ${capability.name}, expected 1`);
          continue;
        }
        const payload = (own[0] as AuditRow).payload;
        if (payload.channel !== channel || payload.onBehalfOf !== ownerId) {
          problems.push(
            `${where}: payload channel ${payload.channel} / onBehalfOf ${payload.onBehalfOf}`,
          );
        }
        if ('sessionKind' in payload || 'sessionId' in payload) {
          problems.push(`${where}: an ordinary call's row carries acting-session fields`);
        }
      }
      return { problems, reads, writes };
    }

    it("as a person: every row a call leaves is the person's, in their workspace, by the human channel", async () => {
      const { problems, reads, writes } = await walk('human', WORKSPACE_CAPABILITIES);
      expect(problems).toEqual([]);
      expect(reads.size).toBeGreaterThanOrEqual(MIN_READS);
      expect(writes.size).toBeGreaterThanOrEqual(MIN_WRITES);
    });

    it('as an agent Handle acting for the person: the person is the actor, the channel says handle', async () => {
      const { problems, reads } = await walk(
        'handle',
        WORKSPACE_CAPABILITIES.filter((capability) => capability.channel !== 'human'),
      );
      expect(problems).toEqual([]);
      expect(reads.size).toBeGreaterThanOrEqual(MIN_HANDLE_READS);
    });
  },
);
