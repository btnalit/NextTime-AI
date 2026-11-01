import {
  MigrationRefSchema,
  PLATFORM_STATE_COMMIT_PATTERN,
  PLATFORM_STATE_COMPONENT_VERSION_PATTERN,
  PLATFORM_STATE_IMAGES_LIMIT,
  PLATFORM_STATE_IMAGE_DIGEST_PATTERN,
  PLATFORM_STATE_INVARIANTS_LIMIT,
  PLATFORM_STATE_INVARIANT_ID_PATTERN,
  PLATFORM_STATE_MIGRATIONS_LIMIT,
  PLATFORM_STATE_RELEASES_LIMIT,
  PiReleaseVersionSchema,
  PiSdkSuiteResultSchema,
  PiUpdateStateWireSchema,
  PlatformReleaseVersionSchema,
  type PlatformStateInvariantsWire,
  type PlatformStatePiUpdateWire,
  type PlatformStatePlatformUpdateWire,
  type PlatformStateReleaseWire,
  type PlatformStateRuntimeImageWire,
  type PlatformStateRuntimeWire,
  PlatformStateServiceWireSchema,
  type PlatformStateUpdateFeedWire,
  type PlatformStateUpdatesWire,
  PlatformUpdateFeedStaleCauseWireSchema,
  PlatformUpdateFeedStatusWireSchema,
  type PlatformUpdatesWire,
  type RuntimeImageWire,
  type RuntimeInventoryWire,
  type ServiceHealthWire,
} from '@nexttime/shared';
import { z } from 'zod';
import { INVARIANT_CHECK_IDS, type InvariantMetricsSnapshot } from '../../substrate/audit/index.js';
import {
  count,
  knownBoolean,
  lengthOf,
  member,
  normalizedTimestamp,
  shaped,
  versionOf,
} from './platform-state-shapes.js';

/**
 * application/admin-agent/platform-state-runtime (S11 AA2b): the projections of the platform
 * state an admin agent reads from outside the database's rows — the runtime layer
 * (`runtime_inventory` and `platform_status`'s service probes), the update record
 * (`platform_updates`) and the kernel's invariant checks (`InvariantMetricsStore`). Pure: the
 * caller (application/gateway/platform-state-handlers.ts) reads the sources inside the read-only
 * platform transaction of {@link readPlatformStateForAdminAgent} and passes them here.
 *
 * The same rules as platform-state.ts: built field by field, never spread; a string passes only in
 * its shape. What each one leaves out is what can name a place or carry a step: image tags (a tag
 * can name a registry by host and port), image labels (any key, any value), container ids and the
 * workspaces and Principals containers belong to, service probe text (an error's message), the
 * update record's links, the host commands for applying a release, the drift check's failure
 * text, the feed's operator text (it names the feed file), and the invariant checks' samples
 * (identifiers of violating rows, other workspaces' among them).
 */

const ComponentVersionSchema = z.string().regex(PLATFORM_STATE_COMPONENT_VERSION_PATTERN);

// -------------------------------------------------------------------------------------------
// runtime
// -------------------------------------------------------------------------------------------

/** One runtime image as an admin agent sees it, or `null` when its digest or creation time is out
 *  of shape. `activeDigest` is the active image's, when known. */
export function projectRuntimeImage(
  image: RuntimeImageWire,
  activeDigest: string | null,
): PlatformStateRuntimeImageWire | null {
  const digest = shaped(image.id, PLATFORM_STATE_IMAGE_DIGEST_PATTERN);
  const createdAt = normalizedTimestamp(image.createdAt);
  if (digest === null || createdAt === null) return null;
  return {
    digest,
    createdAt,
    piVersion: versionOf(image.piVersion, ComponentVersionSchema),
    platformExtensionVersion: versionOf(image.platformExtensionVersion, ComponentVersionSchema),
    builtFrom: shaped(image.builtFrom, PLATFORM_STATE_COMMIT_PATTERN),
    allowed: image.allowed === true,
    runtimeCompatible: knownBoolean(image.runtimeCompatible),
    active: activeDigest !== null && digest === activeDigest,
  };
}

/** `platform_state_runtime`'s result from `runtime_inventory`'s and the platform's own service
 *  probes (`probePlatformServiceHealth`). */
export function projectRuntimeState(
  inventory: RuntimeInventoryWire,
  services: readonly ServiceHealthWire[],
  checkedAt: string,
): PlatformStateRuntimeWire {
  const info = inventory.activeImageInfo;
  const activeDigest = info ? shaped(info.id, PLATFORM_STATE_IMAGE_DIGEST_PATTERN) : null;
  const sourceImages = Array.isArray(inventory.images) ? inventory.images : [];
  const images = sourceImages
    .map((image) => projectRuntimeImage(image, activeDigest))
    .filter((image): image is PlatformStateRuntimeImageWire => image !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const residents = Array.isArray(inventory.residentContainers) ? inventory.residentContainers : [];
  const projectedServices: PlatformStateRuntimeWire['services'] = [];
  for (const entry of services) {
    const service = member(PlatformStateServiceWireSchema, entry.service);
    const status = member(z.enum(['ok', 'degraded', 'down', 'unknown']), entry.status);
    if (service === null || status === null) continue;
    if (projectedServices.some((known) => known.service === service)) continue;
    projectedServices.push({ service, status });
  }
  return {
    activeImage: {
      source:
        member(z.enum(['setting', 'env_default', 'unknown']), inventory.activeImageSource) ??
        'unknown',
      digest: activeDigest,
      piVersion: info ? versionOf(info.piVersion, ComponentVersionSchema) : null,
      platformExtensionVersion: info
        ? versionOf(info.platformExtensionVersion, ComponentVersionSchema)
        : null,
      builtFrom: info ? shaped(info.builtFrom, PLATFORM_STATE_COMMIT_PATTERN) : null,
      runtimeCompatible: info ? knownBoolean(info.runtimeCompatible) : null,
    },
    images: images.slice(0, PLATFORM_STATE_IMAGES_LIMIT),
    imageCount: sourceImages.length,
    entryContainers: {
      total: residents.length,
      running: residents.filter((resident) => resident.running === true).length,
      needsRebuild: residents.filter((resident) => resident.needsRebuild === true).length,
    },
    services: projectedServices,
    checkedAt,
  };
}

// -------------------------------------------------------------------------------------------
// updates
// -------------------------------------------------------------------------------------------

function projectRelease(release: unknown): PlatformStateReleaseWire | null {
  if (typeof release !== 'object' || release === null) return null;
  const source = release as Record<string, unknown>;
  const version = versionOf(source.version, PlatformReleaseVersionSchema);
  const publishedAt = normalizedTimestamp(source.publishedAt);
  if (version === null || publishedAt === null) return null;
  return {
    version,
    publishedAt,
    breaking: source.breaking === true,
    pi: versionOf(source.pi, PiReleaseVersionSchema),
    migrationCount: lengthOf(source.migrations),
  };
}

function projectPlatformUpdate(
  update: NonNullable<PlatformUpdatesWire['platformUpdate']>,
): PlatformStatePlatformUpdateWire {
  const migrations = Array.isArray(update.migrations) ? update.migrations : [];
  const releases = Array.isArray(update.newerReleases) ? update.newerReleases : [];
  return {
    currentVersion: versionOf(update.currentVersion, PlatformReleaseVersionSchema),
    latestVersion: versionOf(update.latestVersion, PlatformReleaseVersionSchema),
    available: update.available === true,
    breaking: update.breaking === true,
    migrationsPending: migrations
      .map((migration) => versionOf(migration, MigrationRefSchema))
      .filter((migration): migration is string => migration !== null)
      .slice(0, PLATFORM_STATE_MIGRATIONS_LIMIT),
    migrationCount: migrations.length,
    migrationsIncomplete: update.migrationsIncomplete === true,
    newerReleases: releases
      .map(projectRelease)
      .filter((release): release is PlatformStateReleaseWire => release !== null)
      .slice(0, PLATFORM_STATE_RELEASES_LIMIT),
    rollbackVersion: versionOf(update.rollbackVersion, PlatformReleaseVersionSchema),
  };
}

function projectPiUpdate(pi: PlatformUpdatesWire['piUpdate']): PlatformStatePiUpdateWire {
  return {
    state: member(PiUpdateStateWireSchema, pi.state) ?? 'unknown',
    bundledVersion: versionOf(pi.bundledVersion, ComponentVersionSchema),
    activeImageVersion: versionOf(pi.activeImageVersion, ComponentVersionSchema),
    upstreamLatest: versionOf(pi.upstreamLatest, PiReleaseVersionSchema),
    sdkSuite: member(PiSdkSuiteResultSchema, pi.sdkSuite),
    bundledIn: versionOf(pi.bundledIn, PlatformReleaseVersionSchema),
    checkedAt: normalizedTimestamp(pi.checkedAt),
  };
}

function projectFeed(feed: PlatformUpdatesWire['feedFreshness']): PlatformStateUpdateFeedWire {
  return {
    status: member(PlatformUpdateFeedStatusWireSchema, feed.status) ?? 'invalid',
    staleCause: member(PlatformUpdateFeedStaleCauseWireSchema, feed.staleCause),
    fetchedAt: normalizedTimestamp(feed.fetchedAt),
    generatedAt: normalizedTimestamp(feed.generatedAt),
    maxAgeHours: count(feed.maxAgeHours),
  };
}

/** `platform_state_updates`' result from `platform_updates`'. */
export function projectUpdatesState(
  updates: PlatformUpdatesWire,
  checkedAt: string,
): PlatformStateUpdatesWire {
  return {
    platform: updates.platformUpdate ? projectPlatformUpdate(updates.platformUpdate) : null,
    pi: projectPiUpdate(updates.piUpdate),
    feed: projectFeed(updates.feedFreshness),
    checkedAt,
  };
}

// -------------------------------------------------------------------------------------------
// invariants
// -------------------------------------------------------------------------------------------

const KNOWN_INVARIANTS: ReadonlySet<string> = new Set(INVARIANT_CHECK_IDS);

/** `platform_state_invariants`' result from the kernel's latest invariant check (`undefined`: no
 *  store is wired, as in a process that runs no checks). `status` counts every result's
 *  violations; `checks` lists the known invariants' counts — never a sample. */
export function projectInvariantsState(
  snapshot: InvariantMetricsSnapshot | undefined,
  checkedAt: string,
): PlatformStateInvariantsWire {
  const ranAt = snapshot?.lastRunAt;
  if (!snapshot || !(ranAt instanceof Date) || Number.isNaN(ranAt.getTime())) {
    return { status: 'not_run', lastRunAt: null, checks: [], checkedAt };
  }
  const results = Array.isArray(snapshot.results) ? snapshot.results : [];
  const checks: PlatformStateInvariantsWire['checks'] = [];
  for (const result of results) {
    const invariant = shaped(result.invariant, PLATFORM_STATE_INVARIANT_ID_PATTERN);
    if (invariant === null || !KNOWN_INVARIANTS.has(invariant)) continue;
    if (checks.length >= PLATFORM_STATE_INVARIANTS_LIMIT) break;
    checks.push({ invariant, violations: count(result.violations) });
  }
  return {
    status: results.some((result) => count(result.violations) > 0) ? 'violations' : 'clean',
    lastRunAt: ranAt.toISOString(),
    checks,
    checkedAt,
  };
}
