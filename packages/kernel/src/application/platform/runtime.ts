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
import { normalizeImageRef } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { setWorkspaceContext } from '../../adapters/db/platform-context.js';
import type {
  ResidentInventoryEntry,
  RuntimeImageInfo,
  RuntimeImageInventory,
  TaskSupervisorClientPort,
} from '../../adapters/supervisor-client/index.js';
import { listGateInstances } from '../gates/store.js';
import type { CapabilityHandler, CapabilityHandlerContext } from '../gateway/capability-handler.js';
import { readModelCatalog } from '../gateway/models-catalog-handler.js';
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
 * Label duplication (deliberate, not drift risk in practice): this package never depends on
 * `@nexttime/worker-supervisor` (the two communicate only over HTTP, `adapters/supervisor-
 * client`), so the `ai.nexttime.*` image label keys are literal copies of worker-supervisor's own
 * image/container-client constants, not imports — see each constant's own comment. The
 * `WORKER_IMAGE` env default itself is *not* duplicated here — this package has no way to know a
 * host's actual configured value (a host may override it away from the image's own build-time
 * default name), so every handler below reads worker-supervisor's own reported `defaultImage`
 * (`GET /images`) instead of guessing (see `resolveActiveImage`'s own doc comment).
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
 *  `pi_drift`) — a missing implementation or a network failure both degrade to `{defaultImage:
 *  undefined, images: [], allowedImages: []}`, never a thrown error, so one unreachable dependency
 *  never blanks out the rest of the dashboard. */
async function tryListImages(): Promise<{
  defaultImage: string | undefined;
  images: RuntimeImageInfo[];
  allowedImages: readonly string[];
}> {
  try {
    const client = getConfiguredTaskRuntime().supervisorClient;
    if (!client.listImages) return { defaultImage: undefined, images: [], allowedImages: [] };
    const inventory = await client.listImages();
    return {
      defaultImage: inventory.defaultImage,
      images: inventory.images,
      allowedImages: inventory.allowedImages,
    };
  } catch {
    return { defaultImage: undefined, images: [], allowedImages: [] };
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

/** What `activeImage`/`activeImageSource` should be, given the platform setting and
 *  worker-supervisor's own reported `defaultImage` — never a kernel-side guess (see this
 *  module's own doc comment). `'unknown'` only when the setting is unset *and* worker-supervisor
 *  could not be reached to report its own default.
 *
 *  Review follow-up (PR #233): the resolved value is normalized (`normalizeImageRef` — see that
 *  function's own doc comment). `settingValue` is already normalized in practice (every write
 *  path stores it that way as of this same follow-up), so this is a no-op for it; `defaultImage`
 *  is worker-supervisor's own raw, un-normalized `config.workerImage` and is the case that
 *  actually matters — without this, a host that has never called `set_active_runtime_image` (the
 *  exact state of a freshly-deployed production host) could never resolve `activeImageInfo` via
 *  `findImage` below, leaving `runtime_inventory` permanently unable to show an active image or
 *  compute `needsRebuild` for anything, until the first manual `set_active_runtime_image` call. */
function resolveActiveImage(
  settingValue: string | null,
  defaultImage: string | undefined,
): {
  activeImage: string | null;
  activeImageSource: 'setting' | 'env_default' | 'unknown';
} {
  if (settingValue) {
    return { activeImage: normalizeImageRef(settingValue), activeImageSource: 'setting' };
  }
  if (defaultImage) {
    return { activeImage: normalizeImageRef(defaultImage), activeImageSource: 'env_default' };
  }
  return { activeImage: null, activeImageSource: 'unknown' };
}

/** P1-a hotfix, revised by review follow-up (PR #233): `allowedImages` is normalized
 *  (`@nexttime/shared`'s `normalizeImageRef` — see that function's own doc comment for the full
 *  rationale) before this comparison, defensively on the kernel's own side even though worker-
 *  supervisor's `taskImageAllowlist` already normalizes its entries (a rolling upgrade could
 *  briefly have the two processes at different versions). `activatableRef` is the first of this
 *  image's own `tags` whose normalized form is allowlisted — a literal, exact entry of `tags`
 *  (never a normalized string that might not itself be a real tag), so it always passes
 *  `findImage`'s own exact match when the console sends it back to `set_active_runtime_image`.
 *  `null` when no tag qualifies (including an untagged image — a digest is never allowlisted,
 *  `image-ref.ts`'s own doc comment). `allowed` is just whether that search found anything; kept
 *  as its own field (not inlined) because it existed before `activatableRef` and other code/tests
 *  already read it. */
function toWireRuntimeImage(
  image: RuntimeImageInfo,
  allowedImages: ReadonlySet<string>,
): RuntimeImageWire {
  const activatableRef =
    image.tags.find((tag) => allowedImages.has(normalizeImageRef(tag))) ?? null;
  return {
    id: image.id,
    tags: [...image.tags],
    createdAt: image.created,
    piVersion: image.labels[IMAGE_PI_VERSION_LABEL] ?? null,
    platformExtensionVersion: image.labels[IMAGE_PLATFORM_EXTENSION_VERSION_LABEL] ?? null,
    builtFrom: image.labels[IMAGE_BUILT_FROM_LABEL] ?? null,
    labels: { ...image.labels },
    allowed: activatableRef !== null,
    activatableRef,
  };
}

/** `image` may be a tag (`repo:tag`) or an image id (`sha256:...`) — matches either against a
 *  known image's own `tags`/`id`. `undefined` when unresolvable (not built, or worker-supervisor
 *  unreachable — `images` is already `[]` in that case, from `tryListImages`/the caller's own
 *  fetch).
 *
 *  Review follow-up (PR #233): tag matching is normalized (`normalizeImageRef`, both sides) — an
 *  `image` with no explicit tag (worker-supervisor's own raw `defaultImage`, `resolveActiveImage`'s
 *  own doc comment) still resolves against an image whose only tag is the fully-qualified
 *  `:latest` form. The `id` match is unchanged (a digest is never affected by normalization, so
 *  there is nothing to gain by normalizing that side). */
function findImage(
  images: readonly RuntimeImageInfo[],
  image: string,
): RuntimeImageInfo | undefined {
  const normalizedImage = normalizeImageRef(image);
  return images.find(
    (candidate) =>
      candidate.id === image ||
      candidate.tags.some((tag) => normalizeImageRef(tag) === normalizedImage),
  );
}

// -------------------------------------------------------------------------------------------
// runtime_inventory / list_runtime_images
// -------------------------------------------------------------------------------------------

export const runtimeInventoryHandler: CapabilityHandler = async (client) => {
  const { settings } = await readPlatformSettings(client);
  const [imagesResult, residents] = await Promise.all([tryListImages(), tryListResidents()]);
  const { activeImage, activeImageSource } = resolveActiveImage(
    settings.activeRuntimeImage,
    imagesResult.defaultImage,
  );
  const activeImageInfo = activeImage ? findImage(imagesResult.images, activeImage) : undefined;
  const allowedImages = new Set(imagesResult.allowedImages.map(normalizeImageRef));

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
    activeImageInfo: activeImageInfo ? toWireRuntimeImage(activeImageInfo, allowedImages) : null,
    images: imagesResult.images.map((image) => toWireRuntimeImage(image, allowedImages)),
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
  const { images, allowedImages } = await supervisor.listImages();
  const allowedSet = new Set(allowedImages.map(normalizeImageRef));
  return { result: { items: images.map((image) => toWireRuntimeImage(image, allowedSet)) } };
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
  let allowedImages: readonly string[];
  try {
    ({ images, allowedImages } = await supervisor.listImages());
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
  // P1-a hotfix (post-v0.16.0 review): being *built* (in the inventory above) is not being
  // *allowlisted* — worker-supervisor's own spawn routes (`/task/spawn`, `/resident/spawn`) 403
  // any image outside `WORKER_IMAGE_ALLOWLIST` (`config.taskImageAllowlist`, a static, exact-
  // string, env-configured security boundary this handler must never re-implement or loosen).
  // Before this check, setting a non-allowlisted image active would silently 403 every future
  // spawn platform-wide the moment a Worker/entry container next tried to start.
  //
  // Review follow-up (PR #233): both sides are compared *normalized* (`normalizeImageRef` — see
  // that function's own doc comment) — worker-supervisor's own `taskImageAllowlist` already
  // normalizes its entries, but comparing raw here would still reject the bare, untagged form of
  // an allowlisted image, which is exactly the default `WORKER_IMAGE` shape on a host with no
  // `WORKER_IMAGE_ALLOWLIST` override.
  const normalizedImage = normalizeImageRef(image);
  const normalizedAllowedImages = new Set(allowedImages.map(normalizeImageRef));
  if (!normalizedAllowedImages.has(normalizedImage)) {
    throw new PlatformAdminError(
      'image_not_allowed',
      `image "${image}" is not in worker-supervisor's WORKER_IMAGE_ALLOWLIST — allowed: ${allowedImages.join(', ') || '(none)'}`,
    );
  }
  // Stored normalized (not the raw input) — the same value `resolveActiveRuntimeImage` later
  // forwards verbatim into a spawn request's own `image` field, so it always exactly matches
  // worker-supervisor's (already-normalized) allowlist without depending on that second process
  // to normalize it again.
  const row = await updatePlatformSettings(
    client,
    { activeRuntimeImage: normalizedImage },
    actingUser(context).id,
  );
  return {
    result: toWirePlatformSettings(row),
    resourceType: 'platform_settings',
  };
};

/** E3: "改回 platform_settings_history 里上一个值" — reread as "the most recent history version
 *  whose `activeRuntimeImage` *differs* from the current one", not "the immediately-prior
 *  version" (review fix, 2026-09-22): using `order by version desc limit 1` unconditionally broke
 *  as soon as any unrelated setting (e.g. `siteName`) was saved after the last image change — that
 *  version's own `activeRuntimeImage` still equals the current value, making rollback a silent
 *  no-op. Skipping over same-value versions instead makes this "switch back to the previous
 *  *different* image" — calling it repeatedly toggles between the last two distinct values (A → B
 *  → A → B → …), which is the intended recovery semantics and is now documented in
 *  `docs/runbooks/operations.md` §13 and this capability's own registry description. A missing
 *  key in an old history row (predates this field) is treated as JSON `null` (`coalesce(...,
 *  'null'::jsonb)`), matching an unset setting. Never re-validates the restored value against
 *  `list_runtime_images` (unlike `set_active_runtime_image`) — this is a deliberate recovery
 *  action reverting to a known-prior state; if that image has since been pruned from the host,
 *  `runtime_inventory` will show it missing and a spawn attempt will fail loudly on its own.
 *
 *  P1-a hotfix (post-v0.16.0 review): now DOES re-validate the restored value against
 *  worker-supervisor's own allowlist (`allowedImages`/`WORKER_IMAGE_ALLOWLIST`) — the
 *  inventory-existence skip above stands (a pruned-but-still-allowlisted image is a legitimate, if
 *  noisy, recovery target), but rolling back to a value an operator has since removed from
 *  `WORKER_IMAGE_ALLOWLIST` would silently 403 every future spawn platform-wide, exactly the
 *  failure mode this hotfix closes for `set_active_runtime_image`. Skipped entirely when
 *  `previousImage` is `null` (reverting to "unset" needs no allowlist check — worker-supervisor's
 *  own `defaultImage` is always allowlisted, `config.ts`'s `buildTaskImageAllowlist`); an
 *  unreachable supervisor refuses rather than guesses, same as `set_active_runtime_image`.
 *
 *  Review follow-up (PR #233): the allowlist comparison and the value actually restored are both
 *  normalized (`normalizeImageRef` — see that function's own doc comment), same reasoning as
 *  `set_active_runtime_image`. `previousImage` normalizes to itself when it already came from a
 *  post-fix `set_active_runtime_image` call (idempotent); an older, pre-fix history row could
 *  still hold a raw value, which this then normalizes on the way back out. */
export const rollbackRuntimeImageHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  _params,
  context,
) => {
  const { settings: currentSettings } = await readPlatformSettings(client);
  const currentImageJson = JSON.stringify(currentSettings.activeRuntimeImage ?? null);
  const historyResult = await client.query<{ settings: Record<string, unknown> }>(
    `select settings from platform_settings_history
      where coalesce(settings -> 'activeRuntimeImage', 'null'::jsonb) is distinct from $1::jsonb
      order by version desc
      limit 1`,
    [currentImageJson],
  );
  const previous = historyResult.rows[0];
  if (!previous) {
    throw new PlatformAdminError(
      'no_previous_settings_version',
      'no previous platform-settings version with a different activeRuntimeImage exists to roll back to',
    );
  }
  const previousValue = previous.settings.activeRuntimeImage;
  const previousImage: string | null =
    typeof previousValue === 'string' || previousValue === null ? previousValue : null;
  let normalizedPreviousImage: string | null = previousImage;

  if (previousImage !== null) {
    const supervisor = requireSupervisorClient();
    if (!supervisor.listImages) {
      throw new Error(
        'application/platform/runtime: the configured supervisor client does not implement listImages (S7-E)',
      );
    }
    let allowedImages: readonly string[];
    try {
      ({ allowedImages } = await supervisor.listImages());
    } catch (err) {
      throw new PlatformAdminError(
        'runtime_unreachable',
        `could not reach worker-supervisor to validate the rollback target: ${String(err)}`,
      );
    }
    normalizedPreviousImage = normalizeImageRef(previousImage);
    const normalizedAllowedImages = new Set(allowedImages.map(normalizeImageRef));
    if (!normalizedAllowedImages.has(normalizedPreviousImage)) {
      throw new PlatformAdminError(
        'image_not_allowed',
        `previous image "${previousImage}" is no longer in worker-supervisor's WORKER_IMAGE_ALLOWLIST — allowed: ${allowedImages.join(', ') || '(none)'}`,
      );
    }
  }

  const row = await updatePlatformSettings(
    client,
    { activeRuntimeImage: normalizedPreviousImage },
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
  // P3 hotfix (post-v0.16.0 review): wrapped like `setActiveRuntimeImageHandler`'s own
  // `supervisor.listImages()` call — an unreachable worker-supervisor otherwise threw whatever
  // `TaskSupervisorClient`'s raw HTTP error is (uncaught here), which has no mapping in
  // `interfaces/http/capability-route.ts` and surfaces as an unstructured 500 instead of this
  // capability's own clean `runtime_unreachable` (409).
  let imagesResult: RuntimeImageInventory;
  let residents: ResidentInventoryEntry[];
  try {
    [imagesResult, residents] = await Promise.all([
      supervisor.listImages(),
      supervisor.listResidents(),
    ]);
  } catch (err) {
    throw new PlatformAdminError(
      'runtime_unreachable',
      `could not reach worker-supervisor to roll entry containers: ${String(err)}`,
    );
  }
  // `imagesResult.defaultImage` is always a real string here — this is the hard, direct
  // `supervisor.listImages()` call (already guarded above), and worker-supervisor always reports
  // its own `config.workerImage`; `activeImageSource` is included only for symmetry with
  // `resolveActiveImage`'s other callers and is never `'unknown'` in practice on this path.
  const { activeImage } = resolveActiveImage(
    settings.activeRuntimeImage,
    imagesResult.defaultImage,
  );
  const activeImageInfo = activeImage ? findImage(imagesResult.images, activeImage) : undefined;
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
    // leftover 64 (docs/STATUS.md §4): closes the window between the Turn check below and
    // `stopResident` settling — during which a *new* Turn could start and be routed to the
    // resident this call is about to stop (agent-host then reports it `interrupted`; an existing,
    // already-graceful degradation path, but one worth actually closing rather than only
    // narrowing). `application/chat/service.ts`'s `sendChatMessage` takes the transaction-scoped
    // form of this *same* advisory lock, keyed identically, before starting a new Turn for this
    // principal — so a concurrent `sendChatMessage` call blocks here until this lock releases,
    // landing its own Turn-start strictly after this handler has already decided (and, if
    // `stopped`, already told worker-supervisor) what to do with this principal's resident. The
    // session-scoped form is used here (not `_xact`) because this handler's whole loop runs inside
    // one long-lived transaction (`client`) — an `_xact` lock would not release until the entire
    // `roll_entry_containers` call finishes, holding every earlier principal's lock long after this
    // handler has moved on to the next one. Explicitly unlocked in `finally` instead.
    const rollingLockKey = `roll_entry_containers:${principalId}`;
    await client.query('select pg_advisory_lock(hashtext($1::text))', [rollingLockKey]);
    try {
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
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1::text))', [rollingLockKey]);
    }
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
  const imagesResult = await tryListImages();
  const { activeImage } = resolveActiveImage(
    settings.activeRuntimeImage,
    imagesResult.defaultImage,
  );
  const activeImageInfo = activeImage ? findImage(imagesResult.images, activeImage) : undefined;
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

  // The two HTTP healthz probes touch no DB connection and run concurrently; the three DB reads
  // below all share this handler's single `client` (one Postgres connection/transaction) — a
  // `PoolClient` can only run one query at a time, so those three must be awaited in sequence,
  // never combined into the same `Promise.all` (a real bug this handler shipped with once,
  // caught by vitest.setup.ts's pg-concurrent-query guard under a real database — see the PR's
  // own history for this fix).
  const [llmProxyHealth, supervisorHealth] = await Promise.all([
    probeHttpHealthz('llm-proxy', llmProxyUrl),
    probeHttpHealthz('worker-supervisor', supervisorUrl),
  ]);
  const gateInstances = await listGateInstances(client);
  const llmUsage30d = await sumLlmUsage30Days(client);
  const recentAudit = await queryPlatformAudit(client, { limit: 50 });

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

// -------------------------------------------------------------------------------------------
// set_platform_default_model (E5, P-D 剩余 — "与 E1 同一块 platform_settings 代码")
// -------------------------------------------------------------------------------------------

/** E5: the platform's own default entry model (design §6.2 "平台默认入口模型") — what
 *  `create_workspace` falls back to when its caller omits `entryModel`
 *  (`application/gateway/platform-handlers.ts`'s `createWorkspaceHandler`), the same precedence
 *  `ensureDefaultWorkspace` already applies for the very first bootstrapped workspace
 *  (`default-workspace.ts`). Deliberately its own capability rather than folded into
 *  `update_platform_settings`'s generic patch (`wire/platform.ts`'s own comment on
 *  `defaultEntryModel`) — the same "validated write only" shape E1 established for
 *  `activeRuntimeImage`: a bare string patch could silently set a model the llm-proxy catalog
 *  does not know, a mistake this handler catches (`unknown_model` — the exact code
 *  `create_workspace`/`update_workspace` already throw for the identical rule; one violation, one
 *  code, not a second one invented for the same fact). `model: null` clears it back to "pi's own
 *  default" (design §6.2's "留空 = 用 pi 自己的默认值"). */
export const setPlatformDefaultModelHandler: CapabilityHandler = async (
  client,
  _workspaceId,
  params,
  context,
) => {
  const { model } = params as { model: string | null };
  if (model !== null) {
    const known = new Set((await readModelCatalog()).map((entry) => entry.id));
    if (!known.has(model)) {
      throw new PlatformAdminError('unknown_model', `model not in the llm-proxy catalog: ${model}`);
    }
  }
  const row = await updatePlatformSettings(
    client,
    { defaultEntryModel: model },
    actingUser(context).id,
  );
  return {
    result: toWirePlatformSettings(row),
    resourceType: 'platform_settings',
  };
};
