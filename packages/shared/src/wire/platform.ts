import { z } from 'zod';
import { RoleSchema } from '../enums.js';

/**
 * wire/platform: the platform-management plane's wire shapes (docs/platform-admin-design.md §5,
 * P-A1). Every capability that returns one of these is `scope: 'platform'` — callable only by a
 * console session whose user is `platform_role = 'admin'`, never by a workspace Principal or a
 * Handle (design doc §7.11 "`scope:'platform'`"). Mirrors `application/gateway/platform-handlers.ts`.
 */

export const PlatformRoleWireSchema = z.enum(['admin', 'user']);
export type PlatformRoleWire = z.infer<typeof PlatformRoleWireSchema>;

export const UserStatusWireSchema = z.enum(['active', 'disabled']);
export type UserStatusWire = z.infer<typeof UserStatusWireSchema>;

/** One membership as the users page shows it (the "workspace@role" chip). */
export const UserMembershipWireSchema = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    workspaceStatus: z.enum(['active', 'disabled']),
    principalId: z.string(),
    role: RoleSchema,
    /** `true` when the membership Principal is disabled (S3.11 `disable_principal`). */
    disabled: z.boolean(),
  })
  .strict();
export type UserMembershipWire = z.infer<typeof UserMembershipWireSchema>;

/**
 * A platform user as the directory lists it. `hasPassword: false` is the "待激活" state — a user
 * backfilled from a pre-S4.1 Principal (migration 0019) or created without a password; the
 * admin resets a temporary password or merges it into a real account.
 */
export const UserWireSchema = z
  .object({
    id: z.string(),
    login: z.string(),
    displayName: z.string(),
    platformRole: PlatformRoleWireSchema,
    status: UserStatusWireSchema,
    hasPassword: z.boolean(),
    mustChangePassword: z.boolean(),
    /** `null` = inherit the platform default (`PlatformSettings.defaultDailyCallLimit`). */
    dailyCallLimit: z.number().int().nonnegative().nullable(),
    /** `null` = inherit the platform default (`PlatformSettings.defaultMonthlyTokenBudget`). */
    monthlyTokenBudget: z.number().int().nonnegative().nullable(),
    /** Most recent console login (`user_sessions.created_at`), ISO string; `null` = never. */
    lastLoginAt: z.string().nullable(),
    createdAt: z.string(),
    memberships: z.array(UserMembershipWireSchema),
  })
  .strict();
export type UserWire = z.infer<typeof UserWireSchema>;

/** `create_user` / `reset_user_password`: the temporary password is returned exactly once and is
 *  never persisted or audited (`redactedParamKeys`). */
export const CreateUserResultWireSchema = z
  .object({
    user: UserWireSchema,
    temporaryPassword: z.string(),
  })
  .strict();
export type CreateUserResultWire = z.infer<typeof CreateUserResultWireSchema>;

export const ResetUserPasswordResultWireSchema = z
  .object({
    userId: z.string(),
    temporaryPassword: z.string(),
  })
  .strict();
export type ResetUserPasswordResultWire = z.infer<typeof ResetUserPasswordResultWireSchema>;

export const RemoveMembershipResultWireSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    removed: z.boolean(),
  })
  .strict();

/**
 * Platform settings (design §6.6 — the "soft policy" half; auth config, internal-plane tokens and
 * image allowlists stay in env on purpose). One row, versioned; `envAdmins` is read-only here —
 * it mirrors `NEXTTIME_PLATFORM_ADMINS` so the users page can explain why those accounts cannot be
 * disabled or demoted.
 */
export const PlatformSettingsWireSchema = z
  .object({
    siteName: z.string(),
    /** Markdown, shown in the console top bar; empty = none. */
    announcement: z.string(),
    /** Appended to every entry / Worker system prompt (P-A2 wires it in; stored from P-A1). */
    instanceInstructions: z.string(),
    /** The workspace every page-created user joins as `member` unless the admin picks another. */
    defaultWorkspaceId: z.string().nullable(),
    /** `<provider>/<id>` new workspaces / AgentProfiles take; `null` = pi's own default. */
    defaultEntryModel: z.string().nullable(),
    defaultDailyCallLimit: z.number().int().nonnegative().nullable(),
    defaultMonthlyTokenBudget: z.number().int().nonnegative().nullable(),
    defaultPlatformRole: PlatformRoleWireSchema,
    passwordMinLength: z.number().int().min(8).max(128),
    /** S7-E (P-C §6.5 决定 E1): the runtime image `task/spawn` and the entry `startTurn` command
     *  request — a tag or digest reference the supervisor's image allowlist must also cover.
     *  `null` = worker-supervisor's own `WORKER_IMAGE` env default applies (unchanged pre-S7-E
     *  behavior). Set only via `set_active_runtime_image` (validated against `list_runtime_images`)
     *  or `rollback_runtime_image` — never through the generic `update_platform_settings` patch. */
    activeRuntimeImage: z.string().nullable(),
    envAdmins: z.array(z.string()),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type PlatformSettingsWire = z.infer<typeof PlatformSettingsWireSchema>;

export const PlatformAuditRecordWireSchema = z
  .object({
    id: z.string(),
    action: z.string(),
    /** null for a platform row the operator CLI wrote with no resolvable administrator (遗留 54:
     *  `purge-workspace` / `purge-expired-workspaces` with neither `--actor` nor
     *  `NEXTTIME_PLATFORM_ADMINS` naming a real user) — `payload.attributedActor` is `false` on
     *  those rows. Every capability-dispatched platform row still always has one
     *  (`actingUser(context)`). */
    actorUserId: z.string().nullable(),
    actorLogin: z.string().nullable(),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .strict();
export type PlatformAuditRecordWire = z.infer<typeof PlatformAuditRecordWireSchema>;

export const ServiceHealthWireSchema = z
  .object({
    service: z.string(),
    status: z.enum(['ok', 'degraded', 'down', 'unknown']),
    detail: z.string().optional(),
  })
  .strict();
export type ServiceHealthWire = z.infer<typeof ServiceHealthWireSchema>;

/** The first-run checklist (design §4): each item is the state of one page, read live, never a
 *  wizard step. `key` is stable for the web to map onto a page link. */
export const ChecklistItemWireSchema = z
  .object({
    key: z.enum(['providers', 'defaultWorkspace', 'integrations', 'users', 'runtime']),
    done: z.boolean(),
    detail: z.string(),
  })
  .strict();

export const PlatformOverviewWireSchema = z
  .object({
    version: z
      .object({
        kernel: z.string(),
        migrationsApplied: z.number().int().nonnegative(),
        latestMigration: z.string().nullable(),
      })
      .strict(),
    counts: z
      .object({
        users: z.number().int().nonnegative(),
        activeUsers: z.number().int().nonnegative(),
        pendingActivationUsers: z.number().int().nonnegative(),
        workspaces: z.number().int().nonnegative(),
        activeWorkspaces: z.number().int().nonnegative(),
        gatekeepers: z.number().int().nonnegative(),
        modelsAvailable: z.number().int().nonnegative(),
      })
      .strict(),
    health: z.array(ServiceHealthWireSchema),
    checklist: z.array(ChecklistItemWireSchema),
    recentAudit: z.array(PlatformAuditRecordWireSchema),
  })
  .strict();
export type PlatformOverviewWire = z.infer<typeof PlatformOverviewWireSchema>;

// -------------------------------------------------------------------------------------------
// P-A2 (docs/platform-admin-design.md §2 "工作区配置归管理面", §5 "工作区配置" row): the platform
// view of a workspace — the one shape `list_workspaces` / `create_workspace` / `update_workspace`
// / `set_workspace_status` / `set_allowed_models` all return.
// -------------------------------------------------------------------------------------------

export const WorkspaceStatusWireSchema = z.enum(['active', 'disabled']);
export type WorkspaceStatusWire = z.infer<typeof WorkspaceStatusWireSchema>;

/** One `owner` membership of a workspace as the workspace-configuration page shows it. */
export const WorkspaceOwnerWireSchema = z
  .object({
    userId: z.string(),
    login: z.string(),
    displayName: z.string(),
    principalId: z.string(),
  })
  .strict();
export type WorkspaceOwnerWire = z.infer<typeof WorkspaceOwnerWireSchema>;

/**
 * A workspace as the platform plane sees it (`get_workspace`'s `WorkspaceWire` is the member's
 * view of the one they are in; this is the administrator's view of any). `entryModel` is the model the workspace's entry
 * agents take when a user has not picked one in "我的智能体" (`AgentPolicy.defaultModel`, mirrored
 * in `workspaces.entry_model`); `allowedModels` is the list "我的智能体" narrows to (`[]` = every
 * model in the llm-proxy catalog). `isDefault` marks the platform default workspace
 * (`PlatformSettings.defaultWorkspaceId`) — it cannot be disabled.
 */
/** S5.1 (`workspaces.ontology_enforcement`, migration core 0025): what a Link write that the
 *  workspace's published ontology does not license does — `reject` (400 `ontology_violation`) or
 *  `warn` (written, audited, counted by invariant I-S5-1). New workspaces default to `reject`. */
export const OntologyEnforcementWireSchema = z.enum(['reject', 'warn']);
export type OntologyEnforcementWire = z.infer<typeof OntologyEnforcementWireSchema>;

/** S5.3 (`workspaces.purpose`, migration core 0028): why the workspace exists. `ephemeral` — an
 *  acceptance run or a demo — carries `expiresAt` and is retired by
 *  `scripts/delete-workspaces-matching.sh --expired`; `standard` never expires. Set at creation
 *  (`create-workspace --purpose ephemeral --ttl <n>h`), read-only on the console. */
export const WorkspacePurposeWireSchema = z.enum(['standard', 'ephemeral']);
export type WorkspacePurposeWire = z.infer<typeof WorkspacePurposeWireSchema>;

export const PlatformWorkspaceWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: WorkspaceStatusWireSchema,
    entryModel: z.string().nullable(),
    allowedModels: z.array(z.string()),
    ontologyEnforcement: OntologyEnforcementWireSchema,
    purpose: WorkspacePurposeWireSchema,
    /** ISO timestamp; `null` unless `purpose` is `ephemeral`. */
    expiresAt: z.string().nullable(),
    /** S6 (migration core 0030): when `set_workspace_status` last disabled it; `null` while
     *  active — and `null` on a workspace disabled before 0030, which counts as "retention
     *  elapsed" (docs/console-completion-plan.md §12 决定 3). */
    disabledAt: z.string().nullable(),
    /** S6: `purge_workspace` would accept this workspace right now — disabled for 7 days (or
     *  disabled before 0030), or an ephemeral workspace past `expiresAt`; never the platform
     *  default workspace. The console shows the purge entry only when this is `true`. */
    purgeable: z.boolean(),
    isDefault: z.boolean(),
    /** Active human memberships (Principals with a user, not disabled). */
    memberCount: z.number().int().nonnegative(),
    owners: z.array(WorkspaceOwnerWireSchema),
    createdAt: z.string(),
  })
  .strict();
export type PlatformWorkspaceWire = z.infer<typeof PlatformWorkspaceWireSchema>;

// -------------------------------------------------------------------------------------------
// S6 A1 / A6 (docs/console-completion-plan.md §4 "Workspace 生命周期", §5.2, §6 rows
// `purge_workspace` / `purge_user`): the purge plane — `purged` is a workspace's terminal state
// (rows and cascade deleted, the platform audit row kept), and a never-activated user is
// deleted either with its workspace (edge (b)) or by `purge_user`.
// -------------------------------------------------------------------------------------------

/** Why `purge_workspace` accepts the workspace (the two preconditions of §5.2). */
export const PurgeWorkspaceReasonWireSchema = z.enum([
  'disabled_retention_elapsed',
  'ephemeral_expired',
]);
export type PurgeWorkspaceReasonWire = z.infer<typeof PurgeWorkspaceReasonWireSchema>;

/** §4 edge (a): a `service` Principal (a collector, an external runtime) still exists in the
 *  workspace — some process out there may hold its Handle and will start failing with 401 the
 *  moment the purge runs (leftover 41's origin). Shown in the confirmation before purging. */
export const PurgeWarningWireSchema = z
  .object({
    kind: z.literal('service_handle_in_use'),
    principalId: z.string(),
    /** The service Principal's display name (`issue-service-handle --name`). */
    name: z.string().nullable(),
    /** Its Handles not yet revoked or expired at assessment time. */
    activeHandles: z.number().int().nonnegative(),
  })
  .strict();
export type PurgeWarningWire = z.infer<typeof PurgeWarningWireSchema>;

export const PurgedUserWireSchema = z.object({ id: z.string(), login: z.string() }).strict();
export type PurgedUserWire = z.infer<typeof PurgedUserWireSchema>;

/**
 * `purge_workspace`'s result for both its modes — the preview (`confirm` omitted or `false`:
 * nothing deleted, every field is "what would happen") and the execution (`confirm: true`,
 * `executed: true`: every field is what happened). The console's two-step confirmation shows the
 * preview, then sends `confirm: true`.
 *
 * `counts` is keyed by the workspace-scoped table the rows come from, camel-cased
 * (`capabilityHandles`, `auditRecords`, `facts`, …), only tables that held at least one row;
 * `totalRows` is their sum. `principalIds` / `taskIds` are for the host-side cleanup the kernel
 * cannot do itself — each Principal's resident entry container and data directory, each Task's
 * `workspaces/tasks/<taskId>` directory (`scripts/delete-workspace.sh`).
 */
export const PurgeWorkspaceResultWireSchema = z
  .object({
    workspaceId: z.string(),
    name: z.string(),
    purpose: WorkspacePurposeWireSchema,
    status: WorkspaceStatusWireSchema,
    reason: PurgeWorkspaceReasonWireSchema,
    executed: z.boolean(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    totalRows: z.number().int().nonnegative(),
    /** CapabilityHandles still live at assessment time — revoked first, then deleted (§4). */
    activeHandles: z.number().int().nonnegative(),
    warnings: z.array(PurgeWarningWireSchema),
    /** §4 edge (b): users whose memberships were all in this workspace and who never activated
     *  (no password, no console session, nothing else referencing them) — deleted with it. */
    purgedUsers: z.array(PurgedUserWireSchema),
    principalIds: z.array(z.string()),
    taskIds: z.array(z.string()),
  })
  .strict();
export type PurgeWorkspaceResultWire = z.infer<typeof PurgeWorkspaceResultWireSchema>;

/** Why `purge_user` skipped one of the requested users. */
export const PurgeUserSkipReasonWireSchema = z.enum([
  'user_not_found',
  /** Has a password — a real account, never purgeable (disable it instead). */
  'activated',
  'platform_admin',
  /** Has logged into the console at least once (`user_sessions`). */
  'has_sessions',
  /** Holds a membership Principal that is not disabled — remove it first, or purge the
   *  workspace, which cascades the user (§4 edge (b)). */
  'active_membership',
  /** Something else references the row (a platform audit row, a settings version); audit only
   *  ever grows, so the user stays. */
  'referenced',
]);
export type PurgeUserSkipReasonWire = z.infer<typeof PurgeUserSkipReasonWireSchema>;

export const PurgeUserOutcomeWireSchema = z
  .object({
    userId: z.string(),
    /** `null` when the id matched no user. */
    login: z.string().nullable(),
    status: z.enum(['purged', 'skipped']),
    reason: PurgeUserSkipReasonWireSchema.optional(),
    /** Human-readable detail for `referenced` (which table). */
    detail: z.string().optional(),
  })
  .strict();
export type PurgeUserOutcomeWire = z.infer<typeof PurgeUserOutcomeWireSchema>;

/** `purge_user`: one outcome per requested id, in request order. A skipped user never fails the
 *  batch — the console reports the reasons next to each row. */
export const PurgeUsersResultWireSchema = z
  .object({
    outcomes: z.array(PurgeUserOutcomeWireSchema),
    purgedCount: z.number().int().nonnegative(),
  })
  .strict();
export type PurgeUsersResultWire = z.infer<typeof PurgeUsersResultWireSchema>;

// -------------------------------------------------------------------------------------------
// P-B1 (docs/platform-admin-design.md §6.3 集成): connectors (接入包), gate instances (门实例) and
// external runtimes as the platform plane sees them; the workspace-side "enable from the platform
// catalog" shapes live here too so the two planes share one vocabulary.
// -------------------------------------------------------------------------------------------

/** design §6.3 three-state, borrowed from cloudflare-os `ambientGatekeeperModes`: `disabled` (no new
 *  connections or enables), `self_serve` (a workspace owner may connect their own instance),
 *  `platform_preset` (the administrator runs the instances; workspaces enable them one-click). */
export const ConnectorModeWireSchema = z.enum(['disabled', 'self_serve', 'platform_preset']);
export type ConnectorModeWire = z.infer<typeof ConnectorModeWireSchema>;

export const GateTransportKindWireSchema = z.enum(['http', 'mcp', 'cli', 'ssh']);

export const ConnectorWireSchema = z
  .object({
    /** Stable connector name: a packaged gate's `GATE_CONNECTOR` (`docker`, `ragflow`) or one of
     *  the generic kinds (`http`, `mcp`, `cli`, `ssh`). */
    name: z.string(),
    kind: GateTransportKindWireSchema,
    /** `true` for a gate this deployment ships as its own image (announced with a connector name
     *  other than the four generic kinds). */
    packaged: z.boolean(),
    mode: ConnectorModeWireSchema,
    /** Operation names refused on the next call for every instance of this connector. */
    disabledOperations: z.array(z.string()),
    /** Distinct Operation names across this connector's announced instances. */
    operationCount: z.number().int().nonnegative(),
    instanceCount: z.number().int().nonnegative(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type ConnectorWire = z.infer<typeof ConnectorWireSchema>;

export const GateInstanceStatusWireSchema = z.enum(['discovered', 'enabled', 'disabled', 'lost']);
export type GateInstanceStatusWire = z.infer<typeof GateInstanceStatusWireSchema>;

/** `vetted` is the administrator's mark on a platform-run MCP instance (design §6.3 "MCP 信任分级");
 *  read at every approval decision, never frozen onto a connection. */
export const GateTrustWireSchema = z.enum(['byo', 'vetted']);
export type GateTrustWire = z.infer<typeof GateTrustWireSchema>;

export const GateHealthWireSchema = z.enum(['ok', 'unreachable', 'unauthorized', 'unknown']);
export type GateHealthWire = z.infer<typeof GateHealthWireSchema>;

/** One announced Operation, as the gate described it (a subset of `OperationSchema`). */
export const GateOperationSummaryWireSchema = z
  .object({
    name: z.string(),
    mode: z.enum(['observe', 'execute']),
    blastRadius: z.string(),
    autoApprovable: z.boolean(),
    readOnlyHint: z.boolean().nullable(),
    destructiveHint: z.boolean().nullable(),
    idempotentHint: z.boolean().nullable(),
  })
  .strict();
export type GateOperationSummaryWire = z.infer<typeof GateOperationSummaryWireSchema>;

/** P-B2a (决定 ⑦): what the administrator typed when creating a gate-host instance — the gate host
 *  builds the transport and credential resolver from exactly this, nothing more. Never a credential. */
export const GateHostedDefinitionWireSchema = z
  .object({
    transportKind: z.enum(['http', 'mcp']),
    /** The target system’s base URL (http) or MCP endpoint (mcp). */
    target: z.string().url(),
    /** `shared`: one credential for the whole instance, stored under the shared slot by an
     *  administrator; `connected_account`: one per Principal, entered by each member. Either way the
     *  credential goes browser → gate host directly (决定 ⑩). */
    credentialMode: z.enum(['shared', 'connected_account']),
    /** http: the OpenAPI document URL the host imports Operations from; mcp: `null` (tools/list on the target). */
    manifestSource: z.string().url().nullable(),
  })
  .strict();
export type GateHostedDefinitionWire = z.infer<typeof GateHostedDefinitionWireSchema>;

export const GateInstanceWireSchema = z
  .object({
    /** `GATE_ID`: the stable identity the gate announces itself with (compose config, not a display
     *  name — a second container cannot take over an enabled gate by reusing its name). */
    gateId: z.string(),
    connector: z.string(),
    displayName: z.string(),
    transportKind: GateTransportKindWireSchema,
    target: z.string(),
    endpoint: z.string(),
    status: GateInstanceStatusWireSchema,
    trust: GateTrustWireSchema,
    health: GateHealthWireSchema,
    lastSeenAt: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
    operationCount: z.number().int().nonnegative(),
    /** Workspaces that enabled this instance (`workspace_gate_links`). */
    enabledWorkspaceCount: z.number().int().nonnegative(),
    operations: z.array(GateOperationSummaryWireSchema),
    /** P-B2a: created by an administrator and served by the generic gate host (决定 ⑦); `false` for a
     *  packaged gate that announced itself. */
    hosted: z.boolean(),
    definition: GateHostedDefinitionWireSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type GateInstanceWire = z.infer<typeof GateInstanceWireSchema>;

export const GateInstanceTestResultWireSchema = z
  .object({
    gateId: z.string(),
    health: GateHealthWireSchema,
    /** Operations the gate described just now; `null` when it could not be reached. */
    describedOperationCount: z.number().int().nonnegative().nullable(),
    checkedAt: z.string(),
  })
  .strict();
export type GateInstanceTestResultWire = z.infer<typeof GateInstanceTestResultWireSchema>;

/** One external runtime = a `service` Principal's live session (Claude Code, a local pi over
 *  `/mcp`, a collector) — listed across workspaces for inventory and revocation (design §6.3). */
export const ExternalRuntimeWireSchema = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    principalId: z.string(),
    displayName: z.string().nullable(),
    sessionId: z.string(),
    sessionKind: z.string(),
    status: z.string(),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
  })
  .strict();
export type ExternalRuntimeWire = z.infer<typeof ExternalRuntimeWireSchema>;

export const RevokeExternalRuntimeResultWireSchema = z
  .object({ workspaceId: z.string(), sessionId: z.string(), revoked: z.boolean() })
  .strict();
export type RevokeExternalRuntimeResultWire = z.infer<typeof RevokeExternalRuntimeResultWireSchema>;

/** Workspace side (`list_available_gate_instances`): a platform gate instance an owner may enable
 *  here, with whether this workspace already did. */
export const AvailableGateInstanceWireSchema = z
  .object({
    gateId: z.string(),
    connector: z.string(),
    displayName: z.string(),
    transportKind: GateTransportKindWireSchema,
    target: z.string(),
    status: GateInstanceStatusWireSchema,
    trust: GateTrustWireSchema,
    health: GateHealthWireSchema,
    operationCount: z.number().int().nonnegative(),
    /** Set when this workspace already enabled it: the workspace's Gatekeeper object id. */
    gatekeeperId: z.string().nullable(),
  })
  .strict();
export type AvailableGateInstanceWire = z.infer<typeof AvailableGateInstanceWireSchema>;

export const EnableGateInstanceResultWireSchema = z
  .object({
    gateId: z.string(),
    gatekeeperId: z.string(),
    publishedOperationNames: z.array(z.string()),
    skippedOperationNames: z.array(z.string()),
  })
  .strict();
export type EnableGateInstanceResultWire = z.infer<typeof EnableGateInstanceResultWireSchema>;

/** P-B2a (决定 ⑩): the 5-minute platform JWT the browser presents to the gate host when it posts a
 *  credential straight there. `url` is same-origin (Caddy `/gate-host/*`); `onBehalfOf` is the slot the
 *  token may write (`__shared__` or the caller’s Principal id) — the host takes it from the token. */
export const GateHostTokenWireSchema = z
  .object({
    gateId: z.string(),
    token: z.string(),
    url: z.string(),
    onBehalfOf: z.string(),
    credentialMode: z.enum(['shared', 'connected_account']),
    expiresAt: z.string(),
  })
  .strict();
export type GateHostTokenWire = z.infer<typeof GateHostTokenWireSchema>;

export const DeleteGateInstanceResultWireSchema = z
  .object({ gateId: z.string(), deleted: z.literal(true) })
  .strict();
export type DeleteGateInstanceResultWire = z.infer<typeof DeleteGateInstanceResultWireSchema>;

// -------------------------------------------------------------------------------------------
// S7-E (docs/platform-admin-design.md §6.5 / §6.7, development-tasks.md §5d S7-E 决定 E1–E4):
// the runtime layer (active image, image inventory, resident-container rebuild derivation, pi
// drift) and platform status (service health, 30-day llm_usage rollup, backup posture). Mirrors
// `application/platform/runtime.ts` (kernel) and `worker-supervisor`'s own `GET /images` /
// `GET /residents` shapes one level up (camelCase, no snake_case, no raw Docker fields beyond
// what a human/the console needs).
// -------------------------------------------------------------------------------------------

/** One runtime image worker-supervisor knows about (`GET /images` — only images carrying every
 *  `ai.nexttime.*` platform label). `id` is Docker's own image id (`sha256:...`) — for a locally
 *  built, never-pushed image (this platform never pushes `nexttime-ai-worker-runtime` to a
 *  registry) there is no meaningful registry digest, so `id` **is** what "镜像 digest" means
 *  throughout this API: the same tag rebuilt with different content always gets a different `id`,
 *  which is exactly the signal `runtime_inventory`'s "待重建" derivation (E2) needs and a
 *  `RepoDigests`-based field (empty for an unpushed image) could not give. */
export const RuntimeImageWireSchema = z
  .object({
    id: z.string(),
    tags: z.array(z.string()),
    createdAt: z.string(),
    /** `ai.nexttime.pi-version` label, when present. */
    piVersion: z.string().nullable(),
    /** `ai.nexttime.platform-extension-version` label, when present. */
    platformExtensionVersion: z.string().nullable(),
    /** `ai.nexttime.built-from` label, when present (a git ref / commit the build was cut from). */
    builtFrom: z.string().nullable(),
    labels: z.record(z.string(), z.string()),
  })
  .strict();
export type RuntimeImageWire = z.infer<typeof RuntimeImageWireSchema>;

/** One resident entry container, as `runtime_inventory` lists it. `needsRebuild` (E2 "待重建") is
 *  derived, never stored: `true` only when both this container's own resolved image id and the
 *  active image's own resolved id are known and differ — an unresolvable comparison (the active
 *  image missing from `list_runtime_images`, or the container not currently running) is `false`,
 *  never a guessed `true` (E2: no stored draining/rebuild state, and a false positive here would
 *  be far worse than a false negative — the acceleration capability, `roll_entry_containers`,
 *  reads this same field). */
export const ResidentContainerWireSchema = z
  .object({
    principalId: z.string(),
    workspaceId: z.string(),
    containerId: z.string(),
    running: z.boolean(),
    status: z.string(),
    /** The image reference (tag/digest string) this container was last (re)created with — what
     *  worker-supervisor was asked to spawn, not necessarily the currently active setting. */
    image: z.string().nullable(),
    /** This container's own resolved image id (`docker inspect`'s `Image` field) — `null` when
     *  not running (Docker releases it) or never observed. */
    imageId: z.string().nullable(),
    startedAt: z.string().nullable(),
    lastTouchedAt: z.string().nullable(),
    needsRebuild: z.boolean(),
  })
  .strict();
export type ResidentContainerWire = z.infer<typeof ResidentContainerWireSchema>;

export const RuntimeInventoryWireSchema = z
  .object({
    /** The image reference `task/spawn` and `startTurn` currently request — the platform setting
     *  when set (`"setting"`), else worker-supervisor's own reported `WORKER_IMAGE` default
     *  (`"env_default"` — read live from worker-supervisor, never a kernel-side guess). `null`
     *  with `activeImageSource: "unknown"` only when the setting is unset *and* worker-supervisor
     *  could not be reached to report its own default — never guessed. */
    activeImage: z.string().nullable(),
    activeImageSource: z.enum(['setting', 'env_default', 'unknown']),
    /** The active image's own inventory entry, when it could be resolved (found in
     *  `list_runtime_images`) — `null` when the active image carries no platform label or is not
     *  known to worker-supervisor, in which case every `residentContainers[].needsRebuild` is
     *  `false` (unresolvable, never guessed). */
    activeImageInfo: RuntimeImageWireSchema.nullable(),
    images: z.array(RuntimeImageWireSchema),
    residentContainers: z.array(ResidentContainerWireSchema),
    checkedAt: z.string(),
  })
  .strict();
export type RuntimeInventoryWire = z.infer<typeof RuntimeInventoryWireSchema>;

/** `roll_entry_containers` (E2 "加速项"): stops entry containers that both need rebuild (digest
 *  mismatch) and have no in-flight Turn (the kernel's own `activities` bookkeeping,
 *  `kind='agent_turn' and status='running'`) — never a forced stop of a busy container, never a
 *  "draining"/reject-new-Turn state. */
export const RollEntryContainerActionWireSchema = z.enum([
  'stopped',
  'skipped_in_flight',
  'skipped_up_to_date',
  'skipped_not_found',
]);
export type RollEntryContainerActionWire = z.infer<typeof RollEntryContainerActionWireSchema>;

export const RollEntryContainerOutcomeWireSchema = z
  .object({
    principalId: z.string(),
    workspaceId: z.string(),
    action: RollEntryContainerActionWireSchema,
  })
  .strict();
export type RollEntryContainerOutcomeWire = z.infer<typeof RollEntryContainerOutcomeWireSchema>;

export const RollEntryContainersResultWireSchema = z
  .object({
    outcomes: z.array(RollEntryContainerOutcomeWireSchema),
    stoppedCount: z.number().int().nonnegative(),
  })
  .strict();
export type RollEntryContainersResultWire = z.infer<typeof RollEntryContainersResultWireSchema>;

/** `pi_drift` (E3): whether the pinned `pi.version` (repo source of truth) and the active
 *  runtime image's own baked-in pi version agree. `pinnedPiVersion` comes from a CI-produced
 *  static JSON file (never a live npm/GitHub lookup — E3 "不出网"); `null` when that file does not
 *  exist yet in this deployment, in which case `status` is always `unknown` — this repo's current
 *  `pi-drift.yml` checks pi@latest test compatibility, it does not yet emit this comparison file
 *  (documented assumption, see the PR body). `activeImagePiVersion`/`platformExtensionVersion` are
 *  read live off the active runtime image's own labels (`list_runtime_images`), which is not a
 *  network call — the image already lives on this host. */
export const PiDriftStatusWireSchema = z.enum(['consistent', 'drifted', 'unknown']);
export type PiDriftStatusWire = z.infer<typeof PiDriftStatusWireSchema>;

export const PiDriftWireSchema = z
  .object({
    status: PiDriftStatusWireSchema,
    pinnedPiVersion: z.string().nullable(),
    activeImagePiVersion: z.string().nullable(),
    platformExtensionVersion: z.string().nullable(),
    detail: z.string(),
    /** The CI file's own timestamp, when available. */
    checkedAt: z.string().nullable(),
  })
  .strict();
export type PiDriftWire = z.infer<typeof PiDriftWireSchema>;

/** `platform_status` (E4): service health probes kernel actually performs (never a stand-in for
 *  the workspace-scoped `list_gate_instances` health, which is reused verbatim here), a 30-day
 *  cross-workspace `llm_usage` rollup, and the most recent platform audit rows. `backup` reports
 *  "未配置 not configured" until 遗留 6 lands — no backup timer exists, this is not a stub for one. */
export const PlatformStatusBackupWireSchema = z
  .object({
    configured: z.boolean(),
    detail: z.string(),
  })
  .strict();
export type PlatformStatusBackupWire = z.infer<typeof PlatformStatusBackupWireSchema>;

export const PlatformStatusLlmUsageWireSchema = z
  .object({
    windowDays: z.literal(30),
    totalCostUsd: z.number().nullable(),
    totalInputTokens: z.number().nonnegative(),
    totalOutputTokens: z.number().nonnegative(),
    callCount: z.number().int().nonnegative(),
  })
  .strict();
export type PlatformStatusLlmUsageWire = z.infer<typeof PlatformStatusLlmUsageWireSchema>;

export const PlatformStatusWireSchema = z
  .object({
    health: z.array(ServiceHealthWireSchema),
    backup: PlatformStatusBackupWireSchema,
    llmUsage30d: PlatformStatusLlmUsageWireSchema,
    recentAudit: z.array(PlatformAuditRecordWireSchema),
    checkedAt: z.string(),
  })
  .strict();
export type PlatformStatusWire = z.infer<typeof PlatformStatusWireSchema>;
