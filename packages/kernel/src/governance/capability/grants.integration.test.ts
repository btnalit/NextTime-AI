import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { computeActionRequestHolders } from '../approval/routing.js';
import { grantCapability, hasActiveGrant, listGrantHolderPrincipalIds } from './grants.js';

/**
 * governance/capability/grants.integration.test.ts (W7): grant matching against a *non-uuid*
 * resource scope. `capability_grants.resource_id` is `uuid`, an ActionRequest's `resource_scope`
 * is free text — before the `resource_id::text` comparison in grants.ts, any non-uuid scope made
 * Postgres abort the query with 22P02, which (a) turned the I14 approver precheck into a 500 and
 * (b) silently killed application/linkage's ActionRequestUpdated consumer (the outbox dispatcher
 * swallows consumer errors), so no approval status line ever reached the chat. Caught by the first
 * CI run of packages/web/e2e/approvals.spec.ts, whose seeded rows use `e2e-approve-flow` scopes.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'governance/capability/grants — non-uuid resource scopes (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let operatorId: string;
    const wildcardKind = 'e2e.approval_card_test';
    const scopedKind = 'e2e.scoped_kind';
    const scopedResourceId = randomUUID();

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      ownerId = randomUUID();
      operatorId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'grants-non-uuid-scope-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5), ($1, $6, $3, $7, $8)',
            [workspaceId, ownerId, 'human', 'owner', 'owner', operatorId, 'operator', 'operator'],
          );
          // A wildcard grant (no resourceId) on one action kind, and a uuid-scoped grant on another.
          await grantCapability(client, workspaceId, {
            principalId: operatorId,
            resourceType: wildcardKind,
            grantedBy: ownerId,
          });
          await grantCapability(client, workspaceId, {
            principalId: operatorId,
            resourceType: scopedKind,
            resourceId: scopedResourceId,
            grantedBy: ownerId,
          });
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('hasActiveGrant: a wildcard grant matches a free-text scope instead of throwing 22P02', async () => {
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        await expect(
          hasActiveGrant(client, workspaceId, {
            principalId: operatorId,
            resourceType: wildcardKind,
            resourceId: 'e2e-approve-flow',
          }),
        ).resolves.toBe(true);
        await expect(
          hasActiveGrant(client, workspaceId, {
            principalId: operatorId,
            resourceType: 'some.other_kind',
            resourceId: 'e2e-approve-flow',
          }),
        ).resolves.toBe(false);
      });
    });

    it('hasActiveGrant: a uuid-scoped grant still matches exactly, and never a non-uuid scope', async () => {
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        await expect(
          hasActiveGrant(client, workspaceId, {
            principalId: operatorId,
            resourceType: scopedKind,
            resourceId: scopedResourceId,
          }),
        ).resolves.toBe(true);
        await expect(
          hasActiveGrant(client, workspaceId, {
            principalId: operatorId,
            resourceType: scopedKind,
            resourceId: randomUUID(),
          }),
        ).resolves.toBe(false);
        await expect(
          hasActiveGrant(client, workspaceId, {
            principalId: operatorId,
            resourceType: scopedKind,
            resourceId: 'not-a-uuid',
          }),
        ).resolves.toBe(false);
      });
    });

    it('listGrantHolderPrincipalIds / computeActionRequestHolders: free-text scope → owner + wildcard holder', async () => {
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        await expect(
          listGrantHolderPrincipalIds(client, workspaceId, {
            resourceType: wildcardKind,
            resourceId: 'e2e-isolation-flow',
          }),
        ).resolves.toEqual([operatorId]);

        const holders = await computeActionRequestHolders(client, workspaceId, {
          actionKind: wildcardKind,
          resourceScope: 'e2e-isolation-flow',
        });
        expect([...holders].sort()).toEqual([ownerId, operatorId].sort());

        const scopedHolders = await computeActionRequestHolders(client, workspaceId, {
          actionKind: scopedKind,
          resourceScope: 'not-a-uuid',
        });
        expect(scopedHolders).toEqual([ownerId]);
      });
    });
  },
);
