import { readFile } from 'node:fs/promises';
import type {
  GateHealthWire,
  PiDriftStatusWire,
  PiDriftWire,
  PlatformStatusLlmUsageWire,
  PlatformStatusWire,
  ResidentContainerWire,
  RollEntryContainerOutcomeWire,
  RollEntryContainersResultWire,
  RuntimeImageWire,
  RuntimeInventoryWire,
  ServiceHealthWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { setWorkspaceContext } from '../../adapters/db/platform-context.js';
import type {
  ResidentInventoryEntry,
  RuntimeImageInfo,
  TaskSupervisorClientPort,
} from '../../adapters/supervisor-client/index.js';
import { listGateInstances } from '../gates/store.js';
import type { CapabilityHandler, CapabilityHandlerContext } from '../gateway/capability-handler.js';
import { PlatformAdminError, queryPlatformAudit } from '../gateway/platform-handlers.js';
import { getConfiguredTaskRuntime } from '../task/runtime.js';
import {
  readPlatformSettings,
  toWirePlatformSettings,
  updatePlatformSettings,
} from './settings.js';

/**
 * application/platform/runtime: the runtime layer (docs/platform-admin-design.md §6.5, §6.7;
 * docs/development-tasks.md §5d S7-E 决定 E1–E4) — active runtime image, image inventory,
 * resident-container "待重建" derivation, pi drift, and `platform_status`. Every handler here is
 * `scope:'platform'` (registered in `application/gateway/handlers.ts`, not `platform-handlers.ts`
 * itself — S7-E's own dispatch note: "handler 各放新文件... 共享文件只加注册行").
 *
 * Label/default duplication (deliberate, not drift risk in practice): this package never depends
 * on `@nexttime/worker-supervisor` (the two communicate only over HTTP, `adapters/supervisor-
 * client`), so the `ai.nexttime.*` image label keys and the `WORKER_IMAGE` env default are
 * literal copies of worker-supervisor's own image/container-client and config constants, not
 * imports — see each constant's own comment.
 *
 * "待重建" (E2) is always derived here, live, from two facts worker-supervisor reports over HTTP
 * (`GET /images`, `GET /residents`) — comparing resolved image ids (`RuntimeImageInfo.id` /
 * `ResidentInventoryEntry.imageId`), never a registry digest (these images are never pushed) and
 * never anything stored in Postgres. A resolution failure (supervisor unreachable, active image
 * not found in the inventory) always degrades to "unknown, not guessed" — see each function's own
 * comment for exactly which capabilities treat that as a soft empty result (`runtime_inventory`,
 * `platform_status` — dashboards) versus a hard error (`list_runtime_images`,
 * `set_active_runtime_image`, `roll_entry_containers` — actions that must not silently no-op on a
 * failure the caller needs to see).
 */

/** Mirrors worker-supervisor's own image/container-client constants — see this module's doc
 *  comment for why these are literal copies, not an import. */
const IMAGE_PI_VERSION_LABEL = 'ai.nexttime.pi-version';
const IMAGE_PLATFORM_EXTENSION_VERSION_LABEL = 'ai.nexttime.platform-extension-version';
const IMAGE_BUILT_FROM_LABEL = 'ai.nexttime.built-from';

/** Mirrors `packages/worker-supervisor/src/config.ts`'s own `loadConfig` default for
 *  `WORKER_IMAGE` — used only to *display* what the active image resolves to when the platform
 *  setting is unset (`activeImageSource: 'env_default'`); worker-supervisor itself is still the
 *  one process that actually applies this default at spawn time; a host that overrides
 *  `WORKER_IMAGE` away from this value will see a display-only mismatch here until an
 *  administrator sets `activeRuntimeImage` explicitly (best-effort, documented in the PR body's
 *  own assumptions list, not silently treated as authoritative). */
const DEFAULT_WORKER_IMAGE = 'nexttime-ai-worker-runtime';

/** Nil UUID — the same placeholder `platform-handlers.ts`'s `countGatekeepers` already uses for
 *  `setWorkspaceContext`'s `principalId` argument when no real acting Principal exists for the
 *  statement about to run (every RLS policy touched below is `workspace_id = app_workspace()`
 *  only, never principal-scoped). */
const NIL_PRINCIPAL = '00000000-0000-0000-0000-000000000000';

/** S7-E 决定 E1: resolved once per `startTurn`/`task/spawn` by the callers
 *  (`application/host-bridge/agent-host-runtime.ts`, `application/task/invoke.ts`,
 *  `application/task/lifecycle.ts`) — mirrors `readInstanceInstructions`'s own shape exactly
 *  (`application/platform/instance-instructions.ts`). `undefined` (the platform setting is unset)
 *  means "worker-supervisor's own `WORKER_IMAGE` env default applies" — the caller must omit the
 *  field entirely rather than invent a value, exactly as `model`/`systemPrompt` already do. */
export async function resolveActiveRuntimeImage(client: PoolClient): Promise<string | undefined> {
  const { settings } = await readPlatformSettings(client);
  return settings.activeRuntimeImage ?? undefined;
}

function actingUser(context: CapabilityHandlerContext | undefined): { id: string; login: string } {
  if (!context?.platformUser) {
    throw new Error('application/platform/runtime handler invoked outside a platform transaction');
  }
  return context.platformUser;
}

function requireSupervisorClient(): TaskSupervisorClientPort {
  return getConfiguredTaskRuntime().supervisorClient;
}

/** Soft read for dashboard-style aggregations (`runtime_inventory`, `platform_status`,
 *  `pi_drift`) — a missing implementation or a network failure both degrade to `[]`, never a
 *  thrown error, so one unreachable dependency never blanks out the rest of the dashboard. */
async function tryListImages(): Promise<RuntimeImageInfo[]> {
  try {
    const client = getConfiguredTaskRuntime().supervisorClient;
    return client.listImages ? await client.listImages() : [];
  } catch {
    return [];
  }
}

async function tryListResidents(): Promise<ResidentInventoryEntry[]> {
  try {
    const client = getConfiguredTaskRuntime().supervisorClient;
    return client.listResidents ? await client.listResidents() : [];
  } catch {
    return [];
  }
}

function toWireRuntimeImage(image: RuntimeImageInfo): RuntimeImageWire {
  return {
    id: image.id,
    tags: [...image.tags],
    createdAt: image.created,
    piVersion: image.labels[IMAGE_PI_VERSION_LABEL] ?? null,
    platformExtensionVersion: image.labels[IMAGE_PLATFORM_EXTENSION_VERSION_LABEL] ?? null,
    builtFrom: image.labels[IMAGE_BUILT_FROM_LABEL] ?? null,
    labels: { ...image.labels },
  };
}

/** `image` may be a tag (`repo:tag`) or an image id (`sha256:...`) — matches either against a
 *  known image's own `tags`/`id`. `undefined` when unresolvable (not built, or worker-supervisor
 *  unreachable — `images` is already `[]` in that case, from `tryListImages`/the caller's own
 *  fetch). */
function findImage(
  images: readonly RuntimeImageInfo[],
  image: string,
): RuntimeImageInfo | undefined {
  return images.find((candidate) => candidate.id === image || candidate.tags.includes(image));
}

// -------------------------------------------------------------------------------------------
// runtime_inventory / list_runtime_images
// -------------------------------------------------------------------------------------------

export const runtimeInventoryHandler: CapabilityHandler = async (client) => {
  const { settings } = await readPlatformSettings(client);
  const activeImage = settings.activeRuntimeImage ?? DEFAULT_WORKER_IMAGE;
  const activeImageSource: 'setting' | 'env_default' = settings.activeRuntimeImage
    ? 'setting'
    : 'env_default';

  const [images, residents] = await Promise.all([tryListImages(), tryListResidents()]);
  const activeImageInfo = findImage(images, activeImage);

  const residentContainers: ResidentContainerWire[] = residents.map((resident) => ({
    principalId: resident.principalId,
    workspaceId: resident.workspaceId,
    containerId: resident.containerId,
    running: resident.running,
    status: resident.status,
    image: resident.image ?? null,
    imageId: resident.imageId ?? null,
    startedAt: resident.startedAt ?? null,
    lastTouchedAt: resident.lastTouchedAt ?? null,
    // E2: unresolvable (no active image match, or this container's own image id unknown) is
    // always `false` — never a guessed `true`. See this module's own doc comment.
    needsRebuild: Boolean(
      activeImageInfo && resident.imageId && resident.imageId !== activeImageInfo.id,
    ),
  }));

  const result: RuntimeInventoryWire = {
    activeImage,
    activeImageSource,
    activeImageInfo: activeImageInfo ? toWireRuntimeImage(activeImageInfo) : null,
    images: images.map(toWireRuntimeImage),
    residentContainers,
    checkedAt: new Date().toISOString(),
  };
  return { result };
};

/** Unlike `runtime_inventory`, this is the *only* thing the call is for — a supervisor failure
 *  must surface as a real error (`TaskRuntimeNotConfiguredError`/`TaskSupervisorError`, both
 *  already descriptive), never a silently empty list that could read as "nothing has been built
 *  yet". */
export const listRuntimeImagesHandler: CapabilityHandler = async () => {
  const supervisor = requireSupervisorClient();
  if (!supervisor.listImages) {
    throw new Error(
      'application/platform/runtime: the configured supervisor client does not implement listImages (S7-E)',
    );
  }
  const images = await supervisor.listImages();
  return { result: { items: images.map(toWireRuntimeImage) } };
};

// -------------------------------------------------------------------------------------------
// set_active_runtime_image / rollback_runtime_image
// -------------------------------------------------------------------------------------------

export const setActiveRuntimeImageHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const { image } = params as { image: string };
  const supervisor = requireSupervisorClient();
  if (!supervisor.listImages) {
    throw new Error(
      'application/platform/runtime: the configured supervisor client does not implement listImages (S7-E)',
    );
  }
  let images: RuntimeImageInfo[];
  try {
    images = await supervisor.listImages();
  } catch (err) {
    throw new PlatformAdminError(
      'runtime_unreachable',
      `could not reach worker-supervisor to validate the image: ${String(err)}`,
    );
  }
  if (!findImage(images, image)) {
    throw new PlatformAdminError(
      'image_not_in_inventory',
      `image "${image}" is not in list_runtime_images — build it on the host/CI first (docs/runbooks/operations.md §13) before setting it active`,
    );
  }
  const row = await updatePlatformSettings(
    client,
    { activeRuntimeImage: image },
    actingUser(context).id,
  );
  return {
    result: toWirePlatformSettings(row),
    resourceType: 'platform_settings',
  };
};

/** E3: "改回 platform_settings_history 里上一个值" — the immediately-prior *settings version's*
 *  own `activeRuntimeImage`, not the last time that field specifically changed. When an unrelated
 *  setting (e.g. `siteName`) was the most recent write, that version's `activeRuntimeImage` still
 *  equals the current one, and this is then a documented no-op — settings roll back by version,
 *  the same granularity `platform_settings_history` already stores at, not per-field history
 *  (see the PR body's own assumptions list). Never re-validates the restored value against
 *  `list_runtime_images` (unlike `set_active_runtime_image`) — this is a deliberate recovery
 *  action reverting to a known-prior state; if that image has since been pruned from the host,
 *  `runtime_inventory` will show it missing and a spawn attempt will fail loudly on its own. */
export const rollbackRuntimeImageHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  _params,
  context,
) => {
  const historyResult = await client.query<{ settings: Record<string, unknown> }>(
    'select settings from platform_settings_history order by version desc limit 1',
  );
  const previous = historyResult.rows[0];
  if (!previous) {
    throw new PlatformAdminError(
      'no_previous_settings_version',
      'no previous platform-settings version exists to roll back to',
    );
  }
  const previousValue = previous.settings.activeRuntimeImage;
  const previousImage: string | null =
    typeof previousValue === 'string' || previousValue === null ? previousValue : null;
  const row = await updatePlatformSettings(
    client,
    { activeRuntimeImage: previousImage },
    actingUser(context).id,
  );
  return {
    result: toWirePlatformSettings(row),
    resourceType: 'platform_settings',
  };
};

// -------------------------------------------------------------------------------------------
// roll_entry_containers (E2 — acceleration only)
// -------------------------------------------------------------------------------------------

/** Whether `principalId` has an in-flight Turn, checked against the kernel's own durable
 *  bookkeeping (`activities` — `kind='agent_turn' and status='running' and started_by=
 *  <principalId>`, set by `application/chat/service.ts`'s `sendChatMessage`/`substrate/epistemic`'s
 *  `startActivity`), not agent-host's in-memory state — this is exactly the DB-backed signal E2's
 *  "kernel's own turn bookkeeping" asks for: reliable, survives a kernel restart, and (via
 *  `setWorkspaceContext`) reachable across every workspace from inside the one open platform
 *  transaction without a second, RLS-bypassing connection. */
async function hasInFlightTurn(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  await setWorkspaceContext(client, workspaceId, NIL_PRINCIPAL);
  const result = await client.query(
    `select 1 from activities
      where kind = 'agent_turn' and status = 'running' and started_by = $1
      limit 1`,
    [principalId],
  );
  return result.rows.length > 0;
}

export const rollEntryContainersHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
) => {
  const { principalIds } = params as { principalIds?: string[] };
  const supervisor = requireSupervisorClient();
  if (!supervisor.listImages || !supervisor.listResidents || !supervisor.stopResident) {
    throw new Error(
      'application/platform/runtime: the configured supervisor client does not implement listImages/listResidents/stopResident (S7-E roll_entry_containers)',
    );
  }

  const { settings } = await readPlatformSettings(client);
  const activeImage = settings.activeRuntimeImage ?? DEFAULT_WORKER_IMAGE;
  const [images, residents] = await Promise.all([
    supervisor.listImages(),
    supervisor.listResidents(),
  ]);
  const activeImageInfo = findImage(images, activeImage);
  const byPrincipal = new Map(residents.map((resident) => [resident.principalId, resident]));

  const targetIds = principalIds ?? residents.map((resident) => resident.principalId);
  const outcomes: RollEntryContainerOutcomeWire[] = [];
  let stoppedCount = 0;

  for (const principalId of targetIds) {
    const resident = byPrincipal.get(principalId);
    if (!resident) {
      outcomes.push({ principalId, workspaceId: '', action: 'skipped_not_found' });
      continue;
    }
    const needsRebuild = Boolean(
      activeImageInfo && resident.imageId && resident.imageId !== activeImageInfo.id,
    );
    if (!needsRebuild) {
      outcomes.push({
        principalId,
        workspaceId: resident.workspaceId,
        action: 'skipped_up_to_date',
      });
      continue;
    }
    const inFlight = await hasInFlightTurn(client, resident.workspaceId, principalId);
    if (inFlight) {
      outcomes.push({
        principalId,
        workspaceId: resident.workspaceId,
        action: 'skipped_in_flight',
      });
      continue;
    }
    await supervisor.stopResident(principalId);
    outcomes.push({ principalId, workspaceId: resident.workspaceId, action: 'stopped' });
    stoppedCount += 1;
  }

  const result: RollEntryContainersResultWire = { outcomes, stoppedCount };
  return { result };
};

// -------------------------------------------------------------------------------------------
// pi_drift (E3)
// -------------------------------------------------------------------------------------------

/** The path to the CI-produced static JSON — never a live npm/GitHub lookup (E3 "不出网"). This
 *  repo's current `pi-drift.yml` (2026-09-22) checks pi@latest test compatibility and opens a
 *  tracking issue; it does not yet emit this comparison file, so `pinnedPiVersion` is `null` and
 *  `status` is always `'unknown'` until a future CI change writes one here (documented assumption
 *  — see the PR body). Expected shape: `{ "pinnedPiVersion": "0.84.4", "checkedAt": "<ISO>" }`,
 *  extra fields tolerated. */
const PI_DRIFT_FILE_ENV = 'PI_DRIFT_FILE';
const DEFAULT_PI_DRIFT_FILE = '/data/config/pi-drift.json';

async function readPinnedPiVersion(): Promise<{
  pinnedPiVersion: string | null;
  checkedAt: string | null;
}> {
  const filePath = process.env[PI_DRIFT_FILE_ENV] || DEFAULT_PI_DRIFT_FILE;
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { pinnedPiVersion?: unknown; checkedAt?: unknown };
    return {
      pinnedPiVersion: typeof parsed.pinnedPiVersion === 'string' ? parsed.pinnedPiVersion : null,
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null,
    };
  } catch {
    return { pinnedPiVersion: null, checkedAt: null };
  }
}

export const piDriftHandler: CapabilityHandler = async (client) => {
  const { settings } = await readPlatformSettings(client);
  const activeImage = settings.activeRuntimeImage ?? DEFAULT_WORKER_IMAGE;
  const images = await tryListImages();
  const activeImageInfo = findImage(images, activeImage);
  const activeImagePiVersion = activeImageInfo?.labels[IMAGE_PI_VERSION_LABEL] ?? null;
  const platformExtensionVersion =
    activeImageInfo?.labels[IMAGE_PLATFORM_EXTENSION_VERSION_LABEL] ?? null;
  const { pinnedPiVersion, checkedAt } = await readPinnedPiVersion();

  let status: PiDriftStatusWire;
  let detail: string;
  if (pinnedPiVersion === null) {
    status = 'unknown';
    detail =
      'no CI-produced pi-drift file found in this deployment (PI_DRIFT_FILE / /data/config/pi-drift.json) — see docs/runbooks';
  } else if (activeImagePiVersion === null) {
    status = 'unknown';
    detail = 'the active runtime image was not found, or carries no ai.nexttime.pi-version label';
  } else if (pinnedPiVersion === activeImagePiVersion) {
    status = 'consistent';
    detail = `pi.version and the active runtime image agree (${pinnedPiVersion})`;
  } else {
    status = 'drifted';
    detail = `pi.version=${pinnedPiVersion} but the active runtime image was built with pi ${activeImagePiVersion}`;
  }

  const result: PiDriftWire = {
    status,
    pinnedPiVersion,
    activeImagePiVersion,
    platformExtensionVersion,
    detail,
    checkedAt,
  };
  return { result };
};

// -------------------------------------------------------------------------------------------
// platform_status (E4)
// -------------------------------------------------------------------------------------------

const HEALTHZ_TIMEOUT_MS = 2000;

async function probeHttpHealthz(service: string, baseUrl: string): Promise<ServiceHealthWire> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTHZ_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/healthz`, {
      signal: controller.signal,
    });
    return { service, status: res.ok ? 'ok' : 'degraded', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { service, status: 'down', detail: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function mapGateHealth(health: GateHealthWire): ServiceHealthWire['status'] {
  switch (health) {
    case 'ok':
      return 'ok';
    case 'unreachable':
      return 'down';
    case 'unauthorized':
      return 'degraded';
    default:
      return 'unknown';
  }
}

interface LlmUsageSumRow {
  cost_usd_sum: string | null;
  input_tokens_sum: string | null;
  output_tokens_sum: string | null;
  n: string;
}

/** 30-day cross-workspace rollup, one workspace at a time under its own RLS-scoped
 *  `setWorkspaceContext` — same loop shape `platform-handlers.ts`'s own `countGatekeepers`
 *  already uses for the identical "sum something workspace-scoped across every workspace" need,
 *  from inside the one already-open platform transaction (no second, RLS-bypassing connection). */
async function sumLlmUsage30Days(client: PoolClient): Promise<PlatformStatusLlmUsageWire> {
  const workspaces = await client.query<{ id: string }>('select id from workspaces');
  let totalCostUsd: number | null = null;
  let sawCost = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let callCount = 0;

  for (const workspace of workspaces.rows) {
    await setWorkspaceContext(client, workspace.id, NIL_PRINCIPAL);
    const result = await client.query<LlmUsageSumRow>(
      `select sum(cost_usd)::text as cost_usd_sum,
              sum(input_tokens)::text as input_tokens_sum,
              sum(output_tokens)::text as output_tokens_sum,
              count(*)::text as n
         from llm_usage
        where workspace_id = $1 and started_at >= now() - interval '30 days'`,
      [workspace.id],
    );
    const row = result.rows[0];
    if (row?.cost_usd_sum !== null && row?.cost_usd_sum !== undefined) {
      sawCost = true;
      totalCostUsd = (totalCostUsd ?? 0) + Number(row.cost_usd_sum);
    }
    totalInputTokens += Number(row?.input_tokens_sum ?? '0');
    totalOutputTokens += Number(row?.output_tokens_sum ?? '0');
    callCount += Number(row?.n ?? '0');
  }

  return {
    windowDays: 30,
    totalCostUsd: sawCost ? totalCostUsd : null,
    totalInputTokens,
    totalOutputTokens,
    callCount,
  };
}

export const platformStatusHandler: CapabilityHandler = async (client) => {
  const llmProxyUrl = process.env.KERNEL_LLM_URL ?? 'http://llm-proxy:8082';
  const supervisorUrl = process.env.SUPERVISOR_URL ?? 'http://worker-supervisor:8081';

  const [llmProxyHealth, supervisorHealth, gateInstances, llmUsage30d, recentAudit] =
    await Promise.all([
      probeHttpHealthz('llm-proxy', llmProxyUrl),
      probeHttpHealthz('worker-supervisor', supervisorUrl),
      listGateInstances(client),
      sumLlmUsage30Days(client),
      queryPlatformAudit(client, { limit: 50 }),
    ]);

  const health: ServiceHealthWire[] = [
    { service: 'kernel', status: 'ok' },
    // Inside a transaction on an already-open connection — if postgres were unreachable, nothing
    // above this point would have run (same convention `platformOverviewHandler` already uses).
    { service: 'postgres', status: 'ok' },
    llmProxyHealth,
    supervisorHealth,
    {
      service: 'egress-proxy',
      status: 'unknown',
      detail:
        'healthz is loopback-only by design (packages/egress-proxy/src/index.ts — an isolation boundary this capability does not weaken) — not probed',
    },
    ...gateInstances.map(
      (instance): ServiceHealthWire => ({
        service: `gate:${instance.displayName || instance.gateId}`,
        status: mapGateHealth(instance.health),
        detail: `trust=${instance.trust}; lastCheckedAt=${instance.lastCheckedAt ?? 'never'}`,
      }),
    ),
  ];

  const result: PlatformStatusWire = {
    health,
    backup: {
      configured: false,
      detail: '未配置 not configured — 遗留 6 落地前如实显示；本能力不新增备份定时器',
    },
    llmUsage30d,
    recentAudit: recentAudit.items,
    checkedAt: new Date().toISOString(),
  };
  return { result };
};
