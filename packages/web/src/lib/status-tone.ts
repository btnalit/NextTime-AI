import type {
  ActionRequestStatus,
  BlastRadius,
  ConnectionRequestStatus,
  ConnectorModeWire,
  GateInstanceStatusWire,
  GateTrustWire,
  GrantStatus,
  OperationMode,
  PiDriftStatusWire,
  PlatformRoleWire,
  PublishableStatus,
  Role,
  TaskStatus,
  UserStatusWire,
  WorkerRunStatus,
  WorkspacePurposeWire,
  WorkspaceStatusWire,
} from '@nexttime/shared';
import {
  ACTION_REQUEST_STATUS_VALUES,
  BLAST_RADIUS_VALUES,
  CONNECTION_REQUEST_STATUS_VALUES,
  ConnectorModeWireSchema,
  GRANT_STATUS_VALUES,
  GateHealthWireSchema,
  GateInstanceStatusWireSchema,
  GateTrustWireSchema,
  OPERATION_MODE_VALUES,
  PUBLISHABLE_STATUS_VALUES,
  PiDriftStatusWireSchema,
  PlatformRoleWireSchema,
  ROLE_VALUES,
  ServiceHealthWireSchema,
  TASK_STATUS_VALUES,
  UserStatusWireSchema,
  WORKER_RUN_STATUS_VALUES,
  WorkspacePurposeWireSchema,
  WorkspaceStatusWireSchema,
} from '@nexttime/shared';
import type { Translate } from './i18n.js';

/**
 * lib/status-tone: the one status → visual-tone map per state machine, keyed by the enums
 * `@nexttime/shared` (`enums.ts`, and for the platform plane the `wire/platform.ts` Zod enums —
 * their `.options` are the runtime arrays). Every map is typed `Record<<Status>, ChipStyle>`, so a
 * state added to the kernel's enum fails `tsc` here until it is given a tone — and
 * `StatusChip.test.tsx` walks the runtime value arrays so the same holds at test time. No status
 * string is hand-typed anywhere in the UI: components pass the wire value through
 * `statusChipStyle(machine, value)` and get back tone + label.
 *
 * Tones follow docs/console-completion-plan.md §5.9 principle 2 — one colour, one meaning:
 *   observe (teal)   — read-only reach: `OperationMode.observe`
 *   warn (amber)     — in flight / pending a human / medium impact / `warn` enforcement
 *   danger (red)     — high impact, irreversible, rejected, conflict, failed, unreachable, purge
 *   ok (green)       — executed, published, healthy, active, vetted
 *   info (blue)      — system / proposal / production / default / platform-run
 *   neutral (grey)   — archived, superseded, disabled, acceptance residue, untested, unknown
 *   accent           — the caller's own elevated standing (owner, platform admin) — a "you can
 *                      act here" mark, the same blue family as links
 * S6-A0 (C17) extended the machines to the platform plane: user status, workspace status and
 * purpose, gate-instance status / health / trust, connector mode, service health, platform role,
 * and the two governance scalars every ActionRequest carries (operation mode, blast radius).
 */

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'observe';

/** S8 W1-A9 (audit S4/S7) left the seven pre-S8 machines (action request, task, worker run,
 *  connection request, publishable, grant, role) English-only ("keep the existing wording, only
 *  split the pairs" — out of scope for that lane). S8 W1-A10 (audit S14) gave every one of them a
 *  `{zh, en}` pair, so `label` is always bilingual now; the `string` arm stays on the type only for
 *  an `unknown` value (`statusChipStyle`'s fallback echoes the raw wire string verbatim — see its
 *  own doc comment) and any future machine ported the same way `resolveChipLabel` already supports
 *  either shape without a caller-visible change. */
export interface ChipStyle {
  readonly tone: Tone;
  readonly label: string | { readonly zh: string; readonly en: string };
  /** Pulsing dot — the state is in motion (running, waiting on someone). */
  readonly live?: boolean;
}

/** S8 W1-A10 (audit S14): the one place a `ChipStyle.label` (bilingual or plain) is resolved to
 *  the text for the active language — `StatusChip` and `lib/labels.ts`'s enum-label helpers both
 *  read through this instead of duplicating the `typeof label === 'string'` check. */
export function labelText(style: Pick<ChipStyle, 'label'>, t: Translate): string {
  return typeof style.label === 'string' ? style.label : t(style.label.zh, style.label.en);
}

export type StatusMachine =
  | 'actionRequest'
  | 'task'
  | 'workerRun'
  | 'connectionRequest'
  | 'publishable'
  | 'grant'
  | 'role'
  | 'operationMode'
  | 'blastRadius'
  | 'userStatus'
  | 'workspaceStatus'
  | 'workspacePurpose'
  | 'gateInstance'
  | 'gateHealth'
  | 'gateTrust'
  | 'connectorMode'
  | 'serviceHealth'
  | 'platformRole'
  | 'piDrift';

export const ACTION_REQUEST_TONES: Readonly<Record<ActionRequestStatus, ChipStyle>> = {
  proposed: { tone: 'neutral', label: { zh: '已提议', en: 'Proposed' } },
  policy_evaluated: { tone: 'neutral', label: { zh: '策略已评估', en: 'Policy evaluated' } },
  auto_approved: { tone: 'ok', label: { zh: '已自动批准', en: 'Auto-approved' } },
  pending_approval: {
    tone: 'warn',
    label: { zh: '待审批', en: 'Pending approval' },
    live: true,
  },
  approved: { tone: 'ok', label: { zh: '已批准', en: 'Approved' } },
  rejected: { tone: 'danger', label: { zh: '已拒绝', en: 'Rejected' } },
  expired: { tone: 'neutral', label: { zh: '已过期', en: 'Expired' } },
  denied: { tone: 'danger', label: { zh: '策略已否决', en: 'Denied by policy' } },
  executing: { tone: 'info', label: { zh: '执行中', en: 'Executing' }, live: true },
  executed: { tone: 'ok', label: { zh: '已执行', en: 'Executed' } },
  failed: { tone: 'danger', label: { zh: '已失败', en: 'Failed' } },
  verified: { tone: 'ok', label: { zh: '已验证', en: 'Verified' } },
  compensated: { tone: 'warn', label: { zh: '已补偿', en: 'Compensated' } },
};

export const TASK_TONES: Readonly<Record<TaskStatus, ChipStyle>> = {
  created: { tone: 'neutral', label: { zh: '已创建', en: 'Created' } },
  queued: { tone: 'neutral', label: { zh: '排队中', en: 'Queued' } },
  running: { tone: 'info', label: { zh: '运行中', en: 'Running' }, live: true },
  waiting_approval: {
    tone: 'warn',
    label: { zh: '等待审批', en: 'Waiting approval' },
    live: true,
  },
  completed: { tone: 'ok', label: { zh: '已完成', en: 'Completed' } },
  failed: { tone: 'danger', label: { zh: '已失败', en: 'Failed' } },
  cancelled: { tone: 'neutral', label: { zh: '已取消', en: 'Cancelled' } },
};

export const WORKER_RUN_TONES: Readonly<Record<WorkerRunStatus, ChipStyle>> = {
  provisioning: { tone: 'neutral', label: { zh: '准备中', en: 'Provisioning' }, live: true },
  running: { tone: 'info', label: { zh: '运行中', en: 'Running' }, live: true },
  suspended: { tone: 'warn', label: { zh: '已挂起', en: 'Suspended' } },
  terminated: { tone: 'neutral', label: { zh: '已终止', en: 'Terminated' } },
};

export const CONNECTION_REQUEST_TONES: Readonly<Record<ConnectionRequestStatus, ChipStyle>> = {
  requested: { tone: 'warn', label: { zh: '已申请', en: 'Requested' }, live: true },
  completed: { tone: 'ok', label: { zh: '已完成', en: 'Completed' } },
  cancelled: { tone: 'neutral', label: { zh: '已取消', en: 'Cancelled' } },
};

export const PUBLISHABLE_TONES: Readonly<Record<PublishableStatus, ChipStyle>> = {
  draft: { tone: 'neutral', label: { zh: '草稿', en: 'Draft' } },
  published: { tone: 'ok', label: { zh: '已发布', en: 'Published' } },
  deprecated: { tone: 'warn', label: { zh: '已弃用', en: 'Deprecated' } },
};

/** S3.11's CapabilityGrant (`enums.ts` `GRANT_STATUS_VALUES`) — the Access page's grant list. */
export const GRANT_TONES: Readonly<Record<GrantStatus, ChipStyle>> = {
  active: { tone: 'ok', label: { zh: '生效中', en: 'Active' } },
  revoked: { tone: 'danger', label: { zh: '已撤销', en: 'Revoked' } },
  expired: { tone: 'neutral', label: { zh: '已过期', en: 'Expired' } },
};

/** Not a lifecycle machine (a Role never "transitions"), but reusing the tone vocabulary keeps the
 *  Members page's role chip and the Sidebar's role badge visually consistent with every other
 *  status in the console rather than inventing a second color system. */
export const ROLE_TONES: Readonly<Record<Role, ChipStyle>> = {
  owner: { tone: 'accent', label: { zh: '所有者', en: 'Owner' } },
  operator: { tone: 'info', label: { zh: '操作员', en: 'Operator' } },
  builder: { tone: 'info', label: { zh: '构建者', en: 'Builder' } },
  auditor: { tone: 'neutral', label: { zh: '审计员', en: 'Auditor' } },
  member: { tone: 'neutral', label: { zh: '成员', en: 'Member' } },
};

// -------------------------------------------------------------------------------------------
// S6-A0 / C17: the governance scalars and the platform plane (docs/console-completion-plan.md
// §5.9 "StatusChip 扩到平台面枚举"). Runtime arrays come from the shared Zod enums' `.options`.
// -------------------------------------------------------------------------------------------

/** `Operation.mode` (design §6.3): observe is read-only reach (teal), execute changes the world
 *  and is the mode approvals exist for (amber). */
export const OPERATION_MODE_TONES: Readonly<Record<OperationMode, ChipStyle>> = {
  observe: { tone: 'observe', label: { zh: '观察', en: 'Observe' } },
  execute: { tone: 'warn', label: { zh: '执行', en: 'Execute' } },
};

/** `ActionRequest.blastRadius` — the confirmation tier driver (§5.9 principle 4). */
export const BLAST_RADIUS_TONES: Readonly<Record<BlastRadius, ChipStyle>> = {
  low: { tone: 'ok', label: { zh: '低影响', en: 'Low' } },
  medium: { tone: 'warn', label: { zh: '中影响', en: 'Medium' } },
  high: { tone: 'danger', label: { zh: '高影响', en: 'High' } },
};

/** `pending_activation` is a *derived* display state (`UserWire.hasPassword === false` on an
 *  `active` user — a backfilled or password-less account; never a `list_users` filter value, see
 *  `PlatformUsersPage`'s own note). It is appended to the wire enum here so the users page can
 *  render all three through one chip; `deriveUserStatus` is the one place that derivation lives. */
export type UserDisplayStatus = UserStatusWire | 'pending_activation';
export const USER_STATUS_VALUES: readonly UserDisplayStatus[] = [
  ...UserStatusWireSchema.options,
  'pending_activation',
];
export const USER_STATUS_TONES: Readonly<Record<UserDisplayStatus, ChipStyle>> = {
  active: { tone: 'ok', label: { zh: '活跃', en: 'Active' } },
  disabled: { tone: 'neutral', label: { zh: '已停用', en: 'Disabled' } },
  pending_activation: { tone: 'warn', label: { zh: '待激活', en: 'Pending activation' } },
};

export function deriveUserStatus(user: {
  readonly status: UserStatusWire;
  readonly hasPassword: boolean;
}): UserDisplayStatus {
  if (user.status === 'disabled') return 'disabled';
  return user.hasPassword ? 'active' : 'pending_activation';
}

export const WORKSPACE_STATUS_TONES: Readonly<Record<WorkspaceStatusWire, ChipStyle>> = {
  active: { tone: 'ok', label: { zh: '活跃', en: 'Active' } },
  disabled: { tone: 'neutral', label: { zh: '已停用', en: 'Disabled' } },
};

/** `standard` is the production default (blue); `ephemeral` is acceptance residue (grey, §5.9). */
export const WORKSPACE_PURPOSE_TONES: Readonly<Record<WorkspacePurposeWire, ChipStyle>> = {
  standard: { tone: 'info', label: { zh: '常规', en: 'standard' } },
  ephemeral: { tone: 'neutral', label: { zh: '临时', en: 'ephemeral' } },
};

/** `awaiting_host` is derived: a hosted instance (`create_gate_instance`) the gate host has not
 *  taken over yet (`hosted && lastSeenAt === null`) — see `PlatformIntegrationsPage`. */
export type GateInstanceDisplayStatus = GateInstanceStatusWire | 'awaiting_host';
export const GATE_INSTANCE_STATUS_VALUES: readonly GateInstanceDisplayStatus[] = [
  ...GateInstanceStatusWireSchema.options,
  'awaiting_host',
];
export const GATE_INSTANCE_TONES: Readonly<Record<GateInstanceDisplayStatus, ChipStyle>> = {
  discovered: { tone: 'neutral', label: { zh: '未启用', en: 'Discovered' } },
  enabled: { tone: 'ok', label: { zh: '已启用', en: 'Enabled' } },
  disabled: { tone: 'neutral', label: { zh: '已禁用', en: 'Disabled' } },
  lost: { tone: 'warn', label: { zh: '失联', en: 'Lost' } },
  awaiting_host: {
    tone: 'warn',
    label: { zh: '等待宿主接管', en: 'Waiting for gate host' },
    live: true,
  },
};

export function deriveGateInstanceStatus(instance: {
  readonly status: GateInstanceStatusWire;
  readonly hosted: boolean;
  readonly lastSeenAt: string | null;
}): GateInstanceDisplayStatus {
  return instance.hosted && instance.lastSeenAt === null ? 'awaiting_host' : instance.status;
}

type GateHealthWire = (typeof GateHealthWireSchema.options)[number];
export const GATE_HEALTH_TONES: Readonly<Record<GateHealthWire, ChipStyle>> = {
  ok: { tone: 'ok', label: { zh: '健康', en: 'Healthy' } },
  unreachable: { tone: 'danger', label: { zh: '不可达', en: 'Unreachable' } },
  unauthorized: { tone: 'danger', label: { zh: '未授权', en: 'Unauthorized' } },
  unknown: { tone: 'neutral', label: { zh: '未知', en: 'Unknown' } },
};

/** MCP trust mark (design §6.3): `vetted` unlocks auto-approval of non-destructive tool calls. */
export const GATE_TRUST_TONES: Readonly<Record<GateTrustWire, ChipStyle>> = {
  byo: { tone: 'neutral', label: { zh: '自带', en: 'BYO' } },
  vetted: { tone: 'ok', label: { zh: '已审核', en: 'Vetted' } },
};

/** Connector three-state (design §6.3): `platform_preset` = the platform runs the instances and
 *  workspaces enable them one-click (published, green); `self_serve` = owners connect their own
 *  (the system default, blue); `disabled` = grey. */
export const CONNECTOR_MODE_TONES: Readonly<Record<ConnectorModeWire, ChipStyle>> = {
  disabled: { tone: 'neutral', label: { zh: '已禁用', en: 'Disabled' } },
  self_serve: { tone: 'info', label: { zh: '自助', en: 'Self-serve' } },
  platform_preset: { tone: 'ok', label: { zh: '平台预置', en: 'Platform preset' } },
};

type ServiceHealthStatus = (typeof ServiceHealthWireSchema.shape.status.options)[number];
export const SERVICE_HEALTH_TONES: Readonly<Record<ServiceHealthStatus, ChipStyle>> = {
  ok: { tone: 'ok', label: { zh: '健康', en: 'Healthy' } },
  degraded: { tone: 'warn', label: { zh: '降级', en: 'Degraded' } },
  down: { tone: 'danger', label: { zh: '不可用', en: 'Down' } },
  unknown: { tone: 'neutral', label: { zh: '未知', en: 'Unknown' } },
};

export const PLATFORM_ROLE_TONES: Readonly<Record<PlatformRoleWire, ChipStyle>> = {
  admin: { tone: 'accent', label: { zh: '管理员', en: 'Admin' } },
  user: { tone: 'neutral', label: { zh: '用户', en: 'User' } },
};

/** `platform_status`'s pi/runtime-image consistency check (design §9 P-C — never rendered as that
 *  codename, S8 W1-A10 / audit S14): `PlatformRuntimePage`'s pi-drift card. */
export const PI_DRIFT_TONES: Readonly<Record<PiDriftStatusWire, ChipStyle>> = {
  consistent: { tone: 'ok', label: { zh: '一致', en: 'Consistent' } },
  drifted: { tone: 'danger', label: { zh: '有漂移', en: 'Drifted' } },
  unknown: { tone: 'neutral', label: { zh: '未知', en: 'Unknown' } },
};

const MACHINES: Readonly<
  Record<StatusMachine, { values: readonly string[]; tones: Readonly<Record<string, ChipStyle>> }>
> = {
  actionRequest: { values: ACTION_REQUEST_STATUS_VALUES, tones: ACTION_REQUEST_TONES },
  task: { values: TASK_STATUS_VALUES, tones: TASK_TONES },
  workerRun: { values: WORKER_RUN_STATUS_VALUES, tones: WORKER_RUN_TONES },
  connectionRequest: { values: CONNECTION_REQUEST_STATUS_VALUES, tones: CONNECTION_REQUEST_TONES },
  publishable: { values: PUBLISHABLE_STATUS_VALUES, tones: PUBLISHABLE_TONES },
  grant: { values: GRANT_STATUS_VALUES, tones: GRANT_TONES },
  role: { values: ROLE_VALUES, tones: ROLE_TONES },
  operationMode: { values: OPERATION_MODE_VALUES, tones: OPERATION_MODE_TONES },
  blastRadius: { values: BLAST_RADIUS_VALUES, tones: BLAST_RADIUS_TONES },
  userStatus: { values: USER_STATUS_VALUES, tones: USER_STATUS_TONES },
  workspaceStatus: { values: WorkspaceStatusWireSchema.options, tones: WORKSPACE_STATUS_TONES },
  workspacePurpose: { values: WorkspacePurposeWireSchema.options, tones: WORKSPACE_PURPOSE_TONES },
  gateInstance: { values: GATE_INSTANCE_STATUS_VALUES, tones: GATE_INSTANCE_TONES },
  gateHealth: { values: GateHealthWireSchema.options, tones: GATE_HEALTH_TONES },
  gateTrust: { values: GateTrustWireSchema.options, tones: GATE_TRUST_TONES },
  connectorMode: { values: ConnectorModeWireSchema.options, tones: CONNECTOR_MODE_TONES },
  serviceHealth: {
    values: ServiceHealthWireSchema.shape.status.options,
    tones: SERVICE_HEALTH_TONES,
  },
  platformRole: { values: PlatformRoleWireSchema.options, tones: PLATFORM_ROLE_TONES },
  piDrift: { values: PiDriftStatusWireSchema.options, tones: PI_DRIFT_TONES },
};

export interface ResolvedChipStyle extends ChipStyle {
  /** `true` when `status` is not a value of that machine's enum — rendered as a dashed neutral
   *  chip with the raw value, never silently restyled as something it is not. */
  readonly unknown: boolean;
}

export function statusChipStyle(machine: StatusMachine, status: string): ResolvedChipStyle {
  const entry = MACHINES[machine];
  const style = entry.values.includes(status) ? entry.tones[status] : undefined;
  if (!style) return { tone: 'neutral', label: status, unknown: true };
  return { ...style, unknown: false };
}

/** The enum values of one machine, for filter tabs — always the shared array, never retyped. */
export function statusValues(machine: StatusMachine): readonly string[] {
  return MACHINES[machine].values;
}
