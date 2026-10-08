import { open } from 'node:fs/promises';
import {
  type PiUpdateWire,
  type PlatformUpdateFeedWire,
  type PlatformUpdateWire,
  type PlatformUpdatesWire,
  RELEASE_CHANNEL_MAX_BYTES,
  type ReleaseChannel,
  ReleaseChannelReaderSchema,
  type ReleaseChannelRelease,
  comparePiVersions,
  comparePlatformVersions,
  platformVersionFromKernelVersion,
} from '@nexttime/shared';
import type { CapabilityHandler } from '../gateway/capability-handler.js';
import { readPiVersions } from './runtime.js';

/**
 * application/platform/updates: `platform_updates` (S10 U1, docs/s10-evolution-plan-2026-10-04.md
 * §4.2; STATUS leftover 125). The kernel never goes online (design decision E3): CI publishes the
 * ReleaseChannel record (`channel.json`, `@nexttime/shared` release-channel.ts) to the rolling
 * `channel` pre-release, the host's `update-feed` compose service downloads that one file into
 * `${NEXTTIME_DATA}/config/update-feed/` without parsing it, and the kernel reads it through its
 * existing read-only `config/` mount at `/data/config/update-feed/channel.json`.
 *
 * The file crossed the network, so every read re-validates it: at most
 * `RELEASE_CHANNEL_MAX_BYTES`, then `ReleaseChannelReaderSchema` (every known field strictly typed,
 * bounded strings, GitHub-only links; unknown keys a newer CI added are stripped and never used).
 * An oversized or malformed file is `invalid` and nothing from it is used — never a partially
 * trusted record, never a failed call.
 *
 * Freshness has two halves, because either end can silently stop: the file's modification time is
 * the last successful download (`update-feed` writes a temp file and renames it only on success,
 * so a failed download leaves the old file and its old mtime), and the record's own `generatedAt`
 * is the last CI run that wrote it (the nightly drift check does — a disabled scheduled workflow
 * would otherwise go unnoticed). A stale record is still used; the console says how old it is.
 */

export const DEFAULT_UPDATE_FEED_FILE = '/data/config/update-feed/channel.json';

/** Two missed daily downloads (plan §4.2: "版本信息已 2 天未更新"). */
export const UPDATE_FEED_MAX_AGE_HOURS = 48;

/** CI rewrites the record every night (pi-drift.yml); three nights of silence means it stopped. */
export const UPDATE_FEED_GENERATED_MAX_AGE_HOURS = 72;

export function resolveUpdateFeedFile(env: NodeJS.ProcessEnv): string {
  const configured = env.UPDATE_FEED_FILE;
  return configured && configured.length > 0 ? configured : DEFAULT_UPDATE_FEED_FILE;
}

/** The update-feed service's default source — the compose file's `UPDATE_FEED_URL` default. */
export const DEFAULT_UPDATE_FEED_URL =
  'https://github.com/btnalit/nexttime-ai/releases/download/channel/channel.json';

/**
 * The repository the record must come from: `owner/repo` (lower-cased — GitHub names are
 * case-insensitive) of `UPDATE_FEED_URL`, which compose hands both the update-feed service and the
 * kernel. Every link in the record must point into it; a record linking anywhere else is rejected
 * whole. null when the URL is not a GitHub release download, which rejects every record.
 */
export function resolveUpdateFeedRepo(env: NodeJS.ProcessEnv): string | null {
  const url =
    env.UPDATE_FEED_URL && env.UPDATE_FEED_URL.length > 0
      ? env.UPDATE_FEED_URL
      : DEFAULT_UPDATE_FEED_URL;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/releases\/download\//.exec(
      url,
    );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function linksOf(channel: ReleaseChannel): string[] {
  const links = channel.platform.releases.map((release) => release.notesUrl);
  if (channel.piUpstream?.runUrl) links.push(channel.piUpstream.runUrl);
  return links;
}

export interface ReleaseChannelRead {
  readonly feed: PlatformUpdateFeedWire;
  /** null unless the file exists, fits the size cap and matches the schema. */
  readonly channel: ReleaseChannel | null;
}

function feedOf(
  status: PlatformUpdateFeedWire['status'],
  detail: string,
  fetchedAt: string | null = null,
  generatedAt: string | null = null,
  staleCause: PlatformUpdateFeedWire['staleCause'] = null,
): PlatformUpdateFeedWire {
  return {
    status,
    staleCause,
    fetchedAt,
    generatedAt,
    maxAgeHours: UPDATE_FEED_MAX_AGE_HOURS,
    detail,
  };
}

function ageText(ms: number): string {
  if (ms < 0) return 'in the future';
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}h${minutes % 60}m old`;
}

/** Pure half: an already-read file (its bytes and modification time) → feed status + record. */
export function releaseChannelFromFile(
  file: string,
  text: string,
  modifiedAt: Date,
  now: Date,
  repo: string | null,
): ReleaseChannelRead {
  const fetchedAt = modifiedAt.toISOString();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      feed: feedOf(
        'invalid',
        `update feed ${file} is not JSON — the record was rejected`,
        fetchedAt,
      ),
      channel: null,
    };
  }
  const parsed = ReleaseChannelReaderSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'schema';
    return {
      feed: feedOf(
        'invalid',
        `update feed ${file} does not match the ReleaseChannel schema (${where.slice(0, 160)}) — the record was rejected`,
        fetchedAt,
      ),
      channel: null,
    };
  }
  const channel = parsed.data;
  const prefix = repo === null ? null : `https://github.com/${repo}/`;
  const foreign = linksOf(channel).find(
    (link) => prefix === null || !link.toLowerCase().startsWith(prefix),
  );
  if (foreign !== undefined) {
    return {
      feed: feedOf(
        'invalid',
        prefix === null
          ? 'UPDATE_FEED_URL is not a GitHub release-download URL, so no record can be trusted — the record was rejected'
          : `update feed ${file} links outside ${repo} (${foreign.slice(0, 120)}) — the record was rejected`,
        fetchedAt,
      ),
      channel: null,
    };
  }
  const fetchAge = now.getTime() - modifiedAt.getTime();
  const generatedAge = now.getTime() - Date.parse(channel.generatedAt);
  const fetchStale = fetchAge > UPDATE_FEED_MAX_AGE_HOURS * 3_600_000;
  const generatedStale = generatedAge > UPDATE_FEED_GENERATED_MAX_AGE_HOURS * 3_600_000;
  let detail: string;
  // The download is checked first: a record that is not being fetched cannot say anything about
  // CI. The console words the reminder by this cause and never re-derives it from its own clock.
  const staleCause = fetchStale ? 'download' : generatedStale ? 'ci' : null;
  if (fetchStale) {
    detail = `last successful download ${fetchedAt} is ${ageText(fetchAge)} (> ${UPDATE_FEED_MAX_AGE_HOURS}h) — check the update-feed service's logs on the host`;
  } else if (generatedStale) {
    detail = `downloaded ${ageText(fetchAge)}, but CI last wrote the record ${channel.generatedAt} (${ageText(generatedAge)}, > ${UPDATE_FEED_GENERATED_MAX_AGE_HOURS}h) — check the repository's pi drift / release channel workflows`;
  } else {
    detail = `downloaded ${fetchedAt} (${ageText(fetchAge)}, limit ${UPDATE_FEED_MAX_AGE_HOURS}h); CI wrote it ${channel.generatedAt}`;
  }
  return {
    feed: feedOf(
      staleCause === null ? 'fresh' : 'stale',
      detail,
      fetchedAt,
      channel.generatedAt,
      staleCause,
    ),
    channel,
  };
}

function readErrorDetail(file: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return `no update feed at ${file} yet — the update-feed service has not downloaded the release channel record (compose service update-feed, docs/runbooks/operations.md §16)`;
    case 'EACCES':
    case 'EPERM':
      return `update feed ${file} is not readable by the kernel (uid 10001) — re-run scripts/host-env-init.sh`;
    case 'EISDIR':
      return `update feed path ${file} is a directory`;
    default:
      return `update feed ${file} could not be read (${code ?? 'error'})`;
  }
}

/** Reads the downloaded record. Never throws.
 *
 *  One file handle for both the stat and the read, so the size and mtime checked are the
 *  file's that is read (update-feed replaces it by rename at any time), and the read itself is
 *  bounded: at most one byte past the cap is ever buffered. */
export async function readReleaseChannel(
  file: string,
  now: Date,
  repo: string | null,
): Promise<ReleaseChannelRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (info.isDirectory())
      return { feed: feedOf('missing', readErrorDetail(file, { code: 'EISDIR' })), channel: null };
    const tooLarge = (size: number): ReleaseChannelRead => ({
      feed: feedOf(
        'invalid',
        `update feed ${file} is ${size} bytes (> ${RELEASE_CHANNEL_MAX_BYTES}) — the record was rejected`,
        info.mtime.toISOString(),
      ),
      channel: null,
    });
    if (info.size > RELEASE_CHANNEL_MAX_BYTES) return tooLarge(info.size);
    const buffer = Buffer.alloc(RELEASE_CHANNEL_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > RELEASE_CHANNEL_MAX_BYTES) return tooLarge(length);
    return releaseChannelFromFile(file, buffer.toString('utf8', 0, length), info.mtime, now, repo);
  } catch (err) {
    return { feed: feedOf('missing', readErrorDetail(file, err)), channel: null };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface PlatformUpdatesInput {
  readonly read: ReleaseChannelRead;
  /** `KERNEL_VERSION` as the build set it (`vX.Y.Z (sha)`, or `dev`). */
  readonly kernelVersion: string;
  readonly pinnedPiVersion: string | null;
  readonly activeImagePiVersion: string | null;
  readonly now: Date;
}

function derivePlatformUpdate(
  channel: ReleaseChannel,
  currentVersion: string | null,
): PlatformUpdateWire {
  const newer =
    currentVersion === null
      ? []
      : channel.platform.releases
          .filter((release) => (comparePlatformVersions(release.version, currentVersion) ?? 0) > 0)
          .sort((a, b) => comparePlatformVersions(b.version, a.version) ?? 0);
  const newest = newer[0];
  // The window starts from the oldest listed release's predecessor: its migrations are counted
  // from there, so a host on exactly that release still gets the full list. A null predecessor
  // means the record reaches back to the repository's first release. A record from before
  // `previousVersion` existed lacks it: fall back to the oldest listed release itself, which errs
  // towards "partial" by one release rather than hiding a gap.
  const oldestListed = channel.platform.releases.reduce<ReleaseChannelRelease | null>(
    (oldest, release) =>
      oldest === null || (comparePlatformVersions(release.version, oldest.version) ?? 0) < 0
        ? release
        : oldest,
    null,
  );
  const windowBase =
    oldestListed === null
      ? null
      : oldestListed.previousVersion === undefined
        ? oldestListed.version
        : oldestListed.previousVersion;
  return {
    currentVersion,
    latestVersion: channel.platform.latest,
    available: newest !== undefined,
    newerReleases: newer,
    // Apply order: oldest newer release first.
    migrations: [...newer].reverse().flatMap((release) => release.migrations),
    migrationsIncomplete:
      newest !== undefined &&
      currentVersion !== null &&
      windowBase !== null &&
      (comparePlatformVersions(currentVersion, windowBase) ?? 0) < 0,
    breaking: newer.some((release) => release.breaking),
    notesUrl: newest?.notesUrl ?? null,
    applyCommand: newest ? `sh scripts/apply-release.sh --pull ${newest.version}` : null,
    rollbackVersion: currentVersion,
  };
}

function derivePiState(
  channel: ReleaseChannel | null,
  pinnedPiVersion: string | null,
  currentVersion: string | null,
): PiUpdateWire['state'] {
  const upstream = channel?.piUpstream;
  if (!upstream || pinnedPiVersion === null) return 'unknown';
  const cmp = comparePiVersions(upstream.latest, pinnedPiVersion);
  if (cmp === null) return 'unknown';
  if (cmp <= 0) return 'up_to_date';
  // A platform release newer than this one bundles it: the reminder is that release.
  if (
    upstream.bundledIn !== null &&
    (currentVersion === null ||
      (comparePlatformVersions(upstream.bundledIn, currentVersion) ?? 0) > 0)
  ) {
    return 'released';
  }
  return upstream.sdkSuite === 'fail' ? 'incompatible' : 'pending_release';
}

/** Pure half of `platform_updates`. */
export function derivePlatformUpdates(input: PlatformUpdatesInput): PlatformUpdatesWire {
  const { channel, feed } = input.read;
  const currentVersion = platformVersionFromKernelVersion(input.kernelVersion);
  const upstream = channel?.piUpstream ?? null;
  return {
    platformUpdate: channel ? derivePlatformUpdate(channel, currentVersion) : null,
    piUpdate: {
      state: derivePiState(channel, input.pinnedPiVersion, currentVersion),
      bundledVersion: input.pinnedPiVersion,
      activeImageVersion: input.activeImagePiVersion,
      upstreamLatest: upstream?.latest ?? null,
      sdkSuite: upstream?.sdkSuite ?? null,
      failureSummary: upstream?.failureSummary ?? null,
      bundledIn: upstream?.bundledIn ?? null,
      checkedAt: upstream?.checkedAt ?? null,
      runUrl: upstream?.runUrl ?? null,
    },
    feedFreshness: feed,
    checkedAt: input.now.toISOString(),
  };
}

export const platformUpdatesHandler: CapabilityHandler = async (client) => {
  const now = new Date();
  const read = await readReleaseChannel(
    resolveUpdateFeedFile(process.env),
    now,
    resolveUpdateFeedRepo(process.env),
  );
  const { pinnedPiVersion, activeImagePiVersion } = await readPiVersions(client);
  const result = derivePlatformUpdates({
    read,
    kernelVersion: process.env.KERNEL_VERSION ?? 'dev',
    pinnedPiVersion,
    activeImagePiVersion,
    now,
  });
  return { result };
};
