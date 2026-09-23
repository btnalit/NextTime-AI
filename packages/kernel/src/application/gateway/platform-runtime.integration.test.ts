import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import type { Pool } from 'pg';
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
 *
 * Private database per file (review fix, 2026-09-22 — same `createIsolatedDatabase` this suite's
 * sibling `platform-workspaces.integration.test.ts` already uses, and for the identical reason:
 * `platform_settings`/`platform_settings_history` are global singletons, not workspace-scoped, so
 * sharing CI's one `nexttime_test` database with every other integration test file would make
 * `rollback_runtime_image`'s `no_previous_settings_version` case (which needs to observe a
 * genuinely empty history table) depend on what other files happened to run first.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** Polls `pg_stat_activity` until no backend is connected to `name` — same rationale and
 *  implementation as `platform-workspaces.integration.test.ts`'s own `waitForNoConnections`
 *  (`pool.end()` only *schedules* each idle client's close, so without this wait `drop database …
 *  with (force)` can race a connection of this file's own still shutting down). */
async function waitForNoConnections(cluster: Pool, name: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await cluster.query<{ n: string }>(
      'select count(*)::text as n from pg_stat_activity where datname = $1',
      [name],
    );
    if (rows[0]?.n === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createIsolatedDatabase(): Promise<{
  readonly pool: Pool;
  readonly drop: () => Promise<void>;
}> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  const name = `nexttime_platform_runtime_${randomUUID().replace(/-/g, '')}`;
  try {
    await cluster.query(`create database "${name}"`);
  } catch (err) {
    await cluster.end();
    throw err;
  }
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString() });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await waitForNoConnections(cluster, name);
      await cluster.query(`drop database if exists "${name}" with (force)`);
      await cluster.end();
    },
  };
}

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
 *  `stoppedPrincipalIds` records every `stopResident` call for `roll_entry_containers` assertions.
 *  `defaultImage` mirrors worker-supervisor's own `config.workerImage` (S7-E review fix: the
 *  kernel must never guess this — see `application/platform/runtime.ts`'s own doc comment);
 *  `imagesShouldThrow` simulates worker-supervisor being unreachable for `listImages()`.
 *
 *  `allowedImages` (P1-a hotfix, post-v0.16.0 review): `undefined` (the default) means "allow
 *  every image currently registered in `images`, plus `defaultImage`" — a reasonable stand-in for
 *  real worker-supervisor's own `config.taskImageAllowlist` always including `config.workerImage`
 *  (`config.ts`'s `buildTaskImageAllowlist`) that lets every existing test in this file keep
 *  exercising `set_active_runtime_image`'s *inventory* check without separately wiring up an
 *  allowlist for each one. Tests that exercise the allowlist itself (the "allowlist (P1-a hotfix)"
 *  describe block below) set this explicitly, including to a strict subset of `images`. */
class FakeRuntimeSupervisorClient implements TaskSupervisorClientPort {
  images: RuntimeImageInfo[] = [];
  residents: ResidentInventoryEntry[] = [];
  defaultImage = 'nexttime-ai-worker-runtime';
  imagesShouldThrow = false;
  allowedImages: string[] | undefined = undefined;
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
  async listImages(): Promise<{
    defaultImage: string;
    images: RuntimeImageInfo[];
    allowedImages: readonly string[];
  }> {
    if (this.imagesShouldThrow) {
      throw new Error('simulated: worker-supervisor unreachable');
    }
    const allowedImages =
      this.allowedImages ?? [this.defaultImage, ...this.images.flatMap((image) => image.tags)];
    return { defaultImage: this.defaultImage, images: this.images, allowedImages };
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
    let dropDatabase: (() => Promise<void>) | undefined;
    let admin: UserRow;
    let supervisor: FakeRuntimeSupervisorClient;
    let workspaceId: string;
    /** `set_platform_default_model` (E5) validates against the same `readModelCatalog()`
     *  `list_platform_models`/`create_workspace` read — the same temp models.json convention
     *  `platform-workspaces.integration.test.ts` uses. */
    let modelsJsonDir: string | undefined;
    const originalModelsJsonFile = process.env.MODELS_JSON_FILE;
    const MODEL_A = 'anthropic/claude-sonnet-5';
    const MODEL_UNKNOWN = 'anthropic/claude-not-in-the-catalog';

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

    /** Test-only cleanup, outside any capability — `set_active_runtime_image` can only ever set a
     *  real, inventory-validated image, so a test that needs the setting genuinely *unset* (to
     *  exercise `activeImageSource: 'env_default' | 'unknown'`) has no capability-level way to get
     *  there once an earlier test in this shared-workspace file has set it. Bypasses
     *  `platform_settings_history` on purpose — this is test setup, not a rollback exercise. */
    async function resetActiveRuntimeImageSetting(): Promise<void> {
      await pool.query(
        `update platform_settings set settings = settings - 'activeRuntimeImage' where singleton`,
      );
    }

    beforeAll(async () => {
      if (DATABASE_URL === undefined) return;
      const isolated = await createIsolatedDatabase();
      pool = isolated.pool;
      dropDatabase = isolated.drop;
      await runMigrations(pool, MIGRATIONS_DIR);

      admin = await createPlatformAdmin(pool, {
        login: `runtime-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Runtime Admin',
        password: 'correct horse battery staple',
      });
      workspaceId = await insertBareWorkspace('platform-runtime-test-workspace');

      modelsJsonDir = await mkdtemp(path.join(tmpdir(), 'platform-runtime-models-json-'));
      const modelsFile = path.join(modelsJsonDir, 'models.json');
      await writeFile(
        modelsFile,
        JSON.stringify({
          providers: {
            anthropic: {
              baseUrl: 'http://llm-proxy:8082/anthropic',
              apiKey: '$CAPABILITY_HANDLE',
              api: 'anthropic-messages',
              models: [{ id: 'claude-sonnet-5' }],
            },
          },
        }),
      );
      process.env.MODELS_JSON_FILE = modelsFile;
    }, 120_000);

    afterAll(async () => {
      if (modelsJsonDir) await rm(modelsJsonDir, { recursive: true, force: true });
      if (originalModelsJsonFile === undefined) {
        // biome-ignore lint/performance/noDelete: process.env coerces `= undefined` to the string "undefined" instead of unsetting the var; delete is the only way to make it actually absent.
        delete process.env.MODELS_JSON_FILE;
      } else {
        process.env.MODELS_JSON_FILE = originalModelsJsonFile;
      }
      if (dropDatabase) await dropDatabase();
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

      // P1-a hotfix (post-v0.16.0 review): each image's own `allowed` reflects worker-supervisor's
      // real allowlist, not merely "is it built" — the console needs this to disable "设为活动" for
      // a built-but-not-allowlisted image (e.g. an untagged rebuild) up front.
      it('flags each image’s own `allowed` from worker-supervisor’s allowlist (P1-a hotfix)', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        supervisor.allowedImages = ['nexttime-ai-worker-runtime:v1'];
        const result = await callAsAdmin<{ items: RuntimeImageWire[] }>('list_runtime_images');
        expect(result.items.find((i) => i.id === IMAGE_V1.id)?.allowed).toBe(true);
        expect(result.items.find((i) => i.id === IMAGE_V2.id)?.allowed).toBe(false);
      });
    });

    describe('set_active_runtime_image / rollback_runtime_image', () => {
      // Must run before any other test in this describe block mutates `platform_settings` —
      // `platform_settings_history` is genuinely empty only on this file's own freshly-migrated,
      // isolated database (see the module doc comment on why this file no longer shares CI's
      // single `nexttime_test` database with every other integration test file).
      it('rejects rollback on a fresh install — no platform_settings_history row exists yet (no_previous_settings_version)', async () => {
        await expectPlatformError(
          () => callAsAdmin('rollback_runtime_image'),
          'no_previous_settings_version',
        );
      });

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

      it('rolls back to A after set A → set B → an unrelated settings write (siteName) — review fix', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v1' });
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v2' });
        // An unrelated settings write in between — the naive "one version ago" implementation
        // made rollback a no-op here (that version's activeRuntimeImage still reads "v2").
        await callAsAdmin('update_platform_settings', { siteName: `unrelated-${randomUUID()}` });

        const rolledBack = await callAsAdmin<PlatformSettingsWire>('rollback_runtime_image');
        expect(rolledBack.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v1');

        const settings = await callAsAdmin<PlatformSettingsWire>('get_platform_settings');
        expect(settings.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v1');
      });

      it('repeated rollback toggles between the last two distinct images', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v1' });
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v2' });

        const first = await callAsAdmin<PlatformSettingsWire>('rollback_runtime_image');
        expect(first.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v1');

        const second = await callAsAdmin<PlatformSettingsWire>('rollback_runtime_image');
        expect(second.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v2');
      });
    });

    // P1-a hotfix (post-v0.16.0 review): being in the image *inventory* (built) is not being in
    // worker-supervisor's own *allowlist* (`WORKER_IMAGE_ALLOWLIST`/`isImageAllowed`, the static
    // exact-string security boundary `/task/spawn` and `/resident/spawn` enforce) — setting or
    // rolling back to a non-allowlisted image used to silently 403 every future spawn
    // platform-wide the moment a Worker/entry container next tried to start.
    describe('set_active_runtime_image / rollback_runtime_image allowlist (P1-a hotfix)', () => {
      it('rejects a target that is in the inventory but not in the allowlist (image_not_allowed)', async () => {
        supervisor.images = [IMAGE_V1];
        supervisor.allowedImages = []; // built, but nothing allowlisted
        await expectPlatformError(
          () => callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v1' }),
          'image_not_allowed',
        );
      });

      it('accepts a target that is both in the inventory and the allowlist', async () => {
        supervisor.images = [IMAGE_V1];
        supervisor.allowedImages = ['nexttime-ai-worker-runtime:v1'];
        const result = await callAsAdmin<PlatformSettingsWire>('set_active_runtime_image', {
          image: 'nexttime-ai-worker-runtime:v1',
        });
        expect(result.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v1');
      });

      it('refuses to set the active image when worker-supervisor is unreachable (never guesses)', async () => {
        supervisor.imagesShouldThrow = true;
        await expectPlatformError(
          () => callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v1' }),
          'runtime_unreachable',
        );
      });

      it('refuses rollback to a previous value that has since been dropped from the allowlist (image_not_allowed)', async () => {
        supervisor.images = [IMAGE_V1, IMAGE_V2];
        supervisor.allowedImages = ['nexttime-ai-worker-runtime:v1', 'nexttime-ai-worker-runtime:v2'];
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v1' });
        await callAsAdmin('set_active_runtime_image', { image: 'nexttime-ai-worker-runtime:v2' });
        // An operator tightens WORKER_IMAGE_ALLOWLIST after the fact — v1 is no longer allowed.
        supervisor.allowedImages = ['nexttime-ai-worker-runtime:v2'];

        await expectPlatformError(() => callAsAdmin('rollback_runtime_image'), 'image_not_allowed');

        // The refused rollback must not have mutated the setting.
        const settings = await callAsAdmin<PlatformSettingsWire>('get_platform_settings');
        expect(settings.activeRuntimeImage).toBe('nexttime-ai-worker-runtime:v2');
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
        supervisor.images = []; // active image not found in the (empty) inventory
        supervisor.residents = [residentEntry({ imageId: 'sha256:unrelated' })];

        const result = await callAsAdmin<RuntimeInventoryWire>('runtime_inventory');
        expect(result.activeImageInfo).toBeNull();
        expect(result.residentContainers.every((c) => c.needsRebuild === false)).toBe(true);
      });

      it('uses worker-supervisor’s own reported defaultImage when the setting is unset (never a kernel-side guess — review fix)', async () => {
        await resetActiveRuntimeImageSetting();
        supervisor.defaultImage = 'custom-host-image-name:latest';
        supervisor.images = [];
        supervisor.residents = [];

        const result = await callAsAdmin<RuntimeInventoryWire>('runtime_inventory');
        expect(result.activeImage).toBe('custom-host-image-name:latest');
        expect(result.activeImageSource).toBe('env_default');
      });

      it('reports activeImageSource "unknown" (activeImage null) when the setting is unset and worker-supervisor is unreachable', async () => {
        await resetActiveRuntimeImageSetting();
        supervisor.imagesShouldThrow = true;
        supervisor.residents = [residentEntry({ imageId: 'sha256:unrelated' })];

        const result = await callAsAdmin<RuntimeInventoryWire>('runtime_inventory');
        expect(result.activeImage).toBeNull();
        expect(result.activeImageSource).toBe('unknown');
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

    // S7-E E5 (P-D 剩余): `set_platform_default_model` — validated against the same catalog
    // `list_platform_models`/`create_workspace` read, deliberately its own capability rather than
    // part of `update_platform_settings`'s generic patch (E1's `activeRuntimeImage` precedent).
    describe('set_platform_default_model', () => {
      afterEach(async () => {
        // Global singleton — never leak a set default into a later test in this file.
        await pool.query(
          `update platform_settings set settings = settings - 'defaultEntryModel' where singleton`,
        );
      });

      it('rejects a model that is not in the llm-proxy catalog', async () => {
        await expectPlatformError(
          () => callAsAdmin('set_platform_default_model', { model: MODEL_UNKNOWN }),
          'unknown_model',
        );
      });

      it('sets the default and reflects it in get_platform_settings', async () => {
        const result = await callAsAdmin<PlatformSettingsWire>('set_platform_default_model', {
          model: MODEL_A,
        });
        expect(result.defaultEntryModel).toBe(MODEL_A);

        const settings = await callAsAdmin<PlatformSettingsWire>('get_platform_settings');
        expect(settings.defaultEntryModel).toBe(MODEL_A);
      });

      it('clears the default back to null (pi’s own default)', async () => {
        await callAsAdmin('set_platform_default_model', { model: MODEL_A });
        const cleared = await callAsAdmin<PlatformSettingsWire>('set_platform_default_model', {
          model: null,
        });
        expect(cleared.defaultEntryModel).toBeNull();
      });

      it('is audited like other settings writes', async () => {
        await callAsAdmin('set_platform_default_model', { model: MODEL_A });
        const audit = await pool.query<{ actor_user_id: string }>(
          `select actor_user_id from audit_records
             where action = 'set_platform_default_model' and workspace_id is null
             order by created_at desc limit 1`,
        );
        expect(audit.rows[0]?.actor_user_id).toBe(admin.id);
      });

      it('update_platform_settings no longer accepts defaultEntryModel', async () => {
        await expect(
          callAsAdmin('update_platform_settings', { defaultEntryModel: MODEL_A }),
        ).rejects.toMatchObject({ name: 'InvalidCapabilityParamsError' });
      });
    });
  },
);
