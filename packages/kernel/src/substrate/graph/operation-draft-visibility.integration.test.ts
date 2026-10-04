import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  type GraphReadViewer,
  type OperationVisibilityRow,
  operationDraftVisibleTo,
} from './operation-draft-visibility.js';
import { SqlGraphStore } from './sql-store.js';

/**
 * Parity test (real Postgres; auto-skip without DATABASE_URL) for the two forms of the
 * Operation-draft read rule (STATUS leftover 123): for every combination of a row's `status`
 * (draft / published / deprecated / missing), `proposedBy` (the viewer / someone else / missing)
 * and `proposedByKind` (present / missing), and for a non-reviewer and a reviewer viewer, the TS
 * predicate `operationDraftVisibleTo` and the SQL fragments give the same answer — the object
 * fragment through `SqlGraphStore.getObjectsByIds`, the Fact fragment through `traverse` from an
 * anchor linked to every row. Rows are seeded with raw `properties`, as a legacy writer could have
 * left them, not through the propose/import pipeline (which always writes both proposer fields).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const STATUSES = ['draft', 'published', 'deprecated', undefined] as const;
const PROPOSERS = ['viewer', 'other', undefined] as const;
const KINDS = ['agent', undefined] as const;

describe.runIf(DATABASE_URL !== undefined)(
  'Operation-draft visibility: TS predicate and SQL fragments agree (integration, real Postgres)',
  () => {
    let pool: Pool;
    const store = new SqlGraphStore();
    let workspaceId: string;
    let ownerId: string;
    let anchorId: string;
    let controlId: string;
    const viewerPrincipal = randomUUID();
    const otherPrincipal = randomUUID();
    const rows: { readonly id: string; readonly row: OperationVisibilityRow }[] = [];

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await admin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'operation-draft-parity-test-workspace',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'owner', 'owner')`,
          [workspaceId, ownerId],
        );
      });

      await admin(async (client) => {
        const activity = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by)
           values ($1, 'test.operation-draft-parity', 'completed', $2) returning id`,
          [workspaceId, ownerId],
        );
        const activityId = activity.rows[0]?.id as string;
        anchorId = (await store.upsertObject(client, workspaceId, { objectType: 'test.anchor' }))
          .id;
        // A non-Operation row with a draft-looking status: never narrowed.
        controlId = (
          await store.upsertObject(client, workspaceId, {
            objectType: 'test.thing',
            properties: { status: 'draft', proposedBy: otherPrincipal },
          })
        ).id;
        const linked = [controlId];
        for (const status of STATUSES) {
          for (const proposer of PROPOSERS) {
            for (const kind of KINDS) {
              const proposedBy =
                proposer === 'viewer'
                  ? viewerPrincipal
                  : proposer === 'other'
                    ? otherPrincipal
                    : undefined;
              const properties: Record<string, unknown> = { name: 'parity' };
              if (status !== undefined) properties.status = status;
              if (proposedBy !== undefined) properties.proposedBy = proposedBy;
              if (kind !== undefined) properties.proposedByKind = kind;
              // No identity key: always a fresh row, outside the one-published-per-identity rule.
              const object = await store.upsertObject(client, workspaceId, {
                objectType: 'Operation',
                properties,
              });
              rows.push({ id: object.id, row: { status, proposedBy, proposedByKind: kind } });
              linked.push(object.id);
            }
          }
        }
        for (const targetId of linked) {
          await client.query(
            `insert into links (workspace_id, link_type, source_object_id, target_object_id,
                                properties, valid_from, epistemic_status, activity_id, asserted_by)
             values ($1, 'test.parity', $2, $3, '{}'::jsonb, now(), 'asserted', $4, $5)`,
            [workspaceId, anchorId, targetId, activityId, ownerId],
          );
        }
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    const viewers: readonly [string, GraphReadViewer][] = [
      ['the viewer, not a reviewer', { principalId: viewerPrincipal, seesEveryDraft: false }],
      ['the viewer, a reviewer', { principalId: viewerPrincipal, seesEveryDraft: true }],
      ['someone else, not a reviewer', { principalId: randomUUID(), seesEveryDraft: false }],
      ['someone else, a reviewer', { principalId: randomUUID(), seesEveryDraft: true }],
    ];

    it.each(viewers)(
      '%s: getObjectsByIds and traverse match the TS predicate',
      async (_, viewer) => {
        const expected = rows
          .filter(({ row }) => operationDraftVisibleTo(viewer, row))
          .map(({ id }) => id)
          .concat(controlId)
          .sort();

        const byIds = await asOwner((client) =>
          store.getObjectsByIds(
            client,
            workspaceId,
            [controlId, ...rows.map(({ id }) => id)],
            viewer,
          ),
        );
        expect([...byIds.keys()].sort()).toEqual(expected);

        const walked = await asOwner((client) =>
          store.traverse(client, workspaceId, { fromId: anchorId, direction: 'out' }, viewer),
        );
        expect([...walked.nodes].sort()).toEqual(expected);
      },
    );

    it('the matrix exercises both answers for a non-reviewer (guards against a vacuous pass)', () => {
      const viewer = viewers[0]?.[1] as GraphReadViewer;
      const visible = rows.filter(({ row }) => operationDraftVisibleTo(viewer, row)).length;
      expect(rows).toHaveLength(STATUSES.length * PROPOSERS.length * KINDS.length);
      expect(visible).toBeGreaterThan(0);
      expect(visible).toBeLessThan(rows.length);
      // Exactly one draft-like row per draft status is the viewer's own: proposedBy = viewer with
      // its kind recorded (status 'draft' and status missing).
      const ownDrafts = rows.filter(
        ({ row }) => (row.status ?? 'draft') === 'draft' && operationDraftVisibleTo(viewer, row),
      );
      expect(ownDrafts).toHaveLength(2);
    });
  },
);
