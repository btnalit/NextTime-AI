import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * lib/platform-errors: the platform plane's stable wire codes → the bilingual one-liner the
 * console shows inline for them (P-A1; `application/gateway/platform-handlers.ts`'s
 * `PlatformAdminError` union is the source of truth for the code list, and
 * `interfaces/http/auth-routes.ts` reuses three of them on `POST /api/auth/bind-api-key`).
 *
 * Same shape `BindApiKeyForm` already established for its own three codes: a mapped code renders
 * as a `field-error` next to the control that caused it, anything unmapped falls through to
 * `ErrorBanner` (which always prints the kernel's own message plus the raw code, so an unmapped
 * failure is still diagnosable from a screenshot). Never a `switch` inside a page — the users
 * page alone can raise ten of these from six different forms.
 *
 * S8 W1-A10 (i18n remainder + audit S14): every entry is `{zh, en}` now (`platformErrorMessage`
 * takes `t` and picks one), and `protected_admin` no longer names the `NEXTTIME_PLATFORM_ADMINS`
 * env var inline — an ordinary admin cannot act on it either way, and the operator who set it
 * already knows the variable's name.
 */
const PLATFORM_ERROR_MESSAGES: Readonly<
  Record<string, { readonly zh: string; readonly en: string }>
> = {
  user_not_found: { zh: '找不到该用户', en: 'No such user' },
  workspace_not_found: { zh: '找不到该工作区', en: 'No such workspace' },
  membership_not_found: {
    zh: '该用户不在这个工作区',
    en: 'That user is not a member of this workspace',
  },
  login_taken: { zh: '这个登录名已被占用', en: 'That login is already taken' },
  already_member: { zh: '已经是该工作区的成员', en: 'Already a member of that workspace' },
  already_claimed: {
    zh: '该账户已设置密码，不能被合并',
    en: 'That account already has a password — it cannot be merged',
  },
  last_admin: {
    zh: '不能停用或降级最后一个活跃管理员',
    en: 'The last active administrator cannot be disabled or demoted',
  },
  // C10 (console-completion-plan §2b): the kernel split "you cannot disable yourself" out of
  // `last_admin` into its own code; until a kernel carrying that split is deployed the older
  // `last_admin` copy above still shows, with the kernel's own `message` as the secondary line
  // (`PlatformError.tsx`) so the two cases stay distinguishable either way.
  self_disable: { zh: '不能停用自己', en: 'You cannot disable your own account' },
  last_owner: {
    zh: '不能移出或降级工作区的最后一个所有者',
    en: 'The last owner of a workspace cannot be removed or demoted',
  },
  protected_admin: {
    zh: '这是由主机环境配置指定的管理员，不能在控制台里改',
    en: 'This administrator is set by the host configuration — it cannot be changed here',
  },
  weak_password: {
    zh: '密码不满足平台的最短长度要求',
    en: 'Password is shorter than the platform minimum',
  },
  invalid_login: {
    zh: '登录名格式不合法',
    en: 'Invalid login — 3–64 chars of a-z 0-9 . _ -',
  },
  workspace_disabled: { zh: '该工作区已停用', en: 'That workspace is disabled' },
  // P-A2 (workspace configuration): the four codes the workspace capabilities add.
  user_disabled: {
    zh: '该用户已停用，不能作为所有者',
    en: 'That user is disabled and cannot be made an owner',
  },
  default_workspace: {
    zh: '默认工作区不能停用',
    en: 'The platform default workspace cannot be disabled — point the default at another workspace first',
  },
  unknown_model: { zh: '模型不在目录里', en: 'No such model in the catalog' },
  entry_model_not_allowed: {
    zh: '允许的模型列表必须包含入口模型；限制模型前要先设置入口模型',
    en: 'A non-empty allowed list must contain the entry model, and an entry model must be set before restricting',
  },
  // S6-A A1 (`purge_workspace`, console-completion-plan §5.2): the two 409s of the
  // preconditions. `default_workspace` (above) and `workspace_not_found` (top) are reused by it
  // verbatim.
  workspace_active: {
    zh: '该工作区仍在启用中，先停用（停用满 7 天后可清除）或等临时工作区到期',
    en: 'The workspace is still active — disable it first (purgeable 7 days later), or wait for an ephemeral one to expire',
  },
  retention_not_elapsed: {
    zh: '停用未满 7 天，还不能清除',
    en: 'Disabled less than 7 days ago — not purgeable yet',
  },
  // P-B1 (集成 Integrations): connectors, gate instances, external runtimes, and the workspace
  // "enable from platform catalog" flow.
  connector_not_found: { zh: '找不到该接入包', en: 'No such connector' },
  connector_mode_not_allowed: {
    zh: '通用类接入包（cli/ssh）不能设为平台预置',
    en: 'A generic cli/ssh connector cannot be set to platform preset',
  },
  gate_not_found: { zh: '找不到该门实例', en: 'No such gate instance' },
  trust_not_applicable: {
    zh: '只有 MCP 类型的实例可以设置信任级别',
    en: 'Only an MCP instance can be marked vetted',
  },
  runtime_not_found: { zh: '找不到该外部运行时会话', en: 'No such external runtime session' },
  gate_not_enabled: {
    zh: '该门实例尚未启用，工作区不能启用它',
    en: 'That gate instance is not enabled — a workspace cannot enable it',
  },
  connector_not_preset: {
    zh: '该接入包不是平台预置模式，工作区不能从目录启用它',
    en: 'That connector is not in platform-preset mode — a workspace cannot enable it from the catalog',
  },
  // P-B2a（门宿主 gate host）：管理员建实例、录入凭证的失败码。
  gate_id_taken: { zh: '这个 gate id 已被占用', en: 'That gate id is already taken' },
  gate_in_use: {
    zh: '还有工作区启用着这个实例，先禁用它们再删除',
    en: 'A workspace still has this instance enabled — disable it there first',
  },
  gate_not_hosted: {
    zh: '只有门宿主实例才能这样操作；打包的门由它自己的容器管理',
    en: 'Only a gate-host instance supports this — a packaged gate manages itself',
  },
  credential_mode_mismatch: {
    zh: '该实例不需要每人的凭证',
    en: 'This instance does not take a per-member credential',
  },
  gate_not_ready: {
    zh: '门宿主尚未接管该实例，请稍候',
    en: 'The gate host has not taken over this instance yet — wait a moment',
  },
  gate_not_linked: {
    zh: '这个工作区还没有启用该实例',
    en: 'This workspace has not enabled that instance',
  },
};

/** The bilingual message for a platform capability failure, or `null` when the code is not one of
 *  ours (a transport failure, a 403, an unmapped kernel code) and the caller should fall back to
 *  `ErrorBanner`. A pure helper, not a component — takes `t` from its caller. */
export function platformErrorMessage(err: unknown, t: Translate): string | null {
  if (!(err instanceof HttpError) || err.kind !== 'capability_error') return null;
  if (err.code === undefined) return null;
  const entry = err.code !== undefined ? PLATFORM_ERROR_MESSAGES[err.code] : undefined;
  return entry ? t(entry.zh, entry.en) : null;
}

/** The tooltip an env-listed administrator's disabled affordances carry (design §6.6: those
 *  accounts are always administrators and the page must say why it will not act on them). A pure
 *  helper, not a component — takes `t` from its caller. */
export function envAdminTitle(t: Translate): string {
  return t('由主机环境配置指定的管理员', 'Administrator set by the host configuration');
}

/** `create_user`'s login rule, mirrored client-side so the field can say so before the kernel
 *  does (`platform-handlers.ts` `LOGIN_PATTERN`). */
export const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** `create_gate_instance`'s `gateId` rule, mirrored client-side (`capabilities.ts`'s own regex on
 *  that param — becomes the instance's `GATE_ID` and its gate-host path). */
export const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
