import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  OperationIdentityConflictError,
  OperationNotFoundError,
  getPublishedOperation,
  importManifest,
  proposeOperation,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import {
  ChangeConfirmationRequiredError,
  ChangeRollbackConflictError,
  type OperationGovernanceValues,
  type WorkspaceSegmentInput,
  applyWorkspaceSegment,
  contentDigest,
  inspectChangeSegment,
  planWorkspaceSegment,
  previewSegmentRollback,
  rollBackWorkspaceSegment,
} from './index.js';

/**
 * application/change-plan — operation-item.integration (S11 P1-E): the `operation_version` item. A
 * revision of a published Operation's governance fields only — planned against the live version,
 * classified field by field (the looser way needs a person's confirmation, the stricter way does
 * not), published as the next version under the person applying, and rolled back by publishing a
 * further version with the content before (a retired version is never published again). What the
 * gate runs is never revised (refused at plan), a revision someone has under review is never
 * published over (refused at plan, and a rollback stops on it), and a version published since
 * stops a rollback, naming the segment that published it.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

type Ws = { readonly workspaceId: string; readonly ownerId: string };

/** Strict: execute, high impact, not auto-approvable, awaiting the decision. */
const STRICT: Operation = {
  name: 'container.restart',
  description: 'Restart one container.',
  binding: { kind: 'http', method: 'POST', path: '/containers/{id}/restart' },
  params_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  mode: 'execute',
  blast_radius: 'high',
  reversibility: true,
  auto_approvable: false,
  await_decision: true,
  reads: ['Container'],
  writes: ['Container'],
};

describe.runIf(DATABASE_URL !== undefined)(
  'application/change-plan — Operation items (S11 P1-E, integration, real Postgres)',
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
            'p1-operation-items',
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

    /** A Gatekeeper with `operation` imported and published as v1. */
    async function seedOperation(ws: Ws, operation: Operation = STRICT): Promise<string> {
      return inWorkspace(ws, async (client) => {
        const activity = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.operation-item', 'running', $2) returning id`,
          [ws.workspaceId, ws.ownerId],
        );
        const activityId = activity.rows[0]?.id;
        if (!activityId) throw new Error('no activity');
        const { gatekeeperId } = await registerGatekeeper(client, ws.workspaceId, {
          name: `docker-gate-${randomUUID().slice(0, 8)}`,
          transportKind: 'http',
          target: 'docker',
          endpoint: `https://gate-${randomUUID()}.example.invalid`,
          activityId,
          registeredBy: { id: ws.ownerId, kind: 'human' },
        });
        await importManifest(client, ws.workspaceId, {
          gatekeeperId,
          operations: [operation],
          proposedBy: { id: ws.ownerId, kind: 'human' },
          activityId,
        });
        await publishOperation(client, ws.workspaceId, { gatekeeperId, name: operation.name });
        return gatekeeperId;
      });
    }

    const segment = (
      gatekeeperId: string,
      set: OperationGovernanceValues,
      name = STRICT.name,
    ): WorkspaceSegmentInput => ({
      source: { kind: 'pack', name: 'ops', version: '1', digest: contentDigest(set) },
      items: [{ kind: 'operation_version', gatekeeperId, name, set }],
    });

    const plan = (ws: Ws, input: WorkspaceSegmentInput) =>
      inWorkspace(ws, (client) => planWorkspaceSegment(client, ws.workspaceId, input));

    const apply = (ws: Ws, input: WorkspaceSegmentInput, confirmedOrdinals: number[] = [1]) =>
      inWorkspace(ws, async (client) => {
        const planned = await planWorkspaceSegment(client, ws.workspaceId, input);
        const applied = await applyWorkspaceSegment(client, ws.workspaceId, {
          ...input,
          reviewedDigest: planned.digest,
          proposedBy: ws.ownerId,
          appliedBy: ws.ownerId,
          channel: 'human',
          confirmedOrdinals,
        });
        if (!applied.segmentId) throw new Error('apply: nothing applied');
        return applied.segmentId;
      });

    const preview = (ws: Ws, segmentId: string) =>
      inWorkspace(ws, (client) => previewSegmentRollback(client, ws.workspaceId, segmentId));

    const rollBack = (ws: Ws, segmentId: string, confirmedOrdinals: readonly number[] = []) =>
      inWorkspace(ws, (client) =>
        rollBackWorkspaceSegment(client, ws.workspaceId, {
          segmentId,
          rolledBackBy: ws.ownerId,
          confirmedOrdinals,
        }),
      );

    /** Every version of the Operation, oldest first: version, status and the governance fields. */
    const versions = (ws: Ws, gatekeeperId: string, name = STRICT.name) =>
      inWorkspace(ws, async (client) => {
        const result = await client.query<{ properties: Record<string, unknown> }>(
          `select properties from objects
            where workspace_id = $1 and object_type = 'Operation'
              and identity_key ->> 'gatekeeperId' = $2 and identity_key ->> 'name' = $3
            order by (properties ->> 'version')::int`,
          [ws.workspaceId, gatekeeperId, name],
        );
        return result.rows.map(({ properties }) => ({
          version: properties.version,
          status: properties.status,
          autoApprovable: properties.auto_approvable,
          blastRadius: properties.blast_radius,
        }));
      });

    const auditCount = (ws: Ws, action: string) =>
      inWorkspace(ws, async (client) => {
        const result = await client.query<{ n: number }>(
          'select count(*)::int as n from audit_records where workspace_id = $1 and action = $2',
          [ws.workspaceId, action],
        );
        return result.rows[0]?.n;
      });

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('tightening needs no confirmation, publishes the next version and rolls back to a further one with the content before', async () => {
      const ws = await newWorkspace();
      const gatekeeperId = await seedOperation(ws, {
        ...STRICT,
        blast_radius: 'medium',
        auto_approvable: true,
      });
      const tighten = segment(gatekeeperId, { blast_radius: 'high', auto_approvable: false });

      const planned = await plan(ws, tighten);
      expect(planned.items[0]).toMatchObject({
        kind: 'operation_version',
        target: { gatekeeperId, name: STRICT.name },
        before: { version: 1 },
        classification: 'not_widening',
        widening: [],
        unchanged: false,
        detail: {
          kind: 'operation_version',
          fields: [
            { field: 'blast_radius', before: 'medium', after: 'high' },
            { field: 'auto_approvable', before: true, after: false },
          ],
        },
      });
      const segmentId = await apply(ws, tighten, []);
      expect(await versions(ws, gatekeeperId)).toEqual([
        { version: 1, status: 'deprecated', autoApprovable: true, blastRadius: 'medium' },
        { version: 2, status: 'published', autoApprovable: false, blastRadius: 'high' },
      ]);
      expect(await auditCount(ws, 'change_item.apply')).toBe(1);
      // Applied again, nothing changes.
      expect((await plan(ws, tighten)).unchanged).toBe(true);

      const inspected = await inWorkspace(ws, (client) =>
        inspectChangeSegment(client, ws.workspaceId, segmentId),
      );
      expect(inspected.items[0]).toMatchObject({
        state: 'in_effect',
        record: { kind: 'operation_version', before: { version: 1 }, after: { version: 2 } },
        operationFields: [
          { field: 'blast_radius', before: 'medium', after: 'high' },
          { field: 'auto_approvable', before: true, after: false },
        ],
      });

      // The way back loosens both: the person confirms it.
      const dryRun = await preview(ws, segmentId);
      expect(dryRun).toMatchObject({ possible: true });
      expect(dryRun.items[0]).toMatchObject({
        classification: 'authority_widening',
        widening: [
          { path: 'operation.auto_approvable', reason: 'loosened' },
          { path: 'operation.blast_radius', reason: 'loosened' },
        ],
        conflict: null,
      });
      await expect(rollBack(ws, segmentId, [])).rejects.toBeInstanceOf(
        ChangeConfirmationRequiredError,
      );
      await rollBack(ws, segmentId, [1]);
      expect(await versions(ws, gatekeeperId)).toEqual([
        { version: 1, status: 'deprecated', autoApprovable: true, blastRadius: 'medium' },
        { version: 2, status: 'deprecated', autoApprovable: false, blastRadius: 'high' },
        { version: 3, status: 'published', autoApprovable: true, blastRadius: 'medium' },
      ]);
      expect(await auditCount(ws, 'change_item.roll_back')).toBe(1);
      // No draft left behind by either publish.
      expect((await versions(ws, gatekeeperId)).filter((row) => row.status === 'draft')).toEqual(
        [],
      );
    });

    it('loosening is confirmed one item at a time; the description is checked like any other', async () => {
      const ws = await newWorkspace();
      const gatekeeperId = await seedOperation(ws);
      const loosen = segment(gatekeeperId, {
        auto_approvable: true,
        await_decision: false,
        writes: ['Container', 'Host'],
      });
      expect((await plan(ws, loosen)).items[0]?.widening).toEqual([
        { path: 'operation.auto_approvable', reason: 'loosened' },
        { path: 'operation.await_decision', reason: 'loosened' },
        { path: 'operation.writes', reason: 'loosened' },
      ]);
      await expect(apply(ws, loosen, [])).rejects.toBeInstanceOf(ChangeConfirmationRequiredError);
      expect((await versions(ws, gatekeeperId)).map((row) => row.version)).toEqual([1]);

      // A changed description is prompt text: confirmed too.
      expect(
        (await plan(ws, segment(gatekeeperId, { description: 'Restart a container safely.' })))
          .items[0]?.widening,
      ).toEqual([{ path: 'operation.description', reason: 'changed' }]);
      await expect(plan(ws, segment(gatekeeperId, { description: '   ' }))).rejects.toThrow(
        /description is 1 to/,
      );
      await expect(
        plan(
          ws,
          segment(gatekeeperId, {
            description: `Restart it with ghp_${'abcdefghij'.repeat(4)}.`,
          }),
        ),
      ).rejects.toThrow(/suspected credential/);
    });

    it('never revises what the gate runs, or an Operation that is not published', async () => {
      const ws = await newWorkspace();
      const gatekeeperId = await seedOperation(ws);
      await expect(
        plan(ws, segment(gatekeeperId, { mode: 'observe' } as OperationGovernanceValues)),
      ).rejects.toThrow(/sets only/);
      await expect(
        plan(ws, segment(gatekeeperId, { auto_approvable: true }, 'container.missing')),
      ).rejects.toBeInstanceOf(OperationNotFoundError);

      // For an ssh binding the gate holds calls to blast_radius too.
      const ssh = await seedOperation(ws, {
        ...STRICT,
        name: 'host.reboot',
        binding: { kind: 'ssh', command_template: 'systemctl reboot' },
        params_schema: { type: 'object', additionalProperties: false },
      });
      await expect(
        plan(ws, segment(ssh, { blast_radius: 'medium' }, 'host.reboot')),
      ).rejects.toThrow(/keeps what the gate runs/);
      expect(
        (await plan(ws, segment(ssh, { auto_approvable: true }, 'host.reboot'))).items[0]?.widening,
      ).toEqual([{ path: 'operation.auto_approvable', reason: 'loosened' }]);
    });

    it('a revision under review refuses the item, and stops its rollback', async () => {
      const ws = await newWorkspace();
      const gatekeeperId = await seedOperation(ws);
      const tighten = segment(gatekeeperId, { writes: [] });
      const segmentId = await apply(ws, tighten, []);

      // Someone proposes a revision: a draft one version above the live one.
      await inWorkspace(ws, async (client) => {
        const activity = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.operation-item', 'running', $2) returning id`,
          [ws.workspaceId, ws.ownerId],
        );
        await proposeOperation(client, ws.workspaceId, {
          gatekeeperId,
          operation: { ...STRICT, writes: [], description: 'Restart one container now.' },
          proposedBy: { id: ws.ownerId, kind: 'human' },
          activityId: activity.rows[0]?.id ?? '',
        });
      });
      await expect(
        plan(ws, segment(gatekeeperId, { auto_approvable: true })),
      ).rejects.toBeInstanceOf(OperationIdentityConflictError);

      const dryRun = await preview(ws, segmentId);
      expect(dryRun).toMatchObject({ possible: false });
      expect(dryRun.items[0]?.conflict).toMatchObject({
        blocker: 'revision_pending',
        blockedBy: null,
      });
      await expect(rollBack(ws, segmentId, [1])).rejects.toBeInstanceOf(
        ChangeRollbackConflictError,
      );
      expect((await versions(ws, gatekeeperId)).map((row) => row.status)).toEqual([
        'deprecated',
        'published',
        'draft',
      ]);
    });

    it('a version published since stops the rollback and names the segment to roll back first', async () => {
      const ws = await newWorkspace();
      const gatekeeperId = await seedOperation(ws);
      const first = await apply(ws, segment(gatekeeperId, { writes: [] }), []);
      const second = await apply(ws, segment(gatekeeperId, { reads: [] }), []);

      const blocked = await preview(ws, first);
      expect(blocked).toMatchObject({ possible: false });
      expect(blocked.items[0]?.conflict).toMatchObject({
        blocker: 'replaced',
        blockedBy: { segmentId: second },
      });
      const inspected = await inWorkspace(ws, (client) =>
        inspectChangeSegment(client, ws.workspaceId, first),
      );
      expect(inspected.items[0]).toMatchObject({
        state: 'replaced',
        replacedBy: { segmentId: second },
      });

      // Latest first: its rollback publishes the first item's content again (v4), so the first
      // item is in effect again and goes back in turn, from v4.
      await rollBack(ws, second, [1]);
      const inspectedAgain = await inWorkspace(ws, (client) =>
        inspectChangeSegment(client, ws.workspaceId, first),
      );
      expect(inspectedAgain.items[0]).toMatchObject({ state: 'in_effect', replacedBy: null });
      expect((await preview(ws, first)).items[0]).toMatchObject({
        conflict: null,
        detail: { planned: { from: { version: 4 }, to: { version: 1 } } },
      });
      await rollBack(ws, first, [1]);
      const rows = await versions(ws, gatekeeperId);
      expect(rows.map((row) => [row.version, row.status])).toEqual([
        [1, 'deprecated'],
        [2, 'deprecated'],
        [3, 'deprecated'],
        [4, 'deprecated'],
        [5, 'published'],
      ]);
      const live = await inWorkspace(ws, (client) =>
        getPublishedOperation(client, ws.workspaceId, gatekeeperId, STRICT.name),
      );
      expect(contentDigest(live?.operation)).toBe(contentDigest(STRICT));
    });
  },
);
