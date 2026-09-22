import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PiDriftWire,
  PlatformSettingsWire,
  PlatformStatusWire,
  RollEntryContainersResultWire,
  RuntimeImageWire,
  RuntimeInventoryWire,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  ResidentInventoryEntry,
  RuntimeImageInfo,
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { dispatchCapability } from './dispatch.js';
import { PlatformAdminError } from './platform-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/platform-runtime.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) coverage of the S7-E runtime-layer capabilities
 * (application/platform/runtime.ts — `runtime_inventory` / `list_runtime_images` /
 * `set_active_runtime_image` / `rollback_runtime_image` / `roll_entry_containers` / `pi_drift` /
 * `platform_status`), docs/development-tasks.md §5d S7-E 决定 E1–E4.
 *
 * A fake, in-memory `TaskSupervisorClientPort` stands in for worker-supervisor (no real Docker) —
 * the same "unit with fakes (supervisor client)" convention `task/invoke.integration.test.ts`
 * already uses. `platform_status`'s two live `fetch('.../healthz')` probes (llm-proxy,
 * worker-supervisor) are asserted structurally only (a valid `ServiceHealthWire.status`, not a
 * specific value) — this file's own database has no such services reachable, in CI or locally, and
 * `application/platform/runtime.ts`'s own module doc comment documents that this is a live probe,
 * not something this test double can control.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const IMAGE_V1: RuntimeImageInfo = {
  id: 'sha256:v1000000000000000000000000000000000000000000000000000000000000',
  tags: ['nexttime-ai-worker-runtime:v1'],
  created: '2026-09-01T00:00:00.000Z',
  labels: { 'ai.nexttime.pi-version': '0.84.4', 'ai.nexttime.platform-extension-version': '1.0.0' },
};
const IMAGE_V2: RuntimeImageInfo = {
  id: 'sha256:v2000000000000000000000000000000000000000000000000000000000000',
  tags: ['nexttime-ai-worker-runtime:v2'],
  created: '2026-09-20T00:00:00.000Z',
  labels: { 'ai.nexttime.pi-version': '0.85.0', 'ai.nexttime.platform-extension-version': '1.1.0' },
};

/** In-memory `TaskSupervisorClientPort` — `images`/`residents` are set directly by each test;
 *  `stoppedPrincipalIds` records every `stopResident` call for `roll_entry_containers` assertions. */
class FakeRuntimeSupervisorClient implements TaskSupervisorClientPort {
  images: RuntimeImageInfo[] = [];
  residents: ResidentInventoryEntry[] = [];
  readonly stoppedPrincipalIds: string[] = [];

  async spawn(): Promise<TaskSpawnOutcome> {
    throw new Error('FakeRuntimeSupervisorClient.spawn is not exercised by this test file');
  }
  async terminate(): Promise<boolean> {
    throw new Error('FakeRuntimeSupervisorClient.terminate is not exercised by this test file');
  }
  async status(): Promise<TaskSupervisorStatus | undefined> {
    throw new Error('FakeRuntimeSupervisorClient.status is not exercised by this test file');
  }
  async stopResident(principalId: string): Promise<boolean> {
    this.stoppedPrincipalIds.push(principalId);
    return true;
  }
  async listImages(): Promise<RuntimeImageInfo[]> {
    return this.images;
  }
  async listResidents(): Promise<ResidentInventoryEntry[]> {
    return this.residents;
  }
}

function residentEntry(overrides: Partial<ResidentInventoryEntry>): ResidentInventoryEntry {
  return {
    principalId: randomUUID(),
    workspaceId: randomUUID(),
    containerId: `container-${randomUUID()}`,
    running: true,
    status: 'running',
    image: IMAGE_V1.tags[0],
    imageId: IMAGE_V1.id,
    startedAt: new Date().toISOString(),
    lastTouchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'S7-E platform runtime capabilities (integration, real Postgres)',
  () => {
    let pool: Pool;
    let admin: UserRow;
    let supervisor: FakeRuntimeSupervisorClient;
    let workspaceId: string;

    function platformCaller(user: UserRow): ResolvedCaller {
      return {
        channel: 'platform',
        user: {
          id: user.id,
          login: user.login,
          displayName: user.displayName,
          platformRole: 'admin',
          mustChangePassword: false,
          consoleSessionId: randomUUID(),
        },
      };
    }

    function callAsAdmin<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
      return dispatchCapability({ pool }, platformCaller(admin), name, params) as Promise<T>;
    }

    async function expectPlatformError(call: () => Promise<unknown>, code: string): Promise<void> {
      const thrown = await call().then(
        () => {
          throw new Error(`expected PlatformAdminError("${code}"), but the call resolved`);
        },
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(PlatformAdminError);
      expect((thrown as PlatformAdminError).code).toBe(code);
    }

    async function insertBareWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** `activities.started_by` FKs to `principals (workspace_id, id)` — `startRunningTurn` below
     *  needs a real principal row, not just any UUID (a fake resident's `principalId` from
     *  `residentEntry()` is otherwise unconstrained, since worker-supervisor is faked here and the
     *  kernel never validates a resident's principal against `principals` for
     *  `runtime_inventory`/`roll_entry_containers` — only `startRunningTurn`'s own INSERT does). */
    async function insertHumanPrincipal(
      workspaceIdArg: string,
      displayName: string,
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: workspaceIdArg, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'member', $3)`,
            [workspaceIdArg, id, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** Starts a real `kind='agent_turn'` Activity (`status='running'`, `started_by = principalId`)
     *  — the exact DB-backed signal `roll_entry_containers`'s `hasInFlightTurn` reads. `principalId`
     *  must already be a real row (`insertHumanPrincipal`) — `activities.started_by` FKs to
     *  `principals`. No `chatId` needed (nullable FK). */
    async function startRunningTurn(principalId: string): Promise<string> {
      return withWorkspace(
        pool,
        { workspaceId, principalId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'agent_turn',
            principalId,
          });
          return activity.id;
        },
        { skipRoleSwitch: true },
      );
    }

    beforeAll(async () => {
      if (DATABASE_URL === undefined) return;
      pool = createPool({ connectionString: DATABASE_URL });
      await runMigrations(pool, MIGRATIONS_DIR);

      admin = await createPlatformAdmin(pool, {
        login: `runtime-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Runtime Admin',
        password: 'correct horse battery staple',
      });
      workspaceId = await insertBareWorkspace('platform-runtime-test-workspace');
    }, 120_000);

    afterAll(async () => {
      if (pool) await pool.end();
    });

    beforeEach(async () => {
      supervisor = new FakeRuntimeSupervisorClient();
      const { privateKey } = await generateEphemeralHandleKeyPair();
      configureTaskRuntime({ pool, privateKey, supervisorClient: supervisor });
    });

    afterEach(() => {
      resetTaskRuntimeForTests();
    });

    describe('list_runtime_images', () => {
      it('returns every image the supervisor client reports, projected to the wire shape', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        const result = await callAsAdmin<{ items: RuntimeImageWire[] }>('list_runtime_images');
        expect(result.items.map((i) => i.id).sort()).toEqual([IMAGE_V1.id, IMAGE_V2.id].sort());
        const v1 = result.items.find((i) => i.id === IMAGE_V1.id);
        expect(v1).toMatchObject({
          tags: IMAGE_V1.tags,
          piVersion: '0.84.4',
          platformExtensionVersion: '1.0.0',
        });
      });
    });

    describe('set_active_runtime_image / rollback_runtime_image', () => {
      it('sets the active image when it is in the inventory, and reflects it in get_platform_settings', async () => {
        supervisor.images = [IMAGE_V1];
        const result = await callAsAdmin<PlatformSettingsWire>('set_active_runtime_image', {
          image: 'nexttime-ai-worker-runtime:v1',
        });
        expect(result.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v1');

        const settings = await callAsAdmin<PlatformSettingsWire>('get_platform_settings');
        expect(settings.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v1');
      });

      it('rejects an image not in list_runtime_images (image_not_in_inventory)', async () => {
        supervisor.images = [IMAGE_V1];
        await expectPlatformError(
          () => callAsAdmin('set_active_runtime_image', { image: 'not-a-real-image:latest' }),
          'image_not_in_inventory',
        );
      });

      it('rolls back to the value one settings version ago', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v1' });
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v2' });

        const rolledBack = await callAsAdmin<PlatformSettingsWire>('rollback_runtime_image');
        expect(rolledBack.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v1');

        const settings = await callAsAdmin<PlatformSettingsWire>('get_platform_settings');
        expect(settings.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v1');
      });
    });

    describe('runtime_inventory', () => {
      it('derives needsRebuild from a mismatch between the container’s own image id and the active image’s', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v2' });

        const upToDate = residentEntry({ imageId: IMAGE_V2.id });
        const stale = residentEntry({ imageId: IMAGE_V1.id });
        supervisor.residents = [upToDate, stale];

        const result = await callAsAdmin<RuntimeInventoryWire>('runtime_inventory');
        expect(result.activeImage).toBe('nexttime-ai-worker-runtime:v2');
        expect(result.activeImageSource).toBe('setting');
        expect(result.activeImageInfo?.id).toBe(IMAGE_V2.id);

        const upToDateResult = result.residentContainers.find(
          (c) => c.principalId === upToDate.principalId,
        );
        const staleResult = result.residentContainers.find(
          (c) => c.principalId === stale.principalId,
        );
        expect(upToDateResult?.needsRebuild).toBe(false);
        expect(staleResult?.needsRebuild).toBe(true);
      });

      it('never guesses needsRebuild when the active image cannot be resolved', async () => {
        supervisor.images = []; // active image (env default) not found in inventory
        supervisor.residents = [residentEntry({ imageId: 'sha256:unrelated' })];

        const result = await callAsAdmin<RuntimeInventoryWire>('runtime_inventory');
        expect(result.activeImageInfo).toBeNull();
        expect(result.residentContainers.every((c) => c.needsRebuild === false)).toBe(true);
      });
    });

    describe('roll_entry_containers (E2 — acceleration only)', () => {
      it('stops a container that needs rebuild and has no in-flight Turn, and skips one that does', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v2' });

        const idleStale = residentEntry({ workspaceId, imageId: IMAGE_V1.id });
        const busyPrincipalId = await insertHumanPrincipal(workspaceId, 'Busy Principal');
        const busyStale = residentEntry({
          workspaceId,
          principalId: busyPrincipalId,
          imageId: IMAGE_V1.id,
        });
        supervisor.residents = [idleStale, busyStale];

        await startRunningTurn(busyStale.principalId);

        const result = await callAsAdmin<RollEntryContainersResultWire>('roll_entry_containers');
        const idleOutcome = result.outcomes.find((o) => o.principalId === idleStale.principalId);
        const busyOutcome = result.outcomes.find((o) => o.principalId === busyStale.principalId);
        expect(idleOutcome?.action).toBe('stopped');
        expect(busyOutcome?.action).toBe('skipped_in_flight');
        expect(supervisor.stoppedPrincipalIds).toEqual([idleStale.principalId]);
        expect(result.stoppedCount).toBe(1);
      });

      it('skips a container that is already up to date', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v2' });
        const upToDate = residentEntry({ workspaceId, imageId: IMAGE_V2.id });
        supervisor.residents = [upToDate];

        const result = await callAsAdmin<RollEntryContainersResultWire>('roll_entry_containers');
        expect(result.outcomes).toEqual([
          { principalId: upToDate.principalId, workspaceId, action: 'skipped_up_to_date' },
        ]);
        expect(supervisor.stoppedPrincipalIds).toEqual([]);
      });

      it('reports skipped_not_found for a requested principalId the supervisor does not know', async () => {
        supervisor.images = [IMAGE_V1];
        supervisor.residents = [];
        const unknownId = randomUUID();

        const result = await callAsAdmin<RollEntryContainersResultWire>('roll_entry_containers', {
          principalIds: [unknownId],
        });
        expect(result.outcomes).toEqual([
          { principalId: unknownId, workspaceId: '', action: 'skipped_not_found' },
        ]);
      });
    });

    describe('pi_drift', () => {
      it('reports status "unknown" when no CI-produced drift file exists in this environment', async () => {
        supervisor.images = [IMAGE_V1];
        const result = await callAsAdmin<PiDriftWire>('pi_drift');
        expect(result.status).toBe('unknown');
        expect(result.pinnedPiVersion).toBeNull();
      });
    });

    describe('platform_status', () => {
      it('returns a well-formed status: known services, backup not-configured, llmUsage30d shape', async () => {
        const result = await callAsAdmin<PlatformStatusWire>('platform_status');

        const byService = new Map(result.health.map((h) => [h.service, h]));
        expect(byService.has('kernel')).toBe(true);
        expect(byService.get('kernel')?.status).toBe('ok');
        expect(byService.get('postgres')?.status).toBe('ok');
        expect(byService.has('llm-proxy')).toBe(true);
        expect(byService.has('worker-supervisor')).toBe(true);
        // Loopback-only by design (packages/egress-proxy/src/index.ts) — never probed.
        expect(byService.get('egress-proxy')).toMatchObject({ status: 'unknown' });
        for (const entry of result.health) {
          expect(['ok', 'degraded', 'down', 'unknown']).toContain(entry.status);
        }

        expect(result.backup).toEqual({
          configured: false,
          detail: expect.stringContaining('未配置'),
        });
        expect(result.llmUsage30d.windowDays).toBe(30);
        expect(result.llmUsage30d.totalInputTokens).toBeGreaterThanOrEqual(0);
        expect(result.llmUsage30d.totalOutputTokens).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(result.recentAudit)).toBe(true);
      }, 15_000);
    });
  },
);
