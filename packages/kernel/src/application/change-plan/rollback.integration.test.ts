import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  type ActionTypeDefinition,
  type OntologyDefinition,
  deriveOntologyPackId,
  publishOntologyVersion,
} from '../../substrate/ontology/index.js';
import {
  ChangeConfirmationRequiredError,
  ChangeRollbackConflictError,
  ChangeSegmentNotFoundError,
  ChangeSegmentRolledBackError,
  type PlannedItemRollback,
  type WorkspaceSegmentInput,
  applyWorkspaceSegment,
  contentDigest,
  inspectChangeSegment,
  listChangeSegments,
  loadOntologyProvenance,
  planWorkspaceSegment,
  previewSegmentRollback,
  rollBackWorkspaceSegment,
} from './index.js';

/**
 * application/change-plan — rollback.integration (S11 P1-B): reading applied segments back
 * (list, keyset pages, one segment with each item's state now), the rollback dry run, and rolling a
 * segment back — the version an item published retired so the head is the one before again (or
 * none), compare before writing (a later change, a missing version to return to, a type name taken
 * since: refused, nothing written), the rollback classified by the same whitelist and its widening
 * items confirmed one by one, already rolled back refused, two concurrent rollbacks one after the
 * other, one audit row per item, and the graph rows using a type taken out counted and kept.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

/** An ontology item's rollback (`undefined` for another kind). */
const ontologyOf = (item: PlannedItemRollback | undefined) =>
  item?.detail.kind === 'ontology_version' ? item.detail.planned : undefined;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const RESTART: ActionTypeDefinition = {
  name: 'restart',
  description: 'restart a thing',
  mode: 'execute',
  blastRadius: 'medium',
};

function definitionOf(
  objectTypes: readonly string[],
  options: { readonly link?: string; readonly actions?: readonly ActionTypeDefinition[] } = {},
): OntologyDefinition {
  const [first] = objectTypes;
  if (!first) throw new Error('definitionOf: at least one ObjectType');
  return {
    objectTypes: objectTypes.map((name) => ({ name, description: 'd' })),
    linkTypes: [
      {
        name: options.link ?? `${first.toLowerCase()}_of`,
        domain: first,
        range: '*',
        description: 'd',
      },
    ],
    ...(options.actions ? { actionTypes: [...options.actions] } : {}),
  };
}

type Ws = { readonly workspaceId: string; readonly ownerId: string };

describe.runIf(DATABASE_URL !== undefined)(
  'application/change-plan — segment reads and rollback (S11 P1-B, integration, real Postgres)',
  () => {
    let pool: Pool;

    async function newWorkspace(): Promise<Ws> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1-change-rollback',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      return { workspaceId, ownerId };
    }

    const inWorkspace = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn);

    /** As the database owner, bypassing the app role — what no capability can do. */
    const asOwner = <T>(ws: Ws, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn, {
        skipRoleSwitch: true,
      });

    function segment(
      family: string,
      definition: OntologyDefinition,
      version = '1',
    ): WorkspaceSegmentInput {
      return {
        source: { kind: 'pack', name: family, version, digest: contentDigest(definition) },
        items: [{ kind: 'ontology_version', family, definition }],
      };
    }

    /** Plans and applies `input` in `client`'s transaction; returns the segment id. */
    async function applyIn(
      client: PoolClient,
      ws: Ws,
      input: WorkspaceSegmentInput,
      confirmedOrdinals: readonly number[] = [],
    ): Promise<string> {
      const planned = await planWorkspaceSegment(client, ws.workspaceId, input);
      const applied = await applyWorkspaceSegment(client, ws.workspaceId, {
        ...input,
        reviewedDigest: planned.digest,
        proposedBy: ws.ownerId,
        appliedBy: ws.ownerId,
        channel: 'human',
        confirmedOrdinals,
      });
      if (!applied.segmentId) throw new Error('applyIn: nothing applied');
      return applied.segmentId;
    }

    const apply = (ws: Ws, input: WorkspaceSegmentInput, confirmedOrdinals?: readonly number[]) =>
      inWorkspace(ws, (client) => applyIn(client, ws, input, confirmedOrdinals));

    const rollBack = (ws: Ws, segmentId: string, confirmedOrdinals: readonly number[] = []) =>
      inWorkspace(ws, (client) =>
        rollBackWorkspaceSegment(client, ws.workspaceId, {
          segmentId,
          rolledBackBy: ws.ownerId,
          confirmedOrdinals,
        }),
      );

    const preview = (ws: Ws, segmentId: string) =>
      inWorkspace(ws, (client) => previewSegmentRollback(client, ws.workspaceId, segmentId));

    const inspect = (ws: Ws, segmentId: string) =>
      inWorkspace(ws, (client) => inspectChangeSegment(client, ws.workspaceId, segmentId));

    const provenance = (ws: Ws, family: string) =>
      inWorkspace(ws, (client) => loadOntologyProvenance(client, ws.workspaceId, family));

    const rows = (ws: Ws, text: string, params: readonly unknown[] = []) =>
      inWorkspace(
        ws,
        async (client) => (await client.query(text, [ws.workspaceId, ...params])).rows,
      );

    const familyVersions = (ws: Ws, family: string) =>
      rows(
        ws,
        'select version, status from ontology_versions where workspace_id = $1 and id = $2 order by version',
        [deriveOntologyPackId(family)],
      );

    const rollbackAudit = (ws: Ws) =>
      rows(
        ws,
        `select resource_id, actor_principal_id, payload from audit_records
          where workspace_id = $1 and action = 'change_item.roll_back' order by created_at, id`,
      );

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('rolling back a first install', () => {
      it('retires the version it published, keeps the data, records who and one audit row per item', async () => {
        const ws = await newWorkspace();
        const definition = definitionOf(['ThingR']);
        const segmentId = await apply(ws, segment('fam-r', definition));
        const ontologyId = deriveOntologyPackId('fam-r');

        // Data written against its types stays; the dry run counts it.
        await asOwner(ws, async (client) => {
          const ids: string[] = [];
          for (const key of ['r1', 'r2']) {
            const inserted = await client.query<{ id: string }>(
              `insert into objects (workspace_id, object_type, identity_key, properties)
               values ($1, 'ThingR', $2::jsonb, '{}'::jsonb) returning id`,
              [ws.workspaceId, JSON.stringify({ key })],
            );
            ids.push(inserted.rows[0]?.id as string);
          }
          const activity = await client.query<{ id: string }>(
            `insert into activities (workspace_id, kind, status, started_by)
             values ($1, 'test.change-rollback', 'completed', $2) returning id`,
            [ws.workspaceId, ws.ownerId],
          );
          await client.query(
            `insert into links (workspace_id, link_type, source_object_id, target_object_id,
                                properties, valid_from, epistemic_status, activity_id, asserted_by)
             values ($1, 'thingr_of', $2, $3, '{}'::jsonb, now(), 'asserted', $4, $5)`,
            [ws.workspaceId, ids[0], ids[1], activity.rows[0]?.id, ws.ownerId],
          );
        });

        const dryRun = await preview(ws, segmentId);
        expect(dryRun.possible).toBe(true);
        expect(dryRun.inUse).toEqual({ objects: 2, links: 1, capped: false });
        expect(dryRun.items).toHaveLength(1);
        expect(dryRun.items[0]).toMatchObject({
          classification: 'not_widening',
          widening: [],
          conflict: null,
          detail: {
            kind: 'ontology_version',
            planned: {
              target: { family: 'fam-r', ontologyId },
              from: { version: 1, definitionDigest: contentDigest(definition) },
              to: null,
              removes: { objectTypes: ['ThingR'], linkTypes: ['thingr_of'], actionTypes: [] },
              blocker: null,
            },
          },
        });
        // The dry run wrote nothing.
        expect(await familyVersions(ws, 'fam-r')).toEqual([{ version: 1, status: 'published' }]);

        const after = await rollBack(ws, segmentId);
        expect(after).toMatchObject({
          id: segmentId,
          status: 'rolled_back',
          rolledBackBy: { id: ws.ownerId, kind: 'human', displayName: 'owner' },
        });
        expect(after.rolledBackAt).toBeInstanceOf(Date);
        expect(await familyVersions(ws, 'fam-r')).toEqual([{ version: 1, status: 'deprecated' }]);
        expect(await provenance(ws, 'fam-r')).toEqual({ status: 'not_installed' });
        expect(
          await rows(ws, 'select count(*)::int as n from objects where workspace_id = $1'),
        ).toEqual([{ n: 2 }]);

        const detail = await inspect(ws, segmentId);
        expect(detail.items.map((item) => [item.state, item.replacedBy])).toEqual([
          ['not_installed', null],
        ]);

        const audit = await rollbackAudit(ws);
        expect(audit).toEqual([
          {
            resource_id: detail.items[0]?.record.id,
            actor_principal_id: ws.ownerId,
            payload: expect.objectContaining({
              channel: 'human',
              segmentId,
              ordinal: 1,
              kind: 'ontology_version',
              target: { family: 'fam-r', ontologyId },
              from: { version: 1, definitionDigest: contentDigest(definition) },
              to: null,
              headVersion: null,
              classification: 'not_widening',
              confirmedBy: null,
            }),
          },
        ]);

        // Once is final: refused again, and the dry run says so.
        await expect(rollBack(ws, segmentId)).rejects.toBeInstanceOf(ChangeSegmentRolledBackError);
        expect((await preview(ws, segmentId)).possible).toBe(false);

        // Installing again takes the next version number; a retired one is never reused.
        await apply(ws, segment('fam-r', definition));
        expect(await familyVersions(ws, 'fam-r')).toEqual([
          { version: 1, status: 'deprecated' },
          { version: 2, status: 'published' },
        ]);
      });

      it('a LinkType another family still declares is not counted as taken out', async () => {
        const ws = await newWorkspace();
        await apply(ws, segment('fam-keep', definitionOf(['ThingK'], { link: 'shared_link' })));
        const segmentId = await apply(
          ws,
          segment('fam-drop', definitionOf(['ThingD'], { link: 'shared_link' })),
        );
        const dryRun = await preview(ws, segmentId);
        expect(ontologyOf(dryRun.items[0])?.removes.linkTypes).toEqual(['shared_link']);
        await asOwner(ws, async (client) => {
          const a = await client.query<{ id: string }>(
            `insert into objects (workspace_id, object_type, properties)
             values ($1, 'ThingK', '{}'::jsonb) returning id`,
            [ws.workspaceId],
          );
          const activity = await client.query<{ id: string }>(
            `insert into activities (workspace_id, kind, status, started_by)
             values ($1, 'test.change-rollback', 'completed', $2) returning id`,
            [ws.workspaceId, ws.ownerId],
          );
          await client.query(
            `insert into links (workspace_id, link_type, source_object_id, target_object_id,
                                properties, valid_from, epistemic_status, activity_id, asserted_by)
             values ($1, 'shared_link', $2, $2, '{}'::jsonb, now(), 'asserted', $3, $4)`,
            [ws.workspaceId, a.rows[0]?.id, activity.rows[0]?.id, ws.ownerId],
          );
        });
        expect((await preview(ws, segmentId)).inUse).toEqual({
          objects: 0,
          links: 0,
          capped: false,
        });
      });
    });

    describe('rolling back an upgrade, in reverse order', () => {
      it('a later change blocks an earlier one (naming it); rolled back last first, the head steps back', async () => {
        const ws = await newWorkspace();
        const v1 = definitionOf(['ThingU']);
        const v2 = definitionOf(['ThingU', 'ThingU2']);
        const first = await apply(ws, segment('fam-u', v1));
        const second = await apply(ws, segment('fam-u', v2, '2'));

        const detail = await inspect(ws, first);
        expect(detail.items.map((item) => [item.state, item.replacedBy])).toEqual([
          ['replaced', { segmentId: second }],
        ]);
        const blocked = await preview(ws, first);
        expect(blocked.possible).toBe(false);
        expect(blocked.items[0]?.conflict).toEqual({
          ordinal: 1,
          kind: 'ontology_version',
          target: { family: 'fam-u', ontologyId: deriveOntologyPackId('fam-u') },
          blocker: 'replaced',
          blockedBy: { segmentId: second },
          conflicts: [],
        });
        const refused = rollBack(ws, first);
        await expect(refused).rejects.toBeInstanceOf(ChangeRollbackConflictError);
        await expect(refused).rejects.toMatchObject({
          code: 'change_rollback_conflict',
          details: { items: [expect.objectContaining({ blockedBy: { segmentId: second } })] },
        });
        expect(await familyVersions(ws, 'fam-u')).toEqual([
          { version: 1, status: 'published' },
          { version: 2, status: 'published' },
        ]);

        const dryRun = await preview(ws, second);
        expect(ontologyOf(dryRun.items[0])).toMatchObject({
          from: { version: 2 },
          to: { version: 1, definitionDigest: contentDigest(v1) },
          removes: { objectTypes: ['ThingU2'], linkTypes: [], actionTypes: [] },
        });
        await rollBack(ws, second);
        expect(await familyVersions(ws, 'fam-u')).toEqual([
          { version: 1, status: 'published' },
          { version: 2, status: 'deprecated' },
        ]);
        // The head is the first segment's version again, and its provenance says so.
        expect(await provenance(ws, 'fam-u')).toMatchObject({
          status: 'recorded',
          version: 1,
          segmentId: first,
          segmentStatus: 'applied',
        });
        expect((await inspect(ws, first)).items[0]?.state).toBe('in_effect');
        expect((await inspect(ws, second)).items[0]?.state).toBe('replaced');

        await rollBack(ws, first);
        expect(await provenance(ws, 'fam-u')).toEqual({ status: 'not_installed' });
      });

      it('a change made outside the ChangePlan core blocks it too, with nothing to name', async () => {
        const ws = await newWorkspace();
        const segmentId = await apply(ws, segment('fam-o', definitionOf(['ThingO'])));
        await inWorkspace(ws, (client) =>
          publishOntologyVersion(client, ws.workspaceId, {
            id: deriveOntologyPackId('fam-o'),
            definition: definitionOf(['ThingO', 'ThingO2']),
            principalId: ws.ownerId,
          }),
        );
        expect((await preview(ws, segmentId)).items[0]?.conflict).toMatchObject({
          blocker: 'replaced',
          blockedBy: null,
        });
        expect((await inspect(ws, segmentId)).items[0]).toMatchObject({
          state: 'replaced',
          replacedBy: null,
        });
        await expect(rollBack(ws, segmentId)).rejects.toBeInstanceOf(ChangeRollbackConflictError);
      });

      it('the version to return to is gone: refused, nothing written', async () => {
        const ws = await newWorkspace();
        await apply(ws, segment('fam-g', definitionOf(['ThingG'])));
        const second = await apply(ws, segment('fam-g', definitionOf(['ThingG', 'ThingG2']), '2'));
        await asOwner(ws, (client) =>
          client.query(
            "update ontology_versions set status = 'deprecated' where workspace_id = $1 and id = $2 and version = 1",
            [ws.workspaceId, deriveOntologyPackId('fam-g')],
          ),
        );
        expect((await preview(ws, second)).items[0]?.conflict?.blocker).toBe(
          'restored_version_missing',
        );
        await expect(rollBack(ws, second)).rejects.toBeInstanceOf(ChangeRollbackConflictError);
        expect(await familyVersions(ws, 'fam-g')).toEqual([
          { version: 1, status: 'deprecated' },
          { version: 2, status: 'published' },
        ]);
      });

      it('a type name the restored version declares, taken by another family since: refused (I-P1)', async () => {
        const ws = await newWorkspace();
        await apply(ws, segment('fam-n1', definitionOf(['ObjA'])));
        const moved = await apply(ws, segment('fam-n1', definitionOf(['ObjB']), '2'));
        await apply(ws, segment('fam-n2', definitionOf(['ObjA'], { link: 'obja2_of' })));
        const dryRun = await preview(ws, moved);
        expect(dryRun.items[0]?.conflict).toMatchObject({
          blocker: 'namespace_conflict',
          blockedBy: null,
          conflicts: [{ kind: 'object', name: 'ObjA' }],
        });
        await expect(rollBack(ws, moved)).rejects.toBeInstanceOf(ChangeRollbackConflictError);
        expect((await provenance(ws, 'fam-n1')).status).toBe('recorded');
      });
    });

    describe('I-A4 on the inverse: a rollback that takes an ActionType out is widening', () => {
      it('unconfirmed: 400 change_confirmation_required, nothing written; confirmed: rolled back, the confirmer recorded', async () => {
        const ws = await newWorkspace();
        const segmentId = await apply(
          ws,
          segment('fam-w', definitionOf(['ThingW'], { actions: [RESTART] })),
          [1],
        );
        const dryRun = await preview(ws, segmentId);
        expect(dryRun.items[0]).toMatchObject({
          classification: 'authority_widening',
          widening: [{ path: 'actionTypes[restart]', reason: 'removed' }],
          detail: { kind: 'ontology_version', planned: { removes: { actionTypes: ['restart'] } } },
        });

        const refused = rollBack(ws, segmentId);
        await expect(refused).rejects.toBeInstanceOf(ChangeConfirmationRequiredError);
        await expect(refused).rejects.toMatchObject({
          details: { items: [expect.objectContaining({ ordinal: 1 })] },
        });
        expect(await familyVersions(ws, 'fam-w')).toEqual([{ version: 1, status: 'published' }]);
        expect(await rollbackAudit(ws)).toEqual([]);

        await rollBack(ws, segmentId, [1]);
        expect(await familyVersions(ws, 'fam-w')).toEqual([{ version: 1, status: 'deprecated' }]);
        const [audit] = await rollbackAudit(ws);
        expect(audit?.payload).toMatchObject({
          classification: 'authority_widening',
          widening: [{ path: 'actionTypes[restart]', reason: 'removed' }],
          confirmedBy: ws.ownerId,
        });
      });
    });

    describe('concurrency and scope', () => {
      it('two rollbacks of one segment run one after the other: one rolls back, the other is refused', async () => {
        const ws = await newWorkspace();
        const segmentId = await apply(ws, segment('fam-c', definitionOf(['ThingC'])));
        const results = await Promise.allSettled([
          rollBack(ws, segmentId),
          rollBack(ws, segmentId),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          ChangeSegmentRolledBackError,
        );
        expect(await rollbackAudit(ws)).toHaveLength(1);
      });

      it("another workspace's segment is not found", async () => {
        const ws = await newWorkspace();
        const other = await newWorkspace();
        const segmentId = await apply(other, segment('fam-x', definitionOf(['ThingX'])));
        await expect(inspect(ws, segmentId)).rejects.toBeInstanceOf(ChangeSegmentNotFoundError);
        await expect(preview(ws, segmentId)).rejects.toBeInstanceOf(ChangeSegmentNotFoundError);
        await expect(rollBack(ws, segmentId)).rejects.toBeInstanceOf(ChangeSegmentNotFoundError);
        expect((await provenance(other, 'fam-x')).status).toBe('recorded');
      });
    });

    describe('list_change_segments', () => {
      it('newest first, keyset pages that neither skip nor repeat segments applied at one instant, a source filter', async () => {
        const ws = await newWorkspace();
        const early = await apply(ws, segment('fam-l0', definitionOf(['ThingL0'])));
        // One transaction: the three share one applied_at (now() is the transaction's time).
        const together = await inWorkspace(ws, async (client) => {
          const ids: string[] = [];
          for (const n of [1, 2, 3]) {
            ids.push(await applyIn(client, ws, segment(`fam-l${n}`, definitionOf([`ThingL${n}`]))));
          }
          return ids;
        });
        const list = (input: { sourceName?: string; limit?: number; cursor?: string }) =>
          inWorkspace(ws, (client) => listChangeSegments(client, ws.workspaceId, input));

        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await list({ limit: 2, ...(cursor ? { cursor } : {}) });
          expect(page.items.length).toBeLessThanOrEqual(2);
          seen.push(...page.items.map((s) => s.id));
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual([...[...together].sort().reverse(), early]);

        const firstPage = await list({});
        expect(firstPage.nextCursor).toBeUndefined();
        expect(firstPage.items[0]).toMatchObject({
          channel: 'human',
          status: 'applied',
          itemCount: 1,
          wideningItemCount: 0,
          appliedBy: { id: ws.ownerId, kind: 'human', displayName: 'owner' },
          rolledBackBy: null,
        });
        expect((await list({ sourceName: 'fam-l0' })).items.map((s) => s.id)).toEqual([early]);
        // A cursor this list did not produce is the first page.
        expect((await list({ cursor: 'not-a-cursor' })).items).toHaveLength(4);
      });
    });
  },
);
