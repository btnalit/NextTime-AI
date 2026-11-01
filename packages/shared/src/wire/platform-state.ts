import { z } from 'zod';
import {
  MigrationRefSchema,
  PiReleaseVersionSchema,
  PiSdkSuiteResultSchema,
  PlatformReleaseVersionSchema,
} from '../release-channel.js';
import {
  CONNECTOR_NAME_PATTERN,
  ConnectorModeWireSchema,
  GateHealthWireSchema,
  GateInstanceStatusWireSchema,
  GateTransportKindWireSchema,
  GateTrustWireSchema,
  PiUpdateStateWireSchema,
  PlatformUpdateFeedStaleCauseWireSchema,
  PlatformUpdateFeedStatusWireSchema,
} from './platform.js';

/**
 * wire/platform-state (S11 AA2; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §5.2,
 * §5.7): what an admin agent reads of the platform — the `platform_state_*` capabilities
 * (`adminAgentOnly`, group `platform_state`). Each is a projection of what a platform administrator
 * can read — the console's platform pages, or for invariants the kernel's metrics — built field by
 * field for an agent: no address of any system
 * (no URL, host, port, path or endpoint), no command, no credential or credential-shaped value, no
 * free text an administrator or a system wrote, no other workspace's id or name (counts instead),
 * no other person's login.
 *
 * Every string in these shapes carries a shape — an enum, a pattern, or an ISO timestamp — and the
 * kernel drops a value that does not fit it rather than pass it through; `capabilities.test.ts`
 * fails when a string field without one is added here. A field named like an address, a command or
 * a secret (`target`, `endpoint`, `url`, `detail`, `payload`, `login`, …) fails it too unless it is
 * an enum, a number or a boolean.
 */

/** A gate instance's id (`gate_instances.gate_id`, core 0023's check). */
export const PLATFORM_STATE_GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** An Operation name an agent is shown: letters, digits, `_`, `.` and `-` only — no `/`, `:` or
 *  space, so nothing shaped like an address or a command passes. Operation names are the gate's
 *  own (`OPERATION_NAME_MAX` long); one outside this shape is counted, never shown. */
export const PLATFORM_STATE_OPERATION_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** An audit action: a capability name or a dotted platform event (`workspace.created`). */
export const PLATFORM_STATE_AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_.]{0,79}$/;

/** An audit row's resource type (`user`, `workspace`, `gate_instance`). */
export const PLATFORM_STATE_RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The most gate instances `platform_state_gates` lists (`truncated` says when there are more). */
export const PLATFORM_STATE_GATES_LIMIT = 200;

/** The most disabled Operation names `platform_state_connectors` lists per connector. */
export const PLATFORM_STATE_DISABLED_OPERATIONS_LIMIT = 500;

/** How far back `platform_state_audit` looks, and the most rows it looks through. */
export const PLATFORM_STATE_AUDIT_WINDOW_HOURS = 168;
export const PLATFORM_STATE_AUDIT_SCAN_ROWS = 1000;

/** The most recent platform writes `platform_state_audit` lists. */
export const PLATFORM_STATE_AUDIT_RECENT_LIMIT = 20;

const IsoTimestampSchema = z.string().datetime();
const CountSchema = z.number().int().nonnegative();

/** A pending manifest, as counts: what the administrator is asked to confirm, without the
 *  Operations' definitions (`PendingGateManifestWire` carries those for the console). */
export const PlatformStatePendingManifestWireSchema = z
  .object({
    announcedAt: IsoTimestampSchema,
    operationCount: CountSchema,
    addedCount: CountSchema,
    removedCount: CountSchema,
    changedCount: CountSchema,
    /** Operations the gate refuses until the announcement is adopted (`refusedOperations`). */
    refusedOperationCount: CountSchema,
  })
  .strict();
export type PlatformStatePendingManifestWire = z.infer<
  typeof PlatformStatePendingManifestWireSchema
>;

/** One gate instance (`GateInstanceWire` without its addresses, display name, enabling workspaces,
 *  Operations or definition beyond its preset and credential mode). */
export const PlatformStateGateWireSchema = z
  .object({
    gateId: z.string().regex(PLATFORM_STATE_GATE_ID_PATTERN),
    /** The connector it belongs to; `null` if its name is outside the connector-name shape. */
    connector: z.string().regex(CONNECTOR_NAME_PATTERN).nullable(),
    transportKind: GateTransportKindWireSchema,
    /** Served by the generic gate host (created by an administrator), not a packaged gate. */
    hosted: z.boolean(),
    /** The connector preset a hosted instance was made from; `null` otherwise. */
    preset: z.string().regex(CONNECTOR_NAME_PATTERN).nullable(),
    /** A hosted instance's credential mode; `null` for a packaged gate. Which kind of credential,
     *  never the credential. */
    credentialMode: z.enum(['shared', 'connected_account']).nullable(),
    status: GateInstanceStatusWireSchema,
    trust: GateTrustWireSchema,
    health: GateHealthWireSchema,
    lastSeenAt: IsoTimestampSchema.nullable(),
    lastCheckedAt: IsoTimestampSchema.nullable(),
    operationCount: CountSchema,
    /** How many workspaces enabled it — never which. */
    enabledWorkspaceCount: CountSchema,
    pendingManifest: PlatformStatePendingManifestWireSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateGateWire = z.infer<typeof PlatformStateGateWireSchema>;

export const PlatformStateGatesWireSchema = z
  .object({
    instances: z.array(PlatformStateGateWireSchema).max(PLATFORM_STATE_GATES_LIMIT),
    /** Every gate instance, including any past the list's limit. */
    total: CountSchema,
    truncated: z.boolean(),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateGatesWire = z.infer<typeof PlatformStateGatesWireSchema>;

/** One connector (`ConnectorWire`, with its disabled Operations shape-checked). */
export const PlatformStateConnectorWireSchema = z
  .object({
    name: z.string().regex(CONNECTOR_NAME_PATTERN),
    kind: GateTransportKindWireSchema,
    packaged: z.boolean(),
    /** One of the four generic connectors (`GENERIC_CONNECTOR_NAMES`). */
    generic: z.boolean(),
    mode: ConnectorModeWireSchema,
    /** Every Operation refused for all its instances, however named. */
    disabledOperationCount: CountSchema,
    /** Those of them whose names fit `PLATFORM_STATE_OPERATION_NAME_PATTERN`, at most
     *  `PLATFORM_STATE_DISABLED_OPERATIONS_LIMIT`. */
    disabledOperations: z
      .array(z.string().regex(PLATFORM_STATE_OPERATION_NAME_PATTERN))
      .max(PLATFORM_STATE_DISABLED_OPERATIONS_LIMIT),
    operationCount: CountSchema,
    instanceCount: CountSchema,
    /** Gates workspaces connected themselves through it, across every workspace — counts only. */
    selfConnectionCount: CountSchema,
    suspendedSelfConnectionCount: CountSchema,
    updatedAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type PlatformStateConnectorWire = z.infer<typeof PlatformStateConnectorWireSchema>;

export const PlatformStateConnectorsWireSchema = z
  .object({
    connectors: z.array(PlatformStateConnectorWireSchema),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateConnectorsWire = z.infer<typeof PlatformStateConnectorsWireSchema>;

/** Who made a platform change, as the admin agent may know it: its own administrator, another one,
 *  or nobody recorded (an operator CLI run that named no administrator). Never a login. */
export const PlatformStateAuditActorWireSchema = z.enum([
  'self',
  'another_administrator',
  'unattributed',
]);
export type PlatformStateAuditActorWire = z.infer<typeof PlatformStateAuditActorWireSchema>;

export const PlatformStateAuditWriteWireSchema = z
  .object({
    action: z.string().regex(PLATFORM_STATE_AUDIT_ACTION_PATTERN),
    createdAt: IsoTimestampSchema,
    resourceType: z.string().regex(PLATFORM_STATE_RESOURCE_TYPE_PATTERN).nullable(),
    actor: PlatformStateAuditActorWireSchema,
  })
  .strict();
export type PlatformStateAuditWriteWire = z.infer<typeof PlatformStateAuditWriteWireSchema>;

/** The platform's recent changes: the writes among its newest audit rows, never a row's params,
 *  resource id or actor login. */
export const PlatformStateAuditWireSchema = z
  .object({
    windowHours: z.literal(PLATFORM_STATE_AUDIT_WINDOW_HOURS),
    /** Platform audit rows looked through: the newest within the window, at most
     *  `PLATFORM_STATE_AUDIT_SCAN_ROWS`. */
    scannedRows: CountSchema,
    /** The window holds more rows than were looked through. */
    truncated: z.boolean(),
    /** Writes per action among the rows looked through, most first. */
    writesByAction: z
      .array(
        z
          .object({
            action: z.string().regex(PLATFORM_STATE_AUDIT_ACTION_PATTERN),
            count: CountSchema,
          })
          .strict(),
      )
      .max(PLATFORM_STATE_AUDIT_SCAN_ROWS),
    /** Writes whose action is outside the action shape — counted, never shown. */
    unrecognizedWrites: CountSchema,
    /** The newest writes, newest first. */
    recent: z.array(PlatformStateAuditWriteWireSchema).max(PLATFORM_STATE_AUDIT_RECENT_LIMIT),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateAuditWire = z.infer<typeof PlatformStateAuditWireSchema>;

// -------------------------------------------------------------------------------------------
// runtime, updates, invariants (S11 AA2b): read from worker-supervisor, the update feed and the
// kernel's own invariant checks, not from the database's rows alone
// -------------------------------------------------------------------------------------------

/** A runtime image's identity: Docker's content id (`RuntimeImageWire.id`), never a tag — a tag
 *  can name a registry by host and port. */
export const PLATFORM_STATE_IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A component version an image label or a build file carries: a release version, or `dev` for a
 *  build that did not set one (`scripts/build-images.sh`). */
export const PLATFORM_STATE_COMPONENT_VERSION_PATTERN =
  /^(?:dev|\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?)$/;

/** The commit an image was built from (`ai.nexttime.built-from`): a git sha, or `dev`. */
export const PLATFORM_STATE_COMMIT_PATTERN = /^(?:dev|[0-9a-f]{7,40})$/;

/** An invariant check's id (`INVARIANT_CHECK_IDS`, substrate/audit/invariant-checks.ts): `I4`,
 *  `I-S5-1`, `I-G9`, `ops.outbox_stuck`. */
export const PLATFORM_STATE_INVARIANT_ID_PATTERN = /^(?:I[0-9A-Z-]{1,15}|ops\.[a-z][a-z_]{0,39})$/;

/** The most runtime images `platform_state_runtime` lists (`imageCount` says how many there are). */
export const PLATFORM_STATE_IMAGES_LIMIT = 50;

/** The most newer releases, and pending migrations, `platform_state_updates` lists. */
export const PLATFORM_STATE_RELEASES_LIMIT = 50;
export const PLATFORM_STATE_MIGRATIONS_LIMIT = 500;

/** The most invariant checks `platform_state_invariants` lists. */
export const PLATFORM_STATE_INVARIANTS_LIMIT = 100;

const ComponentVersionSchema = z.string().regex(PLATFORM_STATE_COMPONENT_VERSION_PATTERN);

/** One runtime image (`RuntimeImageWire` without its tags, labels or activatable reference). */
export const PlatformStateRuntimeImageWireSchema = z
  .object({
    digest: z.string().regex(PLATFORM_STATE_IMAGE_DIGEST_PATTERN),
    createdAt: IsoTimestampSchema,
    piVersion: ComponentVersionSchema.nullable(),
    platformExtensionVersion: ComponentVersionSchema.nullable(),
    builtFrom: z.string().regex(PLATFORM_STATE_COMMIT_PATTERN).nullable(),
    /** Worker-supervisor's allowlist admits one of its tags (`RuntimeImageWire.allowed`). */
    allowed: z.boolean(),
    /** It carries the runtime contract worker-supervisor requires; `null` when that is unknown. */
    runtimeCompatible: z.boolean().nullable(),
    /** It is the active image (`set_active_runtime_image`, or worker-supervisor's default). */
    active: z.boolean(),
  })
  .strict();
export type PlatformStateRuntimeImageWire = z.infer<typeof PlatformStateRuntimeImageWireSchema>;

/** The image Tasks and entry agents start from now. `digest` and what follows are `null` when it
 *  could not be resolved to a listed image. */
export const PlatformStateActiveImageWireSchema = z
  .object({
    /** Where the choice comes from: the platform setting, worker-supervisor's own default, or
     *  `unknown` (no setting and worker-supervisor not reachable). */
    source: z.enum(['setting', 'env_default', 'unknown']),
    digest: z.string().regex(PLATFORM_STATE_IMAGE_DIGEST_PATTERN).nullable(),
    piVersion: ComponentVersionSchema.nullable(),
    platformExtensionVersion: ComponentVersionSchema.nullable(),
    builtFrom: z.string().regex(PLATFORM_STATE_COMMIT_PATTERN).nullable(),
    runtimeCompatible: z.boolean().nullable(),
  })
  .strict();
export type PlatformStateActiveImageWire = z.infer<typeof PlatformStateActiveImageWireSchema>;

/** The platform's own services, as `platform_status` probes them (gates are `platform_state_gates`). */
export const PlatformStateServiceWireSchema = z.enum([
  'kernel',
  'postgres',
  'llm-proxy',
  'worker-supervisor',
  'egress-proxy',
]);
export type PlatformStateServiceWire = z.infer<typeof PlatformStateServiceWireSchema>;

export const PlatformStateRuntimeWireSchema = z
  .object({
    activeImage: PlatformStateActiveImageWireSchema,
    /** Newest first, at most `PLATFORM_STATE_IMAGES_LIMIT`; empty when worker-supervisor could
     *  not be reached (its service status says so). */
    images: z.array(PlatformStateRuntimeImageWireSchema).max(PLATFORM_STATE_IMAGES_LIMIT),
    /** Every image worker-supervisor listed, including any past the limit. */
    imageCount: CountSchema,
    /** Resident entry containers, as counts — never whose, or which workspace's. */
    entryContainers: z
      .object({
        total: CountSchema,
        running: CountSchema,
        /** Running from an image other than the active one (`ResidentContainerWire.needsRebuild`). */
        needsRebuild: CountSchema,
      })
      .strict(),
    services: z
      .array(
        z
          .object({
            service: PlatformStateServiceWireSchema,
            status: z.enum(['ok', 'degraded', 'down', 'unknown']),
          })
          .strict(),
      )
      .max(PlatformStateServiceWireSchema.options.length),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateRuntimeWire = z.infer<typeof PlatformStateRuntimeWireSchema>;

/** A release newer than the running one (`ReleaseChannelRelease` without its notes link). */
export const PlatformStateReleaseWireSchema = z
  .object({
    version: PlatformReleaseVersionSchema,
    publishedAt: IsoTimestampSchema,
    breaking: z.boolean(),
    /** The pi its images carry. */
    pi: PiReleaseVersionSchema.nullable(),
    migrationCount: CountSchema,
  })
  .strict();
export type PlatformStateReleaseWire = z.infer<typeof PlatformStateReleaseWireSchema>;

/** `PlatformUpdateWire` without its links and host commands: what a newer release brings, never
 *  how to apply it — a person applies a release on the host (release.md §3). */
export const PlatformStatePlatformUpdateWireSchema = z
  .object({
    currentVersion: PlatformReleaseVersionSchema.nullable(),
    latestVersion: PlatformReleaseVersionSchema.nullable(),
    available: z.boolean(),
    breaking: z.boolean(),
    /** The migrations applying the newest release runs, in apply order (at most
     *  `PLATFORM_STATE_MIGRATIONS_LIMIT`; `migrationCount` is all of them). */
    migrationsPending: z.array(MigrationRefSchema).max(PLATFORM_STATE_MIGRATIONS_LIMIT),
    migrationCount: CountSchema,
    /** The record reaches back less far than this version, so the migrations listed are partial. */
    migrationsIncomplete: z.boolean(),
    /** Newest first, at most `PLATFORM_STATE_RELEASES_LIMIT`. */
    newerReleases: z.array(PlatformStateReleaseWireSchema).max(PLATFORM_STATE_RELEASES_LIMIT),
    rollbackVersion: PlatformReleaseVersionSchema.nullable(),
  })
  .strict();
export type PlatformStatePlatformUpdateWire = z.infer<typeof PlatformStatePlatformUpdateWireSchema>;

/** `PiUpdateWire` without the drift check's failure text and run link. */
export const PlatformStatePiUpdateWireSchema = z
  .object({
    state: PiUpdateStateWireSchema,
    bundledVersion: ComponentVersionSchema.nullable(),
    activeImageVersion: ComponentVersionSchema.nullable(),
    upstreamLatest: PiReleaseVersionSchema.nullable(),
    sdkSuite: PiSdkSuiteResultSchema.nullable(),
    bundledIn: PlatformReleaseVersionSchema.nullable(),
    checkedAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type PlatformStatePiUpdateWire = z.infer<typeof PlatformStatePiUpdateWireSchema>;

/** `PlatformUpdateFeedWire` without its operator text (it names the feed file and host steps). */
export const PlatformStateUpdateFeedWireSchema = z
  .object({
    status: PlatformUpdateFeedStatusWireSchema,
    staleCause: PlatformUpdateFeedStaleCauseWireSchema.nullable(),
    fetchedAt: IsoTimestampSchema.nullable(),
    generatedAt: IsoTimestampSchema.nullable(),
    /** How old a download may be before the record is `stale`. */
    maxAgeHours: CountSchema,
  })
  .strict();
export type PlatformStateUpdateFeedWire = z.infer<typeof PlatformStateUpdateFeedWireSchema>;

export const PlatformStateUpdatesWireSchema = z
  .object({
    /** `null` when the update record is missing or invalid (`feed.status`). */
    platform: PlatformStatePlatformUpdateWireSchema.nullable(),
    pi: PlatformStatePiUpdateWireSchema,
    feed: PlatformStateUpdateFeedWireSchema,
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateUpdatesWire = z.infer<typeof PlatformStateUpdatesWireSchema>;

/** The kernel's periodic invariant checks, as counts: never the violating rows (their samples can
 *  name other workspaces' resources). */
export const PlatformStateInvariantsWireSchema = z
  .object({
    /** `not_run` until the first check since the kernel started (or when checks are off). */
    status: z.enum(['not_run', 'clean', 'violations']),
    lastRunAt: IsoTimestampSchema.nullable(),
    checks: z
      .array(
        z
          .object({
            invariant: z.string().regex(PLATFORM_STATE_INVARIANT_ID_PATTERN),
            violations: CountSchema,
          })
          .strict(),
      )
      .max(PLATFORM_STATE_INVARIANTS_LIMIT),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateInvariantsWire = z.infer<typeof PlatformStateInvariantsWireSchema>;
