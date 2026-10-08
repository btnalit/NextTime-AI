import { z } from 'zod';

/**
 * release-channel: the ReleaseChannel record (S10 U1, docs/s10-evolution-plan-2026-10-04.md §4.2).
 * One small JSON document — `channel.json` — that answers "is there anything newer than what this
 * host runs": every platform release (its bundled pi, the migrations it adds, whether it is
 * breaking) and the latest upstream pi together with the nightly drift check's verdict on it.
 *
 * Producer and consumer share this one schema:
 * - `scripts/release-channel.mjs` (CI: `release-channel.yml`, called by the release workflow after
 *   the images are published and by `pi-drift.yml` after every nightly check) builds the document
 *   and validates it here before uploading it to the rolling `channel` pre-release;
 * - the host's `update-feed` service only downloads the file (it never parses it);
 * - the kernel's `platform_updates` (application/platform/updates.ts) validates it again on every
 *   read — the file crossed the network, so the kernel trusts nothing about it beyond this schema
 *   and `RELEASE_CHANNEL_MAX_BYTES`.
 *
 * W1 does not sign the record: it only drives a reminder, never an action (the real upgrade,
 * `scripts/apply-release.sh --pull`, still verifies every image's signature). The defence is HTTPS
 * from GitHub plus this strict, bounded schema — every string has a pattern or a length cap, and
 * the only URLs it can carry are GitHub release or Actions run pages (of any repository: the
 * schema alone cannot know which one). The kernel then keeps only the links into the repository
 * its `UPDATE_FEED_URL` names (`platform_updates`), so a forged record can mislead a reminder but
 * cannot inject markup or link anywhere else.
 */

/** Upper bound on the file the kernel will read. The real record is a few KiB. */
export const RELEASE_CHANNEL_MAX_BYTES = 64 * 1024;

/** Release-please tags: plain `vX.Y.Z` (release-please-config.json, no component prefix). */
const PLATFORM_VERSION = /^v(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
/** npm versions of the pi packages; an optional pre-release suffix is accepted but compares lower. */
const PI_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,32}))?$/;

export const PlatformReleaseVersionSchema = z.string().regex(PLATFORM_VERSION);
export const PiReleaseVersionSchema = z.string().regex(PI_VERSION);

/** `core 0041` — the migration's directory under packages/kernel/migrations and its number, the
 *  same form STATUS and the release notes use. */
export const MigrationRefSchema = z.string().regex(/^[a-z][a-z-]{0,31} \d{4}$/);

/** A release page or an Actions run of a GitHub repository — nothing else may be linked. */
export const ReleaseChannelUrlSchema = z
  .string()
  .max(300)
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(?:releases\/tag\/v\d{1,4}\.\d{1,4}\.\d{1,6}|actions\/runs\/\d{1,20})$/,
  );

const IsoUtcSchema = z.string().datetime();

export const ReleaseChannelReleaseSchema = z
  .object({
    version: PlatformReleaseVersionSchema,
    /** The release tag just before this one — what `migrations` is counted from; null for the
     *  repository's first release. Optional: records written before the field existed lack it,
     *  and a reader must still accept them (it then cannot place the window's start exactly). */
    previousVersion: PlatformReleaseVersionSchema.nullable().optional(),
    publishedAt: IsoUtcSchema,
    /** The pi this release's images carry (`pi.version` at the tag); null for a tag that has none. */
    pi: PiReleaseVersionSchema.nullable(),
    /** Migrations this release adds over `previousVersion`, in apply order. */
    migrations: z.array(MigrationRefSchema).max(200),
    /** release-please marked the release `⚠ BREAKING CHANGES`. */
    breaking: z.boolean(),
    notesUrl: ReleaseChannelUrlSchema,
  })
  .strict();
export type ReleaseChannelRelease = z.infer<typeof ReleaseChannelReleaseSchema>;

export const PiSdkSuiteResultSchema = z.enum(['pass', 'fail']);
export type PiSdkSuiteResult = z.infer<typeof PiSdkSuiteResultSchema>;

export const ReleaseChannelPiUpstreamSchema = z
  .object({
    /** npm `latest` of `@earendil-works/pi-coding-agent` when the drift check last ran. */
    latest: PiReleaseVersionSchema,
    checkedAt: IsoUtcSchema,
    /** The drift check's platform-extension typecheck + pi-SDK suite against `latest`. A pass is a
     *  first compatibility check only: docs/runbooks/pi-upgrade.md §2 still has manual rows. */
    sdkSuite: PiSdkSuiteResultSchema,
    /** One line from the drift check when `sdkSuite` is `fail`. */
    failureSummary: z.string().max(500).nullable(),
    /** The oldest platform release that bundles `latest`, if any. */
    bundledIn: PlatformReleaseVersionSchema.nullable(),
    runUrl: ReleaseChannelUrlSchema.nullable(),
  })
  .strict();
export type ReleaseChannelPiUpstream = z.infer<typeof ReleaseChannelPiUpstreamSchema>;

export const ReleaseChannelSchema = z
  .object({
    schema: z.literal(1),
    generatedAt: IsoUtcSchema,
    platform: z
      .object({
        latest: PlatformReleaseVersionSchema.nullable(),
        /** Newest first. */
        releases: z.array(ReleaseChannelReleaseSchema).max(50),
      })
      .strict(),
    /** null until the first drift check has run since the channel existed. */
    piUpstream: ReleaseChannelPiUpstreamSchema.nullable(),
  })
  .strict();
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>;

type VersionParts = readonly [number, number, number, string | null];

function partsOf(pattern: RegExp, version: string): VersionParts | null {
  const match = pattern.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
}

function compareParts(a: VersionParts, b: VersionParts): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return Math.sign(diff);
  }
  // A pre-release sorts below its release; two pre-releases compare as strings.
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  return a[3] < b[3] ? -1 : 1;
}

/**
 * The platform release a kernel build reports, from `KERNEL_VERSION`. Published images carry
 * `vX.Y.Z (sha)` (publish-images.yml); a source build carries whatever the build shell exported,
 * and an unset one is `dev`. Anything that does not start with a release tag is null: the kernel
 * then cannot tell whether a release is newer, and says so instead of guessing.
 */
export function platformVersionFromKernelVersion(kernelVersion: string): string | null {
  const head = kernelVersion.trim().split(/\s+/)[0] ?? '';
  return PLATFORM_VERSION.test(head) ? head : null;
}

/** -1 / 0 / 1; null when either side is not a `vX.Y.Z` release tag. */
export function comparePlatformVersions(a: string, b: string): number | null {
  const pa = partsOf(PLATFORM_VERSION, a);
  const pb = partsOf(PLATFORM_VERSION, b);
  return pa && pb ? compareParts(pa, pb) : null;
}

/** -1 / 0 / 1; null when either side is not an npm-style `X.Y.Z[-pre]` version. */
export function comparePiVersions(a: string, b: string): number | null {
  const pa = partsOf(PI_VERSION, a);
  const pb = partsOf(PI_VERSION, b);
  return pa && pb ? compareParts(pa, pb) : null;
}
