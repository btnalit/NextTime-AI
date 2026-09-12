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
    actorUserId: z.string(),
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
export const PlatformWorkspaceWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: WorkspaceStatusWireSchema,
    entryModel: z.string().nullable(),
    allowedModels: z.array(z.string()),
    isDefault: z.boolean(),
    /** Active human memberships (Principals with a user, not disabled). */
    memberCount: z.number().int().nonnegative(),
    owners: z.array(WorkspaceOwnerWireSchema),
    createdAt: z.string(),
  })
  .strict();
export type PlatformWorkspaceWire = z.infer<typeof PlatformWorkspaceWireSchema>;
