import type {
  PlatformWorkspaceWire,
  PurgeUserSkipReasonWire,
  PurgeWorkspaceReasonWire,
} from '@nexttime/shared';
import type { Translate } from './i18n.js';
import { ownEntry } from './own.js';
import { hrefs } from './router.js';

// -------------------------------------------------------------------------------------------
// S6-A A1 / A6 (docs/console-completion-plan.md §4 "Workspace 生命周期", §5.2, §12 决定 3): the
// purge plane's pure helpers — retention arithmetic, the "acceptance residue" predicate the
// workspaces page and the overview banner share, the hash query that preselects it, and the
// bilingual copy for `purge_workspace` / `purge_user` results. Every time-dependent function
// takes `now` (the `lib/format.ts` convention) so tests are deterministic.
// -------------------------------------------------------------------------------------------

/** §12 决定 3: a disabled workspace becomes purgeable after 7 days — the same 7 days as the
 *  ephemeral TTL. The kernel (`application/platform/purge-workspace.ts` `PURGE_RETENTION_DAYS`)
 *  is authoritative; this mirror only drives the "N 天后可清除" hint. */
export const WORKSPACE_PURGE_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeRetention {
  /** Epoch ms at which `purge_workspace` accepts the row; `null` when it already does (retention
   *  elapsed, or `disabledAt === null` — disabled before migration core 0030, §12 决定 3). */
  readonly purgeableAt: number | null;
  /** Whole days still to wait (rounded up); `0` when purgeable now. */
  readonly daysRemaining: number;
}

/** The retention clock of a **disabled** workspace. Pass `disabledAt` straight from the wire. */
export function purgeRetention(
  disabledAt: string | null,
  now: number = Date.now(),
): PurgeRetention {
  if (disabledAt === null) return { purgeableAt: null, daysRemaining: 0 };
  const disabledMs = new Date(disabledAt).getTime();
  if (Number.isNaN(disabledMs)) return { purgeableAt: null, daysRemaining: 0 };
  const purgeableAt = disabledMs + WORKSPACE_PURGE_RETENTION_DAYS * DAY_MS;
  if (purgeableAt <= now) return { purgeableAt: null, daysRemaining: 0 };
  return { purgeableAt, daysRemaining: Math.ceil((purgeableAt - now) / DAY_MS) };
}

type LifecycleRow = Pick<PlatformWorkspaceWire, 'status' | 'purpose' | 'expiresAt'>;

/** An ephemeral workspace whose `expiresAt` has passed — purgeable whatever its status (the S5.3
 *  `--expired` contract, mirrored in the kernel's `assessPurgeEligibility`). */
export function isExpiredEphemeral(row: LifecycleRow, now: number = Date.now()): boolean {
  if (row.purpose !== 'ephemeral' || row.expiresAt === null) return false;
  const expiresMs = new Date(row.expiresAt).getTime();
  return !Number.isNaN(expiresMs) && expiresMs < now;
}

/**
 * "验收残留" (§5.9 principle 2's grey bucket, the overview banner, the workspaces page's residue
 * preset): a disabled workspace **or** an expired ephemeral one — exactly what the page's default
 * view (`{status:'active', includeExpired:false}`) hides. Not expressible as one `list_workspaces`
 * filter (disabled ∪ expired-but-still-active), hence a client-side predicate over the unfiltered
 * list.
 */
export function isResidueWorkspace(row: LifecycleRow, now: number = Date.now()): boolean {
  return row.status === 'disabled' || isExpiredEphemeral(row, now);
}

/**
 * The hash query the overview banner appends to the workspaces route so the page opens with the
 * residue preset: `#/platform/workspaces?residue=1`. `readResiduePreset` parses it back from a
 * `window.location.hash` (query first, then the page's own defaults) — the page reads it once on
 * mount; the plain route without a query is the default view. `lib/router.ts` must let the query
 * through (`routeFromHash` matches the path part; see this lane's report).
 */
export const WORKSPACES_RESIDUE_QUERY = 'residue';

export function residueWorkspacesHref(): string {
  return `${hrefs.platformWorkspaces()}?${WORKSPACES_RESIDUE_QUERY}=1`;
}

export function readResiduePreset(hash: string): boolean {
  const query = hash.indexOf('?');
  if (query === -1) return false;
  return new URLSearchParams(hash.slice(query + 1)).get(WORKSPACES_RESIDUE_QUERY) === '1';
}

/** Why `purge_workspace` accepts the workspace (`PurgeWorkspaceResultWire.reason`). A pure helper
 *  (S8 W1-A10 i18n remainder) — takes `t` from its caller. */
export function purgeWorkspaceReasonLabel(reason: PurgeWorkspaceReasonWire, t: Translate): string {
  const entry = PURGE_WORKSPACE_REASON_LABELS[reason];
  return t(entry.zh, entry.en);
}

const PURGE_WORKSPACE_REASON_LABELS: Readonly<
  Record<PurgeWorkspaceReasonWire, { readonly zh: string; readonly en: string }>
> = {
  disabled_retention_elapsed: {
    zh: `已停用满 ${WORKSPACE_PURGE_RETENTION_DAYS} 天`,
    en: `Disabled for ${WORKSPACE_PURGE_RETENTION_DAYS}+ days`,
  },
  ephemeral_expired: { zh: '临时工作区已到期', en: 'Ephemeral workspace past its expiry' },
};

/** `PurgeWorkspaceResultWire.counts` keys — the workspace-scoped tables, camel-cased by the kernel
 *  (`wireTableKey`). The cascade order of §4 first, then the rest alphabetically; a table this map
 *  does not know (the kernel derives the set from the schema) falls back to its humanized key so
 *  nothing is hidden. The wire types `counts` as a plain string record, so `tsc` cannot hold this
 *  map to the schema: `platform-workspaces.test.ts` does, reading every table with a
 *  `workspace_id` column out of the kernel's migrations (legacy 337). */
const PURGE_COUNT_LABELS = {
  capabilityHandles: { zh: 'Handle', en: 'Handle' },
  sessions: { zh: '会话', en: 'Sessions' },
  tasks: { zh: '任务', en: 'Tasks' },
  workerRuns: { zh: 'Worker 运行', en: 'Worker runs' },
  goalRuns: { zh: '目标运行', en: 'Goal runs' },
  planRevisions: { zh: '计划版本', en: 'Plan revisions' },
  stepRuns: { zh: '步骤运行', en: 'Step runs' },
  goalAcceptanceChecks: { zh: '目标验收检查', en: 'Goal acceptance checks' },
  chats: { zh: '对话', en: 'Chats' },
  chatMessages: { zh: '消息', en: 'Messages' },
  activities: { zh: '活动', en: 'Activities' },
  decisions: { zh: '决策', en: 'Decisions' },
  conflicts: { zh: '冲突', en: 'Conflicts' },
  links: { zh: '关系', en: 'Links' },
  objects: { zh: '对象', en: 'Objects' },
  sources: { zh: '来源', en: 'Sources' },
  observations: { zh: '观察', en: 'Observations' },
  evidence: { zh: '证据', en: 'Evidence' },
  auditRecords: { zh: '审计记录', en: 'Audit records' },
  principals: { zh: '成员', en: 'Principals' },
  // Legacy 337: the tables §4 does not order, under the names the console uses for them elsewhere
  // (capability labels, the navigation, the quota and profile pages).
  actionRequestReconcileChecks: { zh: '平台核对记录', en: 'Platform reconcile checks' },
  actionRequests: { zh: '动作请求', en: 'Action requests' },
  agentPolicies: { zh: '工作区策略', en: 'Agent policies' },
  agentProfiles: { zh: '智能体配置', en: 'Agent profiles' },
  capabilityGrants: { zh: '授权', en: 'Grants' },
  // S11 P1 (migrations/governance/0025): what each module install / upgrade changed — the names
  // 能力目录 · 安装历史 uses (one 安装记录 per install or upgrade, its 改动项 under it).
  changeItems: { zh: '安装记录里的改动项', en: 'Install record changes' },
  changeSegments: { zh: '安装记录', en: 'Install records' },
  connectionRequests: { zh: '连接申请', en: 'Connection requests' },
  gatekeeperPolicies: { zh: '按门的审批策略', en: 'Per-gate approval policies' },
  llmUsage: { zh: '模型用量记录', en: 'Model usage records' },
  ontologyVersions: { zh: '本体版本', en: 'Ontology versions' },
  outbox: { zh: '待投递事件', en: 'Outbox events' },
  pendingContextItems: { zh: '待告知智能体的事项', en: 'Pending context items' },
  policies: { zh: '审批策略', en: 'Approval policies' },
  procedures: { zh: '流程', en: 'Procedures' },
  quotas: { zh: '配额', en: 'Quotas' },
  skills: { zh: 'Skill', en: 'Skills' },
  turnOutcomes: { zh: '对话结果标记', en: 'Turn outcomes' },
  turnProcedureClaims: { zh: '流程使用记录', en: 'Procedure usage records' },
  workerDefinitions: { zh: 'Worker 定义', en: 'Worker definitions' },
  workerRunSkills: { zh: 'Skill 使用记录', en: 'Skill usage records' },
  workspaceGateLinks: { zh: '已启用的门实例', en: 'Enabled gate instances' },
  workspaceSelfConnections: { zh: '自己接入的门', en: 'Self-connected gates' },
} as const satisfies Readonly<Record<string, { readonly zh: string; readonly en: string }>>;

export type PurgeCountKey = keyof typeof PURGE_COUNT_LABELS;

/** Whether `key` has its own label (else `purgeCountLabel` humanizes it). */
export function isLabelledPurgeCountKey(key: string): key is PurgeCountKey {
  return ownEntry(PURGE_COUNT_LABELS, key) !== undefined;
}

export function purgeCountLabel(key: string, t: Translate): string {
  const known = ownEntry(PURGE_COUNT_LABELS, key);
  if (known !== undefined) return t(known.zh, known.en);
  const words = key
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** Why `purge_user` skipped one of the requested users (`PurgeUserOutcomeWire.reason`), as the
 *  dialog reports it next to the row. Typed on the wire enum so a new kernel reason fails `tsc`
 *  here until it has copy. A pure helper (S8 W1-A10 i18n remainder) — takes `t` from its caller. */
export function purgeUserSkipReasonLabel(reason: PurgeUserSkipReasonWire, t: Translate): string {
  const entry = PURGE_USER_SKIP_REASON_LABELS[reason];
  return t(entry.zh, entry.en);
}

const PURGE_USER_SKIP_REASON_LABELS: Readonly<
  Record<PurgeUserSkipReasonWire, { readonly zh: string; readonly en: string }>
> = {
  user_not_found: { zh: '找不到该用户', en: 'No such user' },
  activated: {
    zh: '已设置密码，是真实账户（应停用而不是清理）',
    en: 'Has a password — a real account; disable it instead',
  },
  platform_admin: { zh: '平台管理员', en: 'A platform administrator' },
  has_sessions: { zh: '曾登录过控制台', en: 'Has signed in to the console' },
  active_membership: {
    zh: '仍有未停用的成员资格（先移除，或清除其工作区）',
    en: 'Still holds a non-disabled membership — remove it, or purge the workspace',
  },
  referenced: {
    zh: '被审计或设置引用（审计只增不减）',
    en: 'Referenced by an audit or settings row — audit only grows',
  },
};
