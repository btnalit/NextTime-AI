import { HttpError } from './http-client.js';

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
 */
const PLATFORM_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  user_not_found: '找不到该用户 No such user',
  workspace_not_found: '找不到该工作区 No such workspace',
  membership_not_found: '该用户不在这个工作区 That user is not a member of this workspace',
  login_taken: '这个登录名已被占用 That login is already taken',
  already_member: '已经是该工作区的成员 Already a member of that workspace',
  already_claimed:
    '该账户已设置密码，不能被合并 That account already has a password — it cannot be merged',
  last_admin:
    '不能停用或降级最后一个活跃管理员 The last active administrator cannot be disabled or demoted',
  last_owner:
    '不能移出或降级工作区的最后一个 owner The last owner of a workspace cannot be removed or demoted',
  protected_admin:
    '环境配置的管理员 Administrator by environment configuration — NEXTTIME_PLATFORM_ADMINS',
  weak_password: '密码不满足平台的最短长度要求 Password is shorter than the platform minimum',
  invalid_login: '登录名格式不合法 Invalid login — 3–64 chars of a-z 0-9 . _ -',
  workspace_disabled: '该工作区已停用 That workspace is disabled',
  // P-A2 (workspace configuration): the four codes the workspace capabilities add.
  user_disabled: '该用户已停用，不能作为 owner That user is disabled and cannot be made an owner',
  default_workspace:
    '默认工作区不能停用 The platform default workspace cannot be disabled — point the default at another workspace first',
  unknown_model: '模型不在目录里 No such model in the catalog',
  entry_model_not_allowed:
    '允许的模型列表必须包含入口模型；限制模型前要先设置入口模型 A non-empty allowed list must contain the entry model, and an entry model must be set before restricting',
  // P-B1 (集成 Integrations): connectors, gate instances, external runtimes, and the workspace
  // "enable from platform catalog" flow.
  connector_not_found: '找不到该接入包 No such connector',
  connector_mode_not_allowed:
    '通用类接入包（cli/ssh）不能设为平台预置 A generic cli/ssh connector cannot be set to platform preset',
  gate_not_found: '找不到该门实例 No such gate instance',
  trust_not_applicable:
    '只有 MCP 类型的实例可以设置信任级别 Only an MCP instance can be marked vetted',
  runtime_not_found: '找不到该外部运行时会话 No such external runtime session',
  gate_not_enabled:
    '该门实例尚未启用，工作区不能启用它 That gate instance is not enabled — a workspace cannot enable it',
  connector_not_preset:
    '该接入包不是平台预置模式，工作区不能从目录启用它 That connector is not in platform-preset mode — a workspace cannot enable it from the catalog',
  // P-B2a（门宿主 gate host）：管理员建实例、录入凭证的失败码。
  gate_id_taken: '这个 gate id 已被占用 That gate id is already taken',
  gate_in_use:
    '还有工作区启用着这个实例，先禁用它们再删除 A workspace still has this instance enabled — disable it there first',
  gate_not_hosted:
    '只有门宿主实例才能这样操作；打包的门由它自己的容器管理 Only a gate-host instance supports this — a packaged gate manages itself',
  credential_mode_mismatch:
    '该实例不需要每人的凭证 This instance does not take a per-member credential',
  gate_not_ready:
    '门宿主尚未接管该实例，请稍候 The gate host has not taken over this instance yet — wait a moment',
  gate_not_linked: '这个工作区还没有启用该实例 This workspace has not enabled that instance',
};

/** The bilingual message for a platform capability failure, or `null` when the code is not one of
 *  ours (a transport failure, a 403, an unmapped kernel code) and the caller should fall back to
 *  `ErrorBanner`. */
export function platformErrorMessage(err: unknown): string | null {
  if (!(err instanceof HttpError) || err.kind !== 'capability_error') return null;
  if (err.code === undefined) return null;
  return PLATFORM_ERROR_MESSAGES[err.code] ?? null;
}

/** The tooltip an env-listed administrator's disabled affordances carry (design §6.6: those
 *  accounts are always administrators and the page must say why it will not act on them). */
export const ENV_ADMIN_TITLE = '环境配置的管理员 Administrator by environment configuration';

/** `create_user`'s login rule, mirrored client-side so the field can say so before the kernel
 *  does (`platform-handlers.ts` `LOGIN_PATTERN`). */
export const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** `create_gate_instance`'s `gateId` rule, mirrored client-side (`capabilities.ts`'s own regex on
 *  that param — becomes the instance's `GATE_ID` and its gate-host path). */
export const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
