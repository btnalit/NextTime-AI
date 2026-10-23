import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { ChangePlanChangedError, inspectChangeSegment } from '../change-plan/index.js';
import {
  loadPublishedWorkerDefinitionHead,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from '../worker/index.js';
import { type PackFixtureDirs, skillFile, workerFile, writePackFixture } from './fixture.js';
import {
  type PackRegistry,
  PackWorkerGatesError,
  type WorkerGateChoice,
  installPack,
  loadPackRegistry,
  loadPackState,
  previewPackInstall,
  readWorkerBindings,
  requirePack,
} from './index.js';

/**
 * application/packs — worker-binding.integration (S11 P1-E2): a pack's Worker names the systems it
 * acts on (`systems`), never a gate. Installing binds a Worker with no gates yet to the
 * workspace's connected gates of those systems — every one unless the person keeps fewer — as an
 * authority-widening item; the gates and model a Worker has are the workspace's, so an upgrade
 * keeps them and the pack's state ignores them (never `customized` for them). Installing again
 * binds a Worker installed before its system was connected.
 *
 * Gated on `DATABASE_URL`. Connector names are this file's own (the catalog is platform-wide).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
/** Platform-scope tables are written as the migrations' role (see operation-governance's test). */
const ADMIN_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

type Ws = { readonly workspaceId: string; readonly ownerId: string };

describe.runIf(DATABASE_URL !== undefined)(
  'application/packs — a pack Worker’s systems, gates and model (S11 P1-E2, integration, real Postgres)',
  () => {
    let pool: Pool;
    let fixture: PackFixtureDirs;
    let registry: PackRegistry;
    const suffix = randomUUID().slice(0, 8);
    const system = `p1e2-box-${suffix}`;

    async function newWorkspace(): Promise<Ws> {
      const workspaceId = randomUUID();
      const ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'p1e2-binding',
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
    const asAdmin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: ADMIN_PLACEHOLDER, principalId: ADMIN_PLACEHOLDER }, fn, {
        skipRoleSwitch: true,
      });

    /** A Gatekeeper named `name` the workspace enabled from an `enabled` catalog instance of
     *  `system` — a connected gate of it. */
    async function connectGate(ws: Ws, name: string): Promise<string> {
      const endpoint = `https://${name}-${randomUUID().slice(0, 8)}.example.invalid`;
      const gateId = `${name}-${randomUUID().slice(0, 6)}`;
      await asAdmin((client) =>
        client.query(
          `insert into gate_instances (gate_id, connector, display_name, transport_kind, endpoint, status)
           values ($1, $2, $1, 'http', $3, 'enabled')`,
          [gateId, system, endpoint],
        ),
      );
      const gatekeeperId = await inWorkspace(ws, async (client) => {
        const activity = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.p1e2', 'running', $2) returning id`,
          [ws.workspaceId, ws.ownerId],
        );
        const registered = await registerGatekeeper(client, ws.workspaceId, {
          name,
          transportKind: 'http',
          target: 'system',
          endpoint,
          activityId: activity.rows[0]?.id ?? '',
          registeredBy: { id: ws.ownerId, kind: 'human' },
        });
        return registered.gatekeeperId;
      });
      await asAdmin((client) =>
        client.query(
          `insert into workspace_gate_links (workspace_id, gate_id, gatekeeper_object_id, enabled_by)
           values ($1, $2, $3, $4)`,
          [ws.workspaceId, gateId, gatekeeperId, ws.ownerId],
        ),
      );
      return gatekeeperId;
    }

    const preview = (ws: Ws, name: string, choice?: WorkerGateChoice) =>
      inWorkspace(ws, (client) =>
        previewPackInstall(client, ws.workspaceId, registry, name, choice),
      );

    /** Previews, then installs exactly what was reviewed, every widening item confirmed. */
    async function installReviewed(ws: Ws, name: string, choice?: WorkerGateChoice) {
      const reviewed = await preview(ws, name, choice);
      const installed = await inWorkspace(ws, (client) =>
        installPack(client, ws.workspaceId, ws.ownerId, registry, {
          name,
          version: reviewed.target.version,
          reviewedDigest: reviewed.plan.digest,
          confirmedOrdinals: reviewed.plan.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
          ...(choice ? { workerGates: choice } : {}),
        }),
      );
      return { ...reviewed, segmentId: installed.segmentId };
    }

    /** The gates the install record shows for its (one) Worker item, by name — the record holds
     *  only the items that changed. */
    async function recordedGates(ws: Ws, segmentId: string | null) {
      if (segmentId === null) throw new Error('nothing was installed');
      const inspected = await inWorkspace(ws, (client) =>
        inspectChangeSegment(client, ws.workspaceId, segmentId),
      );
      const gates = inspected.items.find((item) => item.workerGates !== null)?.workerGates;
      const names = (side: readonly { readonly name: string }[] | null | undefined) =>
        side ? side.map((gate) => gate.name).sort() : side;
      return { before: names(gates?.before), after: names(gates?.after) };
    }

    const head = (ws: Ws, definitionId: string) =>
      inWorkspace(ws, (client) =>
        loadPublishedWorkerDefinitionHead(client, ws.workspaceId, definitionId),
      );
    const state = (ws: Ws, name: string) =>
      inWorkspace(ws, (client) =>
        loadPackState(client, ws.workspaceId, requirePack(registry, name)),
      );
    const bindings = (ws: Ws, name: string) =>
      inWorkspace(ws, (client) =>
        readWorkerBindings(client, ws.workspaceId, requirePack(registry, name)),
      );
    const runnerOf = (name: string) => {
      const worker = requirePack(registry, name)
        .versions.at(-1)
        ?.components.find((component) => component.kind === 'worker');
      if (worker?.kind !== 'worker') throw new Error(`fixture: ${name} has no Worker`);
      return worker;
    };

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      await asAdmin((client) =>
        client.query("insert into connectors (name, kind, mode) values ($1, 'http', $2)", [
          system,
          'platform_preset',
        ]),
      );
      const runner = (prompt: string) =>
        workerFile('box-runner', prompt, `skills:\n  - box-fix\nsystems:\n  - ${system}\n`);
      fixture = await writePackFixture({
        // v2 changes only the Worker's prompt.
        boxes: [
          {
            requires: [system],
            skills: [skillFile('box-fix', 'Fix a box.', 'Look first.')],
            workers: [runner('You look after the boxes.')],
          },
          {
            requires: [system],
            skills: [skillFile('box-fix', 'Fix a box.', 'Look first.')],
            workers: [runner('You look after the boxes, carefully.')],
          },
        ],
      });
      registry = await loadPackRegistry(fixture);
    }, 180_000);

    afterAll(async () => {
      await pool.end();
      await rm(fixture.root, { recursive: true, force: true });
    });

    it('a Worker’s systems: read from its file, never a gate, and part of the version', () => {
      const runner = runnerOf('boxes');
      expect(runner.systems).toEqual([system]);
      expect(runner.definition).not.toHaveProperty('systems');
      expect(runner.definition).not.toHaveProperty('gates');
    });

    it('binds a Worker to every connected gate of its systems by default, as a widening item', async () => {
      const ws = await newWorkspace();
      const north = await connectGate(ws, `north-${suffix}`);
      const south = await connectGate(ws, `south-${suffix}`);
      const runner = runnerOf('boxes');

      const reviewed = await installReviewed(ws, 'boxes');
      const planned = reviewed.workerGates.find((worker) => worker.name === 'box-runner');
      expect(planned).toMatchObject({
        source: 'install',
        systems: [system],
        model: null,
      });
      const both = [north, south].sort();
      expect(planned?.gates.map((gate) => gate.id).sort()).toEqual(both);
      expect(planned?.candidates.map((gate) => gate.id).sort()).toEqual(both);
      expect(planned?.candidates.every((gate) => gate.connector === system)).toBe(true);
      expect(new Set(planned?.gates.map((gate) => gate.name))).toEqual(
        new Set([`north-${suffix}`, `south-${suffix}`]),
      );
      const item = reviewed.plan.items[(planned?.ordinal ?? 0) - 1];
      expect(item?.classification).toBe('authority_widening');
      // The install record names the gates it bound (UX acceptance of #705): none before, a new
      // Worker.
      expect(await recordedGates(ws, reviewed.segmentId)).toEqual({
        before: null,
        after: [`north-${suffix}`, `south-${suffix}`],
      });

      const gates = (await head(ws, runner.definitionId))?.definition.gates as string[] | undefined;
      expect([...(gates ?? [])].sort()).toEqual(both);
      const after = await state(ws, 'boxes');
      expect(after.status).toBe('up_to_date');
      const binding = (await bindings(ws, 'boxes')).get(runner.definitionId);
      expect(binding?.bindable).toBe(false);
      expect(binding?.gates.map((gate) => gate.id).sort()).toEqual(both);
    });

    it('keeps only the gates the person kept; a foreign gate or Worker is refused', async () => {
      const ws = await newWorkspace();
      const north = await connectGate(ws, `north-${suffix}`);
      await connectGate(ws, `south-${suffix}`);
      const runner = runnerOf('boxes');

      const all = await preview(ws, 'boxes');
      const kept = new Map([['box-runner', [north]]]);
      const one = await preview(ws, 'boxes', kept);
      expect(one.plan.digest).not.toBe(all.plan.digest);
      expect(one.workerGates[0]?.gates.map((gate) => gate.id)).toEqual([north]);

      // Keeping none binds nothing: not a widening of what the Worker may act on.
      const none = await preview(ws, 'boxes', new Map([['box-runner', []]]));
      expect(none.workerGates[0]?.source).toBe('none');

      await expect(
        preview(ws, 'boxes', new Map([['box-runner', [randomUUID()]]])),
      ).rejects.toBeInstanceOf(PackWorkerGatesError);
      await expect(
        preview(ws, 'boxes', new Map([['someone-else', [north]]])),
      ).rejects.toBeInstanceOf(PackWorkerGatesError);

      // The digest covers the choice: installing all with the one-gate review is refused.
      await expect(
        inWorkspace(ws, (client) =>
          installPack(client, ws.workspaceId, ws.ownerId, registry, {
            name: 'boxes',
            version: one.target.version,
            reviewedDigest: one.plan.digest,
            confirmedOrdinals: one.plan.items
              .filter((item) => item.classification === 'authority_widening')
              .map((item) => item.ordinal),
          }),
        ),
      ).rejects.toBeInstanceOf(ChangePlanChangedError);

      await installReviewed(ws, 'boxes', kept);
      expect((await head(ws, runner.definitionId))?.definition.gates).toEqual([north]);
    });

    it('a gate connected after the review changes the plan: 409 change_plan_changed', async () => {
      const ws = await newWorkspace();
      await connectGate(ws, `north-${suffix}`);
      const reviewed = await preview(ws, 'boxes');
      await connectGate(ws, `south-${suffix}`);
      await expect(
        inWorkspace(ws, (client) =>
          installPack(client, ws.workspaceId, ws.ownerId, registry, {
            name: 'boxes',
            version: reviewed.target.version,
            reviewedDigest: reviewed.plan.digest,
            confirmedOrdinals: reviewed.plan.items
              .filter((item) => item.classification === 'authority_widening')
              .map((item) => item.ordinal),
          }),
        ),
      ).rejects.toBeInstanceOf(ChangePlanChangedError);
    });

    it('installed before its system was connected: bindable, and installing again binds it with the pack still up to date', async () => {
      const ws = await newWorkspace();
      const runner = runnerOf('boxes');

      const first = await installReviewed(ws, 'boxes');
      expect(first.workerGates[0]).toMatchObject({ source: 'none', gates: [], candidates: [] });
      expect((await head(ws, runner.definitionId))?.definition.gates).toBeUndefined();
      expect((await bindings(ws, 'boxes')).get(runner.definitionId)).toMatchObject({
        bindable: false,
        kept: false,
      });

      const north = await connectGate(ws, `north-${suffix}`);
      expect((await state(ws, 'boxes')).status).toBe('up_to_date');
      expect((await bindings(ws, 'boxes')).get(runner.definitionId)?.bindable).toBe(true);

      const again = await installReviewed(ws, 'boxes');
      expect(again.current.status).toBe('up_to_date');
      expect(again.plan.unchanged).toBe(false);
      expect(again.workerGates[0]).toMatchObject({ source: 'install' });
      expect((await head(ws, runner.definitionId))?.definition.gates).toEqual([north]);
      expect(await recordedGates(ws, again.segmentId)).toEqual({
        before: [],
        after: [`north-${suffix}`],
      });
      expect((await state(ws, 'boxes')).status).toBe('up_to_date');
      expect((await bindings(ws, 'boxes')).get(runner.definitionId)?.bindable).toBe(false);
      // Nothing left to do.
      expect((await preview(ws, 'boxes')).plan.unchanged).toBe(true);
    });

    it('keeping none is recorded as gates: [] — not widening, no longer bindable, and installing again changes nothing (review #493 on #705)', async () => {
      const ws = await newWorkspace();
      const runner = runnerOf('boxes');
      await installReviewed(ws, 'boxes');
      await connectGate(ws, `north-${suffix}`);
      expect((await bindings(ws, 'boxes')).get(runner.definitionId)?.bindable).toBe(true);

      const none = await installReviewed(ws, 'boxes', new Map([['box-runner', []]]));
      const planned = none.workerGates[0];
      expect(planned).toMatchObject({ source: 'none', gates: [] });
      // From no gates to none: nothing more for the Worker to act on, so nothing to confirm.
      const item = none.plan.items[(planned?.ordinal ?? 0) - 1];
      expect(item?.classification).not.toBe('authority_widening');
      expect(item?.widening).toEqual([]);

      expect((await head(ws, runner.definitionId))?.definition.gates).toEqual([]);
      const binding = (await bindings(ws, 'boxes')).get(runner.definitionId);
      expect(binding?.bindable).toBe(false);
      expect(binding?.gates).toEqual([]);
      expect(binding?.kept).toBe(true);
      expect((await state(ws, 'boxes')).status).toBe('up_to_date');
      const again = await preview(ws, 'boxes');
      expect(again.plan.unchanged).toBe(true);
      expect(again.workerGates[0]).toMatchObject({
        source: 'workspace',
        gates: [],
        candidates: [],
      });
    });

    it('the workspace’s own gates and model: never customized, kept as they are by an upgrade', async () => {
      const ws = await newWorkspace();
      const north = await connectGate(ws, `north-${suffix}`);
      const south = await connectGate(ws, `south-${suffix}`);
      const runner = runnerOf('boxes');
      const entry = requirePack(registry, 'boxes');
      const v1 = entry.versions[0];
      if (!v1) throw new Error('fixture: boxes has no v1');

      // v1 only, the way an older platform would have installed it: through the install of a
      // registry that ships v1 alone.
      const older = new Map([[entry.name, { ...entry, versions: [v1] }]]) as PackRegistry;
      const reviewedV1 = await inWorkspace(ws, (client) =>
        previewPackInstall(client, ws.workspaceId, older, 'boxes'),
      );
      await inWorkspace(ws, (client) =>
        installPack(client, ws.workspaceId, ws.ownerId, older, {
          name: 'boxes',
          version: 1,
          reviewedDigest: reviewedV1.plan.digest,
          confirmedOrdinals: reviewedV1.plan.items
            .filter((item) => item.classification === 'authority_widening')
            .map((item) => item.ordinal),
        }),
      );

      // The owner edits the Worker by hand: one gate only, and a model of their choosing.
      const before = await head(ws, runner.definitionId);
      if (!before) throw new Error('v1 installed no Worker');
      const model = 'fake/fake-echo';
      await inWorkspace(ws, async (client) => {
        const proposed = await proposeWorkerDefinition(client, ws.workspaceId, ws.ownerId, {
          definitionId: runner.definitionId,
          kind: 'worker',
          definition: { ...before.definition, gates: [south], model },
        });
        await publishWorkerDefinition(client, ws.workspaceId, ws.ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        });
      });
      // Still v1's Worker, not a customization of it: the pack is just outdated.
      const edited = await state(ws, 'boxes');
      expect(edited.status).toBe('outdated');
      expect(edited.installedVersion).toBe(1);

      const upgrade = await installReviewed(ws, 'boxes');
      const planned = upgrade.workerGates[0];
      expect(planned).toMatchObject({ source: 'workspace', model, candidates: [] });
      expect(planned?.gates.map((gate) => gate.id)).toEqual([south]);
      const item = upgrade.plan.items[(planned?.ordinal ?? 0) - 1];
      // Only the prompt changed (itself widening, as any prompt change is): keeping the
      // workspace's gates and model adds no widening of its own.
      expect(
        item?.detail.kind === 'worker_definition_version' && item.detail.changedFields,
      ).toEqual(['systemPrompt']);
      expect(item?.widening).toEqual([{ path: 'worker.systemPrompt', reason: 'changed' }]);

      const after = await head(ws, runner.definitionId);
      expect(after?.definition.gates).toEqual([south]);
      expect(after?.definition.model).toBe(model);
      expect(after?.definition.systemPrompt).toBe('You look after the boxes, carefully.');
      expect(north).not.toBe(south);
      const upgraded = await state(ws, 'boxes');
      expect(upgraded.status).toBe('up_to_date');
      expect(upgraded.installedVersion).toBe(2);
    });
  },
);
