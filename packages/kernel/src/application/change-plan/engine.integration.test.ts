import { randomUUID } from 'node:crypto';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  type ActionTypeDefinition,
  type OntologyDefinition,
  OntologyNamespaceConflictError,
  deriveOntologyPackId,
  publishOntologyVersion,
} from '../../substrate/ontology/index.js';
import { type PackFixtureDirs, writePackFixture } from '../packs/fixture.js';
import { installOrUpgradeModule, loadModuleRegistry } from '../platform/modules.js';
import { createWorkspaceWithOwner } from '../workspace/create.js';
import {
  type ApplyWorkspaceSegmentInput,
  ChangeConfirmationRequiredError,
  ChangePlanChangedError,
  type WorkspaceSegmentInput,
  applyWorkspaceSegment,
  contentDigest,
  loadOntologyProvenance,
  planWorkspaceSegment,
} from './index.js';

/**
 * application/change-plan — engine.integration (S11 P1-A): a workspace segment planned, reviewed
 * and applied in one transaction; what it records (segment, items with before / after, one audit
 * row per item); the reviewed digest re-checked (I-A8); authority-widening items confirmed one by
 * one (I-A4); a failed item rolls the whole segment back; and the module path
 * (`install_module` / `upgrade_module`, workspace creation's default modules) through it.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

const RESTART: ActionTypeDefinition = {
  name: 'restart',
  description: 'restart a thing',
  mode: 'execute',
  blastRadius: 'medium',
};

function definitionOf(
  objectType: string,
  actions?: readonly ActionTypeDefinition[],
): OntologyDefinition {
  return {
    objectTypes: [{ name: objectType, description: 'd' }],
    linkTypes: [{ name: 'relates_to', domain: objectType, range: '*', description: 'd' }],
    ...(actions ? { actionTypes: [...actions] } : {}),
  };
}

function objectTypeYaml(name: string, withAction = false): string {
  return `objectTypes:\n  - name: ${name}\n    description: d\nlinkTypes:\n  - name: relates_to\n    domain: ${name}\n    range: "*"\n    description: d\n${
    withAction
      ? 'actionTypes:\n  - name: restart\n    description: d\n    mode: execute\n    blastRadius: medium\n'
      : ''
  }`;
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/change-plan — workspace segments (S11 P1-A, integration, real Postgres)',
  () => {
    let pool: Pool;
    let fixture: PackFixtureDirs;

    async function newWorkspace(): Promise<{ workspaceId: string; ownerId: string }> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1-change-engine',
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

    const inWorkspace = <T>(
      ws: { workspaceId: string; ownerId: string },
      fn: (client: PoolClient) => Promise<T>,
    ) => withWorkspace(pool, { workspaceId: ws.workspaceId, principalId: ws.ownerId }, fn);

    function segment(family: string, definition: OntologyDefinition): WorkspaceSegmentInput {
      return {
        source: { kind: 'pack', name: family, version: '1', digest: contentDigest(definition) },
        items: [{ kind: 'ontology_version', family, definition }],
      };
    }

    function applyInput(
      ws: { ownerId: string },
      input: WorkspaceSegmentInput,
      reviewedDigest: string,
      confirmedOrdinals: readonly number[] = [],
    ): ApplyWorkspaceSegmentInput {
      return {
        ...input,
        reviewedDigest,
        proposedBy: ws.ownerId,
        appliedBy: ws.ownerId,
        channel: 'human',
        confirmedOrdinals,
      };
    }

    const plan = (ws: { workspaceId: string; ownerId: string }, input: WorkspaceSegmentInput) =>
      inWorkspace(ws, (client) => planWorkspaceSegment(client, ws.workspaceId, input));

    const apply = (
      ws: { workspaceId: string; ownerId: string },
      input: ApplyWorkspaceSegmentInput,
    ) => inWorkspace(ws, (client) => applyWorkspaceSegment(client, ws.workspaceId, input));

    const rows = (
      ws: { workspaceId: string; ownerId: string },
      text: string,
      params: readonly unknown[] = [],
    ) =>
      inWorkspace(
        ws,
        async (client) => (await client.query(text, [ws.workspaceId, ...params])).rows,
      );

    const familyVersions = (ws: { workspaceId: string; ownerId: string }, family: string) =>
      rows(
        ws,
        'select version, published_by from ontology_versions where workspace_id = $1 and id = $2 order by version',
        [deriveOntologyPackId(family)],
      );

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      // Two more modules, one plain, one declaring an ActionType, beside the real ontology/
      // library (workspace creation needs platform-meta.yaml and entry-agent.yaml).
      const module = (name: string, yaml: string) => [
        { notes: name, ontology: [{ family: name, domainPack: `${name}-v1.yaml`, yaml }] },
      ];
      fixture = await writePackFixture({
        'plain-mod': module('plain-mod', objectTypeYaml('PlainThing')),
        'act-mod': module('act-mod', objectTypeYaml('ActThing', true)),
      });
      await cp(ONTOLOGY_DIR, fixture.ontologyDir, { recursive: true });
    });

    afterAll(async () => {
      await pool.end();
      await rm(fixture.root, { recursive: true, force: true });
    });

    describe('plan → apply', () => {
      it('records the segment, its item with before / after, and one audit row per item', async () => {
        const ws = await newWorkspace();
        const input = segment('fam-a', definitionOf('ThingA'));
        const planned = await plan(ws, input);
        expect(planned.unchanged).toBe(false);
        expect(planned.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(planned.items).toEqual([
          expect.objectContaining({
            ordinal: 1,
            kind: 'ontology_version',
            target: { family: 'fam-a', ontologyId: deriveOntologyPackId('fam-a') },
            before: null,
            after: { definitionDigest: contentDigest(definitionOf('ThingA')) },
            classification: 'not_widening',
            widening: [],
          }),
        ]);
        // The dry run wrote nothing.
        expect(await familyVersions(ws, 'fam-a')).toEqual([]);

        const applied = await apply(ws, applyInput(ws, input, planned.digest));
        expect(applied.segmentId).not.toBeNull();
        expect(await familyVersions(ws, 'fam-a')).toEqual([
          { version: 1, published_by: ws.ownerId },
        ]);

        const [segmentRow] = await rows(
          ws,
          'select * from change_segments where workspace_id = $1 and id = $2',
          [applied.segmentId],
        );
        expect(segmentRow).toMatchObject({
          status: 'applied',
          channel: 'human',
          source_kind: 'pack',
          source_name: 'fam-a',
          source_version: '1',
          source_digest: input.source.digest,
          reviewed_digest: planned.digest,
          proposed_by: ws.ownerId,
          applied_by: ws.ownerId,
        });
        const items = await rows(
          ws,
          'select * from change_items where workspace_id = $1 and segment_id = $2',
          [applied.segmentId],
        );
        expect(items).toEqual([
          expect.objectContaining({
            ordinal: 1,
            kind: 'ontology_version',
            before: null,
            after: { definitionDigest: contentDigest(definitionOf('ThingA')), version: 1 },
            classification: 'not_widening',
            confirmed_by: null,
          }),
        ]);
        const audit = await rows(
          ws,
          "select actor_principal_id, resource_type, resource_id, payload from audit_records where workspace_id = $1 and action = 'change_item.apply'",
        );
        expect(audit).toEqual([
          expect.objectContaining({
            actor_principal_id: ws.ownerId,
            resource_type: 'change_item',
            resource_id: items[0]?.id,
            payload: expect.objectContaining({
              channel: 'human',
              capability: 'publish_ontology_version',
              segmentId: applied.segmentId,
              ordinal: 1,
              classification: 'not_widening',
              proposedBy: ws.ownerId,
              confirmedBy: null,
              before: null,
              after: { definitionDigest: contentDigest(definitionOf('ThingA')), version: 1 },
            }),
          }),
        ]);
      });

      it('an upgrade records the version it replaced; applying the same content again records nothing', async () => {
        const ws = await newWorkspace();
        const first = segment('fam-b', definitionOf('ThingB'));
        await apply(ws, applyInput(ws, first, (await plan(ws, first)).digest));

        const again = await plan(ws, first);
        expect(again.unchanged).toBe(true);
        const noop = await apply(ws, applyInput(ws, first, again.digest));
        expect(noop.segmentId).toBeNull();
        expect(await familyVersions(ws, 'fam-b')).toHaveLength(1);

        const second = segment('fam-b', definitionOf('ThingB2'));
        const planned = await plan(ws, second);
        expect(planned.items[0]?.before).toEqual({
          version: 1,
          definitionDigest: contentDigest(definitionOf('ThingB')),
        });
        const applied = await apply(ws, applyInput(ws, second, planned.digest));
        const [item] = await rows(
          ws,
          'select before, after from change_items where workspace_id = $1 and segment_id = $2',
          [applied.segmentId],
        );
        expect(item).toEqual({
          before: { version: 1, definitionDigest: contentDigest(definitionOf('ThingB')) },
          after: { definitionDigest: contentDigest(definitionOf('ThingB2')), version: 2 },
        });
        const segments = await rows(ws, 'select id from change_segments where workspace_id = $1');
        expect(segments).toHaveLength(2);
      });
    });

    describe('I-A8: what is applied is what was reviewed', () => {
      it('the family moved since review: 409 change_plan_changed, nothing applied', async () => {
        const ws = await newWorkspace();
        const input = segment('fam-c', definitionOf('ThingC'));
        const reviewed = await plan(ws, input);
        // Someone publishes the family in between.
        await inWorkspace(ws, (client) =>
          publishOntologyVersion(client, ws.workspaceId, {
            id: deriveOntologyPackId('fam-c'),
            definition: definitionOf('ThingC0'),
            principalId: ws.ownerId,
          }),
        );
        const refused = apply(ws, applyInput(ws, input, reviewed.digest));
        await expect(refused).rejects.toBeInstanceOf(ChangePlanChangedError);
        await expect(refused).rejects.toMatchObject({ code: 'change_plan_changed' });
        expect(await familyVersions(ws, 'fam-c')).toHaveLength(1);
        expect(await rows(ws, 'select id from change_segments where workspace_id = $1')).toEqual(
          [],
        );
      });

      it('the content changed since review: 409 change_plan_changed', async () => {
        const ws = await newWorkspace();
        const reviewed = await plan(ws, segment('fam-d', definitionOf('ThingD')));
        await expect(
          apply(ws, applyInput(ws, segment('fam-d', definitionOf('ThingD2')), reviewed.digest)),
        ).rejects.toBeInstanceOf(ChangePlanChangedError);
        expect(await familyVersions(ws, 'fam-d')).toEqual([]);
      });
    });

    describe('concurrent applies of one segment', () => {
      it('the second waits for the first, then finds the family moved: 409, nothing written twice', async () => {
        const ws = await newWorkspace();
        const input = segment('fam-race', definitionOf('Raced'));
        const reviewed = await plan(ws, input);

        let held = () => {};
        const firstHolds = new Promise<void>((resolve) => {
          held = resolve;
        });
        let release = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const first = inWorkspace(ws, async (client) => {
          const applied = await applyWorkspaceSegment(
            client,
            ws.workspaceId,
            applyInput(ws, input, reviewed.digest),
          );
          held();
          await released;
          return applied;
        });
        await firstHolds;

        let pid: number | undefined;
        const second = inWorkspace(ws, async (client) => {
          pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
            ?.pid;
          return applyWorkspaceSegment(
            client,
            ws.workspaceId,
            applyInput(ws, input, reviewed.digest),
          );
        }).then(
          () => ({ error: undefined as unknown }),
          (error: unknown) => ({ error }),
        );
        // The second transaction blocks on the family's locks while the first holds them.
        let waited = false;
        for (let tries = 0; tries < 400 && !waited; tries += 1) {
          if (pid !== undefined) {
            const activity = await pool.query<{ wait_event_type: string | null }>(
              'select wait_event_type from pg_stat_activity where pid = $1',
              [pid],
            );
            waited = activity.rows[0]?.wait_event_type === 'Lock';
          }
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(waited, 'the second apply waits for the first').toBe(true);
        release();
        expect((await first).segmentId).not.toBeNull();
        const { error } = await second;
        expect(error).toBeInstanceOf(ChangePlanChangedError);
        expect(await familyVersions(ws, 'fam-race')).toHaveLength(1);
        expect(
          await rows(ws, 'select id from change_segments where workspace_id = $1'),
        ).toHaveLength(1);
      });
    });

    describe('fail closed', () => {
      it('an item kind the core does not implement is refused before anything is read or written', async () => {
        const ws = await newWorkspace();
        const input = {
          source: { kind: 'pack', name: 'x', version: '1', digest: contentDigest('x') },
          items: [{ kind: 'operation', name: 'docker.restart' }],
        } as unknown as WorkspaceSegmentInput;
        await expect(plan(ws, input)).rejects.toThrow(/unknown change item kind "operation"/);
        await expect(apply(ws, applyInput(ws, input, contentDigest('x')))).rejects.toThrow(
          /unknown change item kind "operation"/,
        );
        expect(await rows(ws, 'select id from change_segments where workspace_id = $1')).toEqual(
          [],
        );
      });

      it('two items on one family in one segment are refused before anything is written (review of #663)', async () => {
        const ws = await newWorkspace();
        const input: WorkspaceSegmentInput = {
          source: { kind: 'pack', name: 'dup', version: '1', digest: contentDigest('dup') },
          items: [
            { kind: 'ontology_version', family: 'fam-dup', definition: definitionOf('First') },
            { kind: 'ontology_version', family: 'fam-dup', definition: definitionOf('Second') },
          ],
        };
        await expect(plan(ws, input)).rejects.toThrow(/items 1 and 2 change the same target/);
        await expect(apply(ws, applyInput(ws, input, contentDigest('dup')))).rejects.toThrow(
          /items 1 and 2 change the same target/,
        );
        expect(await familyVersions(ws, 'fam-dup')).toEqual([]);
        expect(await rows(ws, 'select id from change_segments where workspace_id = $1')).toEqual(
          [],
        );
      });
    });

    describe('provenance: which item installed the current version', () => {
      it('recorded for a version the core applied; provenance_unknown for one published outside it; not_installed otherwise', async () => {
        const ws = await newWorkspace();
        const provenance = (family: string) =>
          inWorkspace(ws, (client) => loadOntologyProvenance(client, ws.workspaceId, family));

        expect(await provenance('fam-p')).toEqual({ status: 'not_installed' });

        const input = segment('fam-p', definitionOf('ThingP'));
        const applied = await apply(ws, applyInput(ws, input, (await plan(ws, input)).digest));
        expect(await provenance('fam-p')).toMatchObject({
          status: 'recorded',
          version: 1,
          segmentId: applied.segmentId,
          segmentStatus: 'applied',
          itemId: applied.items[0]?.id,
          source: input.source,
          channel: 'human',
          appliedBy: { id: ws.ownerId, kind: 'human' },
        });

        // A version published outside the core (before P1, or publish_ontology_version) has no
        // item: the head is not what the recorded item wrote.
        await inWorkspace(ws, (client) =>
          publishOntologyVersion(client, ws.workspaceId, {
            id: deriveOntologyPackId('fam-p'),
            definition: definitionOf('ThingP2'),
            principalId: ws.ownerId,
          }),
        );
        expect(await provenance('fam-p')).toEqual({ status: 'provenance_unknown', version: 2 });
      });
    });

    describe('I-A4: authority-widening items are confirmed one by one', () => {
      it('unconfirmed: 400 change_confirmation_required with the item and why; confirmed: applied and recorded', async () => {
        const ws = await newWorkspace();
        const input = segment('fam-e', definitionOf('ThingE', [RESTART]));
        const planned = await plan(ws, input);
        expect(planned.items[0]).toMatchObject({
          classification: 'authority_widening',
          widening: [{ path: 'actionTypes[restart]', reason: 'added' }],
        });

        const refused = apply(ws, applyInput(ws, input, planned.digest));
        await expect(refused).rejects.toBeInstanceOf(ChangeConfirmationRequiredError);
        await expect(refused).rejects.toMatchObject({
          code: 'change_confirmation_required',
          details: {
            items: [
              {
                ordinal: 1,
                kind: 'ontology_version',
                widening: [{ path: 'actionTypes[restart]', reason: 'added' }],
              },
            ],
          },
        });
        // Confirming another ordinal confirms nothing.
        await expect(apply(ws, applyInput(ws, input, planned.digest, [2]))).rejects.toBeInstanceOf(
          ChangeConfirmationRequiredError,
        );
        expect(await familyVersions(ws, 'fam-e')).toEqual([]);

        const applied = await apply(ws, applyInput(ws, input, planned.digest, [1]));
        const [item] = await rows(
          ws,
          'select classification, widening, confirmed_by from change_items where workspace_id = $1 and segment_id = $2',
          [applied.segmentId],
        );
        expect(item).toEqual({
          classification: 'authority_widening',
          widening: [{ path: 'actionTypes[restart]', reason: 'added' }],
          confirmed_by: ws.ownerId,
        });
        const [audit] = await rows(
          ws,
          "select payload from audit_records where workspace_id = $1 and action = 'change_item.apply'",
        );
        expect(audit?.payload).toMatchObject({
          classification: 'authority_widening',
          confirmedBy: ws.ownerId,
        });
      });
    });

    describe('one transaction per segment', () => {
      it('a name another family owns is refused at review (I-P1)', async () => {
        const ws = await newWorkspace();
        const owner = segment('fam-f', definitionOf('Shared'));
        await apply(ws, applyInput(ws, owner, (await plan(ws, owner)).digest));
        await expect(plan(ws, segment('fam-g', definitionOf('Shared')))).rejects.toBeInstanceOf(
          OntologyNamespaceConflictError,
        );
      });

      it('an item failing at apply rolls back the items before it and the segment', async () => {
        const ws = await newWorkspace();
        // Two families of one segment claiming one ObjectType name: each passes review against
        // what is published, the second's publish is refused (I-P1) once the first's is in.
        const input: WorkspaceSegmentInput = {
          source: { kind: 'pack', name: 'two', version: '1', digest: contentDigest('two') },
          items: [
            { kind: 'ontology_version', family: 'fam-h', definition: definitionOf('Twice') },
            { kind: 'ontology_version', family: 'fam-i', definition: definitionOf('Twice') },
          ],
        };
        const planned = await plan(ws, input);
        await expect(apply(ws, applyInput(ws, input, planned.digest))).rejects.toBeInstanceOf(
          OntologyNamespaceConflictError,
        );
        expect(await familyVersions(ws, 'fam-h')).toEqual([]);
        expect(await rows(ws, 'select id from change_segments where workspace_id = $1')).toEqual(
          [],
        );
        expect(
          await rows(
            ws,
            "select id from audit_records where workspace_id = $1 and action = 'change_item.apply'",
          ),
        ).toEqual([]);
      });
    });

    describe('modules apply through the core', () => {
      const install = (
        ws: { workspaceId: string; ownerId: string },
        name: string,
        confirm?: boolean,
      ) =>
        inWorkspace(ws, async (client) =>
          installOrUpgradeModule(
            client,
            ws.workspaceId,
            ws.ownerId,
            await loadModuleRegistry(fixture),
            {
              name,
              channel: 'human',
              ...(confirm ? { confirm } : {}),
            },
          ),
        );

      it('install_module records a segment sourced from the module’s pack at its version', async () => {
        const ws = await newWorkspace();
        const state = await install(ws, 'plain-mod');
        expect(state.status).toBe('up_to_date');
        const [segmentRow] = await rows(
          ws,
          'select id, channel, source_kind, source_name, source_version from change_segments where workspace_id = $1',
        );
        expect(segmentRow).toMatchObject({
          channel: 'human',
          source_kind: 'pack',
          source_name: 'plain-mod',
          source_version: '1',
        });
        const [item] = await rows(
          ws,
          'select target, before, after from change_items where workspace_id = $1 and segment_id = $2',
          [segmentRow?.id],
        );
        expect(item).toMatchObject({
          target: { family: 'plain-mod', ontologyId: deriveOntologyPackId('plain-mod') },
          before: null,
          after: { version: 1 },
        });
      });

      it('a module that widens authority is refused whatever confirm says, nothing published', async () => {
        const ws = await newWorkspace();
        await expect(install(ws, 'act-mod')).rejects.toBeInstanceOf(
          ChangeConfirmationRequiredError,
        );
        await expect(install(ws, 'act-mod', true)).rejects.toBeInstanceOf(
          ChangeConfirmationRequiredError,
        );
        expect(await familyVersions(ws, 'act-mod')).toEqual([]);
        expect(await rows(ws, 'select id from change_segments where workspace_id = $1')).toEqual(
          [],
        );
      });

      it('resetting a customized install that declared an ActionType is widening too (removed)', async () => {
        const ws = await newWorkspace();
        await inWorkspace(ws, (client) =>
          publishOntologyVersion(client, ws.workspaceId, {
            id: deriveOntologyPackId('plain-mod'),
            definition: definitionOf('PlainThing', [RESTART]),
            principalId: ws.ownerId,
          }),
        );
        await expect(install(ws, 'plain-mod', true)).rejects.toMatchObject({
          code: 'change_confirmation_required',
          details: { items: [{ widening: [{ path: 'actionTypes[restart]', reason: 'removed' }] }] },
        });
        expect(await familyVersions(ws, 'plain-mod')).toHaveLength(1);
      });

      it('workspace creation skips a default module that widens authority and records the rest as platform-channel segments', async () => {
        const outcome = await createWorkspaceWithOwner(pool, {
          name: `p1-defaults-${randomUUID().slice(0, 8)}`,
          owner: { displayName: 'P1 Defaults Owner' },
          defaultModules: ['act-mod', 'plain-mod'],
          ontologyDir: fixture.ontologyDir,
          packsDir: fixture.packsDir,
        });
        expect(outcome.skippedDefaultModules).toEqual(['act-mod']);
        const ws = { workspaceId: outcome.workspaceId, ownerId: outcome.ownerPrincipalId };
        expect(await familyVersions(ws, 'act-mod')).toEqual([]);
        expect(await familyVersions(ws, 'plain-mod')).toHaveLength(1);
        const audit = await rows(
          ws,
          "select actor_principal_id, payload from audit_records where workspace_id = $1 and action = 'change_item.apply'",
        );
        expect(audit).toEqual([
          expect.objectContaining({
            actor_principal_id: outcome.ownerPrincipalId,
            payload: expect.objectContaining({
              channel: 'platform',
              source: expect.objectContaining({ name: 'plain-mod' }),
            }),
          }),
        ]);
        // The segment says the platform applied it on the workspace's behalf: the owner named as
        // its applier did nothing themselves (I-A7).
        expect(
          await rows(ws, 'select channel, applied_by from change_segments where workspace_id = $1'),
        ).toEqual([{ channel: 'platform', applied_by: outcome.ownerPrincipalId }]);
        expect(
          await inWorkspace(ws, (client) =>
            loadOntologyProvenance(client, ws.workspaceId, 'plain-mod'),
          ),
        ).toMatchObject({ status: 'recorded', channel: 'platform' });
      });
    });
  },
);
