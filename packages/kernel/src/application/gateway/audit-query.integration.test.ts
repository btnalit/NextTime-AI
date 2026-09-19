import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/audit-query.integration.test: DB-gated (auto-skip without DATABASE_URL)
 * wire-shape test for S6-A's `audit_query` keyset pagination (docs/console-completion-plan.md
 * §5.5): top-level `limit` / `cursor` → `{items, nextCursor?, truncated?}` in the same shape
 * `platform_audit_query` / `list_action_requests` use, the legacy `filter.limit` still honored,
 * and the registered `resultSchema` satisfied (`KERNEL_VALIDATE_RESULTS=1`). The same-millisecond
 * boundary property itself is proven at the substrate level (substrate/audit/writer.test.ts).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
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

interface AuditPage {
  items: { id: string; action: string; createdAt: string }[];
  nextCursor?: string;
  truncated?: true;
}

describe.runIf(DATABASE_URL !== undefined)(
  'S6-A audit_query keyset pagination (integration, real Postgres)',
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
            'audit-query-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('pages newest-first with limit/cursor → nextCursor, honors the legacy filter.limit, and flags a clamped limit as truncated', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      // Three dispatched calls → three `new_chat` audit rows for this actor.
      for (let i = 0; i < 3; i += 1) {
        await dispatchCapability({ pool }, owner, 'new_chat', { title: `audit-${i}` });
      }

      const first = (await dispatchCapability({ pool }, owner, 'audit_query', {
        filter: { action: 'new_chat', actorPrincipalId: ownerId },
        limit: 2,
      })) as AuditPage;
      expect(first.items).toHaveLength(2);
      expect(first.items.every((row) => row.action === 'new_chat')).toBe(true);
      expect(typeof first.nextCursor).toBe('string');
      expect(first.truncated).toBeUndefined();
      expect(first.items[0]?.createdAt >= (first.items[1]?.createdAt ?? '')).toBe(true);

      const second = (await dispatchCapability({ pool }, owner, 'audit_query', {
        filter: { action: 'new_chat', actorPrincipalId: ownerId },
        limit: 2,
        cursor: first.nextCursor,
      })) as AuditPage;
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeUndefined();
      const allIds = [...first.items, ...second.items].map((row) => row.id);
      expect(new Set(allIds).size).toBe(3);

      // Legacy shape: `filter.limit` still paginates when no top-level `limit` is given.
      const legacy = (await dispatchCapability({ pool }, owner, 'audit_query', {
        filter: { action: 'new_chat', actorPrincipalId: ownerId, limit: 1 },
      })) as AuditPage;
      expect(legacy.items).toHaveLength(1);
      expect(typeof legacy.nextCursor).toBe('string');

      // Over the ceiling: clamped, reported.
      const huge = (await dispatchCapability({ pool }, owner, 'audit_query', {
        filter: { action: 'new_chat', actorPrincipalId: ownerId },
        limit: 5000,
      })) as AuditPage;
      expect(huge.truncated).toBe(true);
      expect(huge.items).toHaveLength(3);
      expect(huge.nextCursor).toBeUndefined();

      // No params at all is still a valid first page (default limit, no cursor).
      const bare = (await dispatchCapability({ pool }, owner, 'audit_query', {})) as AuditPage;
      expect(bare.items.length).toBeGreaterThanOrEqual(3);
    });
  },
);
