import type {
  PlatformWorkspaceWire,
  PurgeUserSkipReasonWire,
  PurgeWorkspaceReasonWire,
  UserWire,
} from '@nexttime/shared';
import type { Translate } from './i18n.js';
import { hrefs } from './router.js';

export interface WorkspaceOption {
  readonly id: string;
  readonly name: string;
}

/**
 * lib/platform-workspaces: the workspace picker's option list for the users page (P-A1) —
 * the union of every `memberships[].{workspaceId, workspaceName}` across the loaded users, plus
 * the platform default workspace when it is not already among them.
 *
 * There is deliberately no `list_workspaces` call here. P-A2 added that capability (and
 * `PlatformWorkspacesPage` reads it), but the users page's own pickers still derive their options
 * from the loaded directory: swapping them onto `list_workspaces` is a behaviour change to a
 * shipped, tested page rather than part of P-A2's deliverable. Every picker built on this list
 * therefore still also accepts a typed workspace id — a brand-new workspace nobody is a member of
 * yet is reachable that way.
 */
export function deriveWorkspaceOptions(
  users: readonly UserWire[],
  defaultWorkspaceId: string | null,
): readonly WorkspaceOption[] {
  const byId = new Map<string, string>();
  for (const user of users) {
    for (const membership of user.memberships) {
      if (!byId.has(membership.workspaceId))
        byId.set(membership.workspaceId, membership.workspaceName);
    }
  }
  if (defaultWorkspaceId !== null && !byId.has(defaultWorkspaceId)) {
    byId.set(defaultWorkspaceId, defaultWorkspaceId);
  }
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

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
 *  (`wireTableKey`). The cascade order of §4 in labels; a table this map does not know (the
 *  kernel derives the set from the schema) falls back to its humanized key so nothing is hidden. */
const PURGE_COUNT_LABELS: Readonly<Record<string, { readonly zh: string; readonly en: string }>> = {
  capabilityHandles: { zh: 'Handle', en: 'Handle' },
  sessions: { zh: '会话', en: 'Sessions' },
  tasks: { zh: '任务', en: 'Tasks' },
  workerRuns: { zh: 'Worker 运行', en: 'Worker runs' },
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
};

export function purgeCountLabel(key: string, t: Translate): string {
  const known = PURGE_COUNT_LABELS[key];
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
