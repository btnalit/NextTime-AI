import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { SqlGraphStore } from '../graph/index.js';
import {
  MAX_AUDIT_QUERY_LIMIT,
  decodeAuditCursor,
  encodeAuditCursor,
  queryAudit,
  queryAuditPage,
  writeAudit,
} from './writer.js';

/**
 * substrate/audit/writer.test: integration tests (real Postgres; auto-skip without DATABASE_URL)
 * for `writeAudit`/`queryAudit`, including docs/development-tasks.md S1.3's acceptance
 * criterion "audit 写失败整体回滚" at the primitive level (application/gateway/dispatch.test.ts
 * covers the same property through `dispatchCapability` itself).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

// S6-A `audit_query` keyset cursor (docs/console-completion-plan.md §5.5) — pure encode/decode,
// no DB. Same "malformed reads as no cursor" contract as the other keyset cursors in this repo.
describe('audit cursor encode/decode (unit, no DB)', () => {
  it('round-trips (createdAt, id) through an opaque base64url string', () => {
    const at = new Date('2026-09-19T10:11:12.345Z');
    const id = randomUUID();
    const cursor = encodeAuditCursor(at, id);
    expect(cursor).not.toContain('|');
    expect(decodeAuditCursor(cursor)).toEqual({ createdAt: at.toISOString(), id });
  });

  it('treats undefined, empty, non-base64, missing separator, bad timestamp and non-uuid id as no cursor', () => {
    expect(decodeAuditCursor(undefined)).toBeNull();
    expect(decodeAuditCursor('')).toBeNull();
    expect(decodeAuditCursor('!!not-base64!!')).toBeNull();
    expect(decodeAuditCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toBeNull();
    expect(
      decodeAuditCursor(Buffer.from(`not-a-date|${randomUUID()}`, 'utf8').toString('base64url')),
    ).toBeNull();
    expect(
      decodeAuditCursor(
        Buffer.from('2026-09-19T10:11:12.345Z|not-a-uuid', 'utf8').toString('base64url'),
      ),
    ).toBeNull();
  });
});

describe.runIf(DATABASE_URL !== undefined)(
  'substrate/audit/writer (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

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
            'audit-writer-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, ownerId, 'human', 'owner', 'owner'],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('writeAudit appends a row; queryAudit finds it by action/resource', async () => {
      const resourceId = randomUUID();
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        writeAudit(client, {
          workspaceId,
          actorPrincipalId: ownerId,
          action: 'test.write',
          resourceType: 'object',
          resourceId,
          payload: { note: 'hello' },
        }),
      );

      const found = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, { action: 'test.write', resourceId }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.actorPrincipalId).toBe(ownerId);
      expect(found[0]?.payload).toEqual({ note: 'hello' });
    });

    it('audit_records is append-only: an UPDATE is rejected by the DB trigger (I11/0004_audit.sql)', async () => {
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        writeAudit(client, { workspaceId, actorPrincipalId: ownerId, action: 'test.immutable' }),
      );

      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query('update audit_records set action = $1 where workspace_id = $2 and id = $3', [
            'tampered',
            workspaceId,
            row.id,
          ]),
        ),
      ).rejects.toThrow();
    });

    // S6-A `audit_query` keyset pagination (docs/console-completion-plan.md §5.5; the leftover-23
    // pattern, docs/STATUS.md §4 row 23): rows written in the *same millisecond* must not be
    // skipped at a page boundary. `audit_records` is append-only (no back-dating after insert), so
    // the rows are inserted with an explicit, shared `created_at` — plus one a microsecond later
    // in the same millisecond, the exact case a raw `created_at <` comparison would lose.
    it('queryAuditPage: same-millisecond rows are not skipped across a limit:1 page boundary; pages end with no nextCursor', async () => {
      const resourceId = randomUUID();
      const base = new Date('2026-09-19T08:00:00.500Z');
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        // Two rows at exactly `base`, one at base + 1µs (still the same millisecond).
        await client.query(
          `insert into audit_records (workspace_id, id, actor_principal_id, action, resource_type, resource_id, payload, created_at)
           values ($1, $3, $2, 'test.page', 'thing', $6, '{}'::jsonb, $7::timestamptz),
                  ($1, $4, $2, 'test.page', 'thing', $6, '{}'::jsonb, $7::timestamptz),
                  ($1, $5, $2, 'test.page', 'thing', $6, '{}'::jsonb, $7::timestamptz + interval '1 microsecond')`,
          [workspaceId, ownerId, ids[0], ids[1], ids[2], resourceId, base.toISOString()],
        );
      });

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          queryAuditPage(client, workspaceId, { resourceId, limit: 1, cursor }),
        );
        expect(page.items.length).toBeLessThanOrEqual(1);
        for (const row of page.items) seen.push(row.id);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(3);
      expect(seen.sort()).toEqual([...ids].sort());

      // The ordering is total and deterministic: (ms-truncated created_at desc, id desc).
      const all = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAuditPage(client, workspaceId, { resourceId }),
      );
      expect(all.nextCursor).toBeUndefined();
      expect(all.items.map((row) => row.id)).toEqual([...ids].sort().reverse());
      // And `queryAudit` (the plain-array read) still returns the same rows.
      const plain = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, { resourceId }),
      );
      expect(plain.map((row) => row.id)).toEqual(all.items.map((row) => row.id));
    });

    it('queryAuditPage: a malformed cursor reads as the first page; limit is clamped to MAX_AUDIT_QUERY_LIMIT', async () => {
      const resourceId = randomUUID();
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        writeAudit(client, {
          workspaceId,
          actorPrincipalId: ownerId,
          action: 'test.bad_cursor',
          resourceId,
        }),
      );
      const page = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAuditPage(client, workspaceId, {
          resourceId,
          cursor: 'definitely-not-a-cursor',
          limit: MAX_AUDIT_QUERY_LIMIT * 10,
        }),
      );
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeUndefined();
    });

    // 遗留 54 / migration core 0032 (2026-09-22 review of PR #221): `audit_records_actor_shape`
    // legalizes an actor-less platform row (`workspace_id`/`actor_principal_id` both null,
    // `actor_user_id` null) for exactly one shape — `action = 'platform.workspace_purged'` with
    // `payload.attributedActor` the JSON boolean `false` — and rejects every other actor-less
    // platform row, so a future bug in an unrelated write path cannot silently start writing
    // unattributed rows too.
    describe('audit_records_actor_shape (遗留 54, migration core 0032)', () => {
      // These write a platform row (`workspace_id is null`) directly through `writeAudit`, the
      // same shape `purgeWorkspace` itself writes — that only ever runs on the admin/skip-role-
      // switch path (RLS's own `audit_records_workspace_isolation` policy requires `app.platform
      // = on` for a `workspace_id is null` row otherwise; `purge-workspace.ts`'s own doc comment
      // — "why the superuser path" — has the detail), so these tests use it too.
      it('accepts an actor-less platform.workspace_purged row with payload.attributedActor: false', async () => {
        const resourceId = randomUUID();
        const row = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            writeAudit(client, {
              workspaceId: null,
              actorPrincipalId: null,
              action: 'platform.workspace_purged',
              resourceType: 'workspace',
              resourceId,
              payload: { attributedActor: false },
            }),
          { skipRoleSwitch: true },
        );
        expect(row.actorUserId).toBeNull();
      });

      it('rejects an actor-less platform row for any other action, even with attributedActor: false', async () => {
        await expect(
          withWorkspace(
            pool,
            { workspaceId, principalId: ownerId },
            (client) =>
              writeAudit(client, {
                workspaceId: null,
                actorPrincipalId: null,
                action: 'platform.user_purged',
                payload: { attributedActor: false },
              }),
            { skipRoleSwitch: true },
          ),
        ).rejects.toThrow(/audit_records_actor_shape/);
      });

      it('rejects an actor-less platform.workspace_purged row when attributedActor is missing or true', async () => {
        await expect(
          withWorkspace(
            pool,
            { workspaceId, principalId: ownerId },
            (client) =>
              writeAudit(client, {
                workspaceId: null,
                actorPrincipalId: null,
                action: 'platform.workspace_purged',
                payload: {},
              }),
            { skipRoleSwitch: true },
          ),
        ).rejects.toThrow(/audit_records_actor_shape/);

        await expect(
          withWorkspace(
            pool,
            { workspaceId, principalId: ownerId },
            (client) =>
              writeAudit(client, {
                workspaceId: null,
                actorPrincipalId: null,
                action: 'platform.workspace_purged',
                payload: { attributedActor: true },
              }),
            { skipRoleSwitch: true },
          ),
        ).rejects.toThrow(/audit_records_actor_shape/);
      });
    });

    it('a failing audit write rolls back a prior write in the same transaction (S1.3 acceptance)', async () => {
      const store = new SqlGraphStore();
      const nonExistentActor = randomUUID(); // no principals row — FK violation forces the failure

      let attemptedObjectId = '';
      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const object = await store.upsertObject(client, workspaceId, {
            objectType: 'test.audit-rollback',
          });
          attemptedObjectId = object.id;
          await writeAudit(client, {
            workspaceId,
            actorPrincipalId: nonExistentActor,
            action: 'test.forced_failure',
          });
        }),
      ).rejects.toThrow();

      const survived = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query('select id from objects where id = $1', [attemptedObjectId]),
      );
      expect(survived.rows).toHaveLength(0);
    });
  },
);
