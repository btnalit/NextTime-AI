import { PRINCIPAL_REFUSAL_REASON_VALUES, type PrincipalRefusalReason } from '@nexttime/shared';
import { HttpError } from './http-client.js';
import { type Translate, sentenceGap } from './i18n.js';
import { LlmAdminError, llmAdminErrorMessage } from './llm-admin.js';
import { LocalizedError } from './localized-error.js';
import { ownEntry } from './own.js';
import { platformErrorMessage } from './platform-errors.js';
import { RpcError, TurnAlreadyRunningError } from './ws-client.js';

/** Renders any thrown value as a user-facing string. `WsClient`'s `RpcError`/`TurnAlreadyRunningError`
 *  (lib/ws-client.ts) are both `Error` subclasses, so this covers them along with plain `Error`s
 *  and non-Error throws (e.g. a rejected promise from a fake in a test). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A thrown value normalized for display: `code` is the kernel's stable wire code (HTTP
 * `error.code` from `interfaces/http/capability-route.ts`'s `mapCapabilityError`, or the JSON-RPC
 * code name from `interfaces/ws/rpc.ts`'s `WS_ERROR_CODES`; a member-management `conflict` that names
 * its reason in `details.reason` is shown under that reason), `title` a short human label for that
 * code, `message` the kernel's own text verbatim. The UI shows all three (`ErrorBanner`) so a
 * report from the field carries the identifier and not only prose.
 */
export interface ErrorDescription {
  readonly code: string;
  readonly title: string;
  readonly message: string;
}

/** `PrincipalOperationRefusedError`'s reasons (kernel `application/gateway/members-handlers.ts`),
 *  read from the 409 `conflict`'s `details.reason` (`principalRefusalCode`). Keyed by the shared
 *  `PrincipalRefusalReason`, so a reason added there does not compile until it has a title and a
 *  next step here; spread into `CODE_TITLES`, `CODE_TITLES_ZH` and `ERROR_NEXT_STEPS` below. */
const PRINCIPAL_REFUSAL_TITLES: Readonly<Record<PrincipalRefusalReason, string>> = {
  last_owner: 'Last owner',
  self_disable: 'Cannot disable yourself',
  platform_managed: 'Managed by the platform',
  human_api_key: 'People sign in with a password',
  reserved_name: 'Name reserved',
};

const PRINCIPAL_REFUSAL_TITLES_ZH: Readonly<Record<PrincipalRefusalReason, string>> = {
  last_owner: '最后一位有效的所有者',
  self_disable: '不能停用自己',
  platform_managed: '由平台管理',
  human_api_key: '人类用户用密码登录',
  reserved_name: '名称被保留',
};

/** The platform plane's own `last_owner` / `self_disable` keep their `lib/platform-errors.ts` copy,
 *  which wins over these. */
const PRINCIPAL_REFUSAL_NEXT_STEPS: Readonly<
  Record<PrincipalRefusalReason, { readonly zh: string; readonly en: string }>
> = {
  last_owner: {
    zh: '工作区至少要保留一位有效的人类所有者，这一步会让它一个都不剩，所以什么也没有改。先把另一位成员设为所有者，再来做这一步。',
    en: 'A workspace always keeps at least one active human owner, and this would leave it with none, so nothing changed. Make another member an owner first, then do this.',
  },
  self_disable: {
    zh: '不能停用你自己，什么也没有改。确实需要的话，请另一位所有者来停用。',
    en: 'You cannot disable yourself, so nothing changed. If it is really needed, ask another owner to do it.',
  },
  platform_managed: {
    zh: '这是平台自己管理的身份（智能体，或平台内部的服务账号），不能在工作区里改角色、停用、轮换密钥或签发凭证，什么也没有改。',
    en: 'This identity is managed by the platform (an agent, or one of the platform’s internal service accounts): its role, status, key and credentials cannot be changed from a workspace, and nothing changed.',
  },
  human_api_key: {
    zh: '这是一位人类用户，人类用户用密码登录，不签发 API key，什么也没有改。要给自动化程序用的 API key，请创建一个服务账号。',
    en: 'This is a person, and people sign in with a password rather than an API key, so nothing changed. For a key an automation can use, create a service account.',
  },
  reserved_name: {
    zh: '前后各带两个下划线的显示名留给平台内部的身份，什么也没有创建。换一个名字后重新创建。',
    en: 'Display names with two underscores at each end are reserved for the platform’s internal identities, so nothing was created. Choose another name and create it again.',
  },
};

/** JSON-RPC error code → the same stable name the HTTP transport uses for the equivalent failure
 *  (`interfaces/ws/rpc.ts` `WS_ERROR_CODES`; the HTTP names come from `mapCapabilityError`). */
const RPC_CODE_NAMES: Readonly<Record<number, string>> = {
  [-32700]: 'parse_error',
  [-32600]: 'invalid_request',
  [-32601]: 'not_found',
  [-32602]: 'invalid_params',
  [-32603]: 'internal_error',
  [-32001]: 'unauthorized',
  [-32002]: 'forbidden',
  [-32003]: 'not_implemented',
  [-32004]: 'not_found',
  [-32010]: 'turn_already_running',
  [-32011]: 'illegal_transition',
  [-32012]: 'quota_exceeded',
  [-32013]: 'attenuation_denied',
  // `UPSTREAM_ERROR` stands for HTTP's `gatekeeper_error` / `gatekeeper_timeout` /
  // `manifest_fetch_failed` together; `upstreamCodeName` tells them apart by the kernel's message,
  // and this is its fallback (the one whose copy fits all three).
  [-32014]: 'gatekeeper_error',
  [-32015]: 'service_unavailable',
  [-32016]: 'worker_definition_not_enabled',
  // Legacy 320 (UX acceptance of #602): the composer's own path for text holding U+0000.
  [-32017]: 'unstorable_text',
  // Client-side only (lib/ws-client.ts `RPC_TIMEOUT_CODE`, C5): the kernel never answered.
  [-32000]: 'timeout',
};

export const CODE_TITLES: Readonly<Record<string, string>> = {
  unauthorized: 'Not signed in',
  forbidden: 'Not permitted',
  not_found: 'Not found',
  invalid_params: 'Invalid request',
  invalid_request: 'Invalid request',
  parse_error: 'Malformed message',
  not_implemented: 'Not implemented on this kernel',
  illegal_transition: 'State has changed',
  turn_already_running: 'A turn is already running',
  gatekeeper_timeout: 'Gate timed out',
  gatekeeper_error: 'Gate returned an error',
  manifest_fetch_failed: 'Manifest fetch failed',
  meta_ontology_write_forbidden: 'Not permitted',
  attenuation_denied: 'Not permitted',
  // D-24: someone else proposed this row — only its proposer or the owner may publish/deprecate.
  not_proposer: 'Not the proposer',
  not_published: 'Not published',
  invalid_step_reference: 'Invalid reference',
  unknown_quota_key: 'Unknown quota key',
  // S11 P1 / P1-B: the ChangePlan core's refusals (module installs, install record rollback).
  change_confirmation_required: 'Needs confirming item by item',
  change_plan_changed: 'Changed since you looked',
  change_segment_not_found: 'Install record not found',
  change_segment_rolled_back: 'Already rolled back',
  change_rollback_conflict: 'Cannot be rolled back now',
  quota_exceeded: 'Quota exceeded',
  internal_error: 'Kernel error',
  network: 'Network error',
  invalid_response: 'Unexpected response',
  connection_closed: 'Connection closed',
  timeout: 'No response from the kernel',
  service_unavailable: 'Service unavailable',
  conflict: 'Conflicts with existing data',
  workspace_required: 'No workspace selected',
  csrf_header_required: 'This page is out of date',
  password_change_required: 'Change your password first',
  chat_archived: 'Chat archived',
  chat_not_found: 'Chat not found',
  turn_not_found: 'Turn not found',
  no_active_turn: 'Nothing is running',
  operation_refused: 'The gate refused this call',
  invalid_input: 'Check the input',
  gate_host_error: 'Gate host error',
  connection_target_refused: 'Address not allowed',
  endpoint_already_connected: 'Already connected',
  self_connection_suspended: 'Suspended by the platform',
  credentials_in_observe_params: 'Credentials in the parameters',
  credentials_in_text: 'Credentials in the text',
  credentials_in_connection_params: 'Credentials in the address',
  operation_definition_mismatch: 'The gate runs another definition',
  operation_definition_unavailable: 'No approved definition',
  gate_owned_params: 'Declares parameters the gate sets',
  unknown_operation: 'This gate has no such operation',
  invalid_operation_name: 'Operation name not allowed',
  unstorable_text: 'Text holds a character that cannot be stored',
  gate_unreachable: 'Not sent: the gate could not be reached',
  apply_not_received: 'Did not run: the gate has no record of it running',
  outcome_unknown: 'Outcome unknown',
  worker_definition_not_enabled: 'Worker not enabled for your agent',
  endpoint_is_platform_gate: 'A platform gate is at this address',
  connector_not_self_serve: 'Cannot be connected by a workspace',
  module_not_found: 'No such module',
  pack_not_found: 'No such pack',
  not_a_draft: 'No longer a draft',
  invalid_scope: 'Scope not allowed',
  service_principal_required: 'Not an active service account',
  ontology_violation: 'The ontology does not allow this link',
  source_identity_conflict: 'Source name taken',
  image_not_allowed: 'Image not allowed',
  image_not_in_inventory: 'Image not built',
  runtime_unreachable: 'Runtime unreachable',
  no_previous_settings_version: 'Nothing to roll back to',
  depth_exceeded: 'Delegation too deep',
  concurrency_exceeded: 'Too many running at once',
  daily_cost_exceeded: 'Daily cost budget reached',
  // `PrincipalOperationRefusedError`'s reasons (`principalRefusalCode`); `last_owner` and
  // `self_disable` are platform-plane codes too.
  ...PRINCIPAL_REFUSAL_TITLES,
  unknown: 'Error',
};

/** zh half of `CODE_TITLES`, keyed the same way (add a code to both). */
export const CODE_TITLES_ZH: Readonly<Record<string, string>> = {
  unauthorized: '未登录或登录已失效',
  forbidden: '没有权限',
  not_found: '找不到',
  invalid_params: '请求参数不正确',
  invalid_request: '请求不正确',
  parse_error: '消息格式错误',
  not_implemented: '当前内核尚未支持',
  illegal_transition: '状态已变化',
  turn_already_running: '已有一轮对话在运行',
  gatekeeper_timeout: '门响应超时',
  gatekeeper_error: '门返回了错误',
  manifest_fetch_failed: '拉取清单失败',
  meta_ontology_write_forbidden: '没有权限',
  attenuation_denied: '没有权限',
  not_proposer: '不是提议人',
  not_published: '尚未发布',
  invalid_step_reference: '引用无效',
  unknown_quota_key: '未知的配额项',
  change_confirmation_required: '需要逐项确认',
  change_plan_changed: '在你查看之后有了变化',
  change_segment_not_found: '找不到这条安装记录',
  change_segment_rolled_back: '已经撤销过了',
  change_rollback_conflict: '现在不能撤销',
  quota_exceeded: '超出配额',
  internal_error: '内核出错',
  network: '网络错误',
  invalid_response: '返回内容无法识别',
  connection_closed: '连接已断开',
  timeout: '内核没有响应',
  service_unavailable: '服务暂时不可用',
  conflict: '和现有数据冲突',
  workspace_required: '还没有选择工作区',
  csrf_header_required: '页面已过期',
  password_change_required: '需要先修改密码',
  chat_archived: '对话已归档',
  chat_not_found: '找不到这段对话',
  turn_not_found: '找不到这一轮对话',
  no_active_turn: '没有正在运行的一轮',
  operation_refused: '门拒绝了这次调用',
  invalid_input: '请检查输入',
  gate_host_error: '门宿主没有完成这次写入',
  connection_target_refused: '这个地址不允许接入',
  endpoint_already_connected: '这个地址已经接入',
  self_connection_suspended: '已被平台暂停',
  credentials_in_observe_params: '参数里带了凭据',
  credentials_in_text: '文字里带了凭据',
  credentials_in_connection_params: '地址里带了凭据',
  operation_definition_mismatch: '门运行的定义和批准的不一样',
  operation_definition_unavailable: '没有批准过的定义',
  gate_owned_params: '声明了门自己设置的参数',
  unknown_operation: '这个门上没有这个动作',
  invalid_operation_name: '动作名不合规',
  unstorable_text: '文字里有存不了的字符',
  gate_unreachable: '没发出：连不上门',
  apply_not_received: '没执行：门上没有执行记录',
  outcome_unknown: '结果不明',
  worker_definition_not_enabled: '这个 Worker 没有对你的智能体启用',
  endpoint_is_platform_gate: '这个地址是平台提供的门',
  connector_not_self_serve: '这类系统不能由工作区自行接入',
  module_not_found: '找不到这个模块',
  pack_not_found: '找不到这个能力包',
  not_a_draft: '已经不是草稿',
  invalid_scope: '权限范围无效',
  service_principal_required: '不是启用中的服务账号',
  ontology_violation: '本体不允许这条关系',
  source_identity_conflict: '来源名称已被占用',
  image_not_allowed: '镜像不在允许列表里',
  image_not_in_inventory: '镜像还没有构建',
  runtime_unreachable: '连不上运行层',
  no_previous_settings_version: '没有可回滚的版本',
  depth_exceeded: '派生链太深',
  concurrency_exceeded: '同时运行的任务太多',
  daily_cost_exceeded: '今日成本已达上限',
  ...PRINCIPAL_REFUSAL_TITLES_ZH,
  unknown: '出错了',
};

/** Legacy 320 (UX acceptance of #602): the shared part of the `unstorable_text` note, after the
 *  place it names. U+0000 cannot be seen, so "remove the character" alone cannot be followed: the
 *  note says where it usually comes from and two ways to get rid of it. */
const UNSTORABLE_TEXT_WHAT = {
  zh: '有看不见的 U+0000（空字符），系统存不了它',
  en: 'holds invisible U+0000 (null) characters, which the system cannot store',
} as const;
const UNSTORABLE_TEXT_FIX = {
  zh: '它通常来自粘贴的日志、终端输出或二进制内容：删掉粘贴进来的那一段重新输入，或先粘贴到纯文本编辑器里再复制过来',
  en: 'It usually comes from pasted logs, terminal output or binary content: delete the pasted part and type it again, or paste it into a plain-text editor first and copy it from there',
} as const;
const UNSTORABLE_TEXT_STEP = {
  zh: `${UNSTORABLE_TEXT_WHAT.zh}，所以这次什么也没有写入。${UNSTORABLE_TEXT_FIX.zh}，然后重新提交。如果是 agent 的调用，它一般会改好后重新发起，不需要你处理。`,
  en: `${UNSTORABLE_TEXT_WHAT.en}, so nothing was written. ${UNSTORABLE_TEXT_FIX.en}, then send it again. If this was an agent’s call, it usually fixes it and calls again, and nothing needs you.`,
} as const;

/** Legacy 334 (UX review of #605, P3-2): the note as the chat composer shows it. The person typed
 *  the message themselves, so it names the message, not the wire param `text`, and drops the
 *  sentence about an agent's call — nobody but them sent it. */
export function composerUnstorableTextStep(t: Translate, canStrip = false): string {
  // Legacy 335 (UX review of #605, P3-3): while the draft still holds the character, the banner
  // offers 「移除看不见的字符」, so the note points at it instead of the manual workarounds.
  if (canStrip) {
    return t(
      `消息内容里${UNSTORABLE_TEXT_WHAT.zh}，所以这条消息没有发出。点「移除看不见的字符」把它去掉，检查一遍后重新发送。`,
      `The message ${UNSTORABLE_TEXT_WHAT.en}, so it was not sent. Choose “Remove invisible characters” to take it out, check the message, then send it again.`,
    );
  }
  return t(
    `消息内容里${UNSTORABLE_TEXT_WHAT.zh}，所以这条消息没有发出。${UNSTORABLE_TEXT_FIX.zh}，然后重新发送。`,
    `The message ${UNSTORABLE_TEXT_WHAT.en}, so it was not sent. ${UNSTORABLE_TEXT_FIX.en}, then send it again.`,
  );
}

/** Where the kernel's `unstorable_text` message (`@nexttime/shared` `UnstorableTextError`) says
 *  the character is: `the text at params "title" holds U+0000` names a value, `the key at …` a key.
 *  The quotes may arrive escaped (`\"`), when the message sits inside a tool result shown as
 *  JSON. A message naming no field (the whole params were one string) matches nothing. */
const UNSTORABLE_TEXT_PLACE = /\bthe (key|text) at [^"\\]*\\?"(.+?)\\?" holds U\+0000/;

/** The `unstorable_text` note for `text` (the kernel's message, or a tool result carrying it),
 *  naming the field or key it is in when the message says. */
export function unstorableTextNextStep(text: string, t: Translate): string {
  const place = UNSTORABLE_TEXT_PLACE.exec(text);
  if (!place)
    return t(`提交的文字里${UNSTORABLE_TEXT_STEP.zh}`, `The text sent ${UNSTORABLE_TEXT_STEP.en}`);
  const [, kind, path] = place;
  return kind === 'key'
    ? t(
        `键名「${path}」里${UNSTORABLE_TEXT_STEP.zh}`,
        `The key "${path}" ${UNSTORABLE_TEXT_STEP.en}`,
      )
    : t(
        `字段「${path}」里${UNSTORABLE_TEXT_STEP.zh}`,
        `The field "${path}" ${UNSTORABLE_TEXT_STEP.en}`,
      );
}

/**
 * Console audit P1-1: what to do next, per stable code — the line an error banner shows as its
 * body when no page or `lib/platform-errors.ts` copy is more specific. The kernel's own text is
 * not the body any more (it is often English, names a capability, or describes the check rather
 * than the fix); it moves into the banner's 「技术细节」 disclosure with the raw code.
 *
 * Gate-side codes (`operation_refused`, `operation_definition_mismatch`, …) reach the console with
 * the gate's own code (the kernel passes a gate's refusal through instead of 502
 * `gatekeeper_error`). `operation_definition_unavailable` is never an error code — it is the
 * prefix of an ActionRequest's failure reason, read from a tool row by `gateReasonNextStep` below.
 */
export const ERROR_NEXT_STEPS: Readonly<
  Record<string, { readonly zh: string; readonly en: string }>
> = {
  unauthorized: { zh: '请重新登录后再试。', en: 'Sign in again, then retry.' },
  forbidden: {
    zh: '你当前的角色不能做这件事。需要的话，请工作区所有者或平台管理员来处理。',
    en: 'Your role cannot do this. If it is needed, ask a workspace owner or a platform administrator.',
  },
  meta_ontology_write_forbidden: {
    zh: '平台内置的本体类型由平台维护，不能在这里修改。',
    en: 'The built-in ontology types are maintained by the platform and cannot be changed here.',
  },
  attenuation_denied: {
    zh: '申请的权限超出了你自己拥有的范围。缩小范围后再试。',
    en: 'The requested access exceeds what you hold yourself. Narrow it and retry.',
  },
  workspace_required: {
    zh: '先选择一个工作区，再重试。',
    en: 'Pick a workspace first, then retry.',
  },
  csrf_header_required: { zh: '刷新页面后再试。', en: 'Reload the page, then retry.' },
  password_change_required: {
    zh: '先修改临时密码，再继续。',
    en: 'Change your temporary password first.',
  },
  not_found: {
    zh: '它可能已被删除或改名。刷新后再试。',
    en: 'It may have been deleted or renamed. Refresh and retry.',
  },
  chat_not_found: {
    zh: '这段对话可能已被删除。回到对话列表重新打开。',
    en: 'This chat may have been deleted. Reopen it from the chat list.',
  },
  turn_not_found: {
    zh: '这一轮可能已被删除。刷新对话后再看。',
    en: 'This turn may have been deleted. Refresh the chat.',
  },
  chat_archived: {
    zh: '这段对话已归档，新开一段对话继续。',
    en: 'This chat is archived. Start a new chat to continue.',
  },
  no_active_turn: {
    zh: '这一轮已经结束，不需要再停止。',
    en: 'The turn has already finished; there is nothing to stop.',
  },
  turn_already_running: {
    zh: '等当前这一轮结束，或先停止它。',
    en: 'Wait for the current turn to finish, or stop it first.',
  },
  invalid_params: {
    zh: '提交的内容有不符合要求的地方。按「技术细节」里的说明修改后重试。',
    en: 'Something in the request does not meet the requirements. Fix it as the technical details say, then retry.',
  },
  invalid_request: {
    zh: '提交的内容有不符合要求的地方。按「技术细节」里的说明修改后重试。',
    en: 'Something in the request does not meet the requirements. Fix it as the technical details say, then retry.',
  },
  parse_error: { zh: '刷新页面后再试。', en: 'Reload the page, then retry.' },
  not_implemented: {
    zh: '当前的平台版本还不支持这个操作，升级平台后再用。',
    en: 'This platform version does not support this yet. Upgrade the platform to use it.',
  },
  illegal_transition: {
    zh: '它的状态已经变了，可能有人刚处理过。刷新后查看最新状态。',
    en: 'Its state has changed, probably because someone just acted on it. Refresh to see the latest.',
  },
  conflict: {
    zh: '和现有数据冲突，可能有人刚改过。刷新后再试。',
    en: 'This conflicts with existing data, probably a recent change. Refresh and retry.',
  },
  gatekeeper_timeout: {
    zh: '目标系统没有及时响应。稍后重试；反复出现时，请检查这个门实例的状态。',
    en: 'The target system did not answer in time. Retry later; if it keeps happening, check this gate instance.',
  },
  gatekeeper_error: {
    zh: '目标系统返回了错误。展开「技术细节」查看原因；反复出现时，请检查这个门实例的状态。',
    en: 'The target system returned an error. See the technical details; if it keeps happening, check this gate instance.',
  },
  manifest_fetch_failed: {
    zh: '拿不到接口清单。确认清单地址能访问，再重新导入。',
    en: 'The interface manifest could not be fetched. Check the manifest address is reachable, then import again.',
  },
  operation_refused: {
    zh: '门拒绝了这次调用：请求头、凭据类的查询参数和 cookie 由门自己设置，不能作为参数传入。在接口清单里去掉这个参数后重新导入。',
    en: 'The gate refused this call: headers, credential query parameters and cookies are set by the gate, not passed as parameters. Remove the parameter from the manifest and import it again.',
  },
  connection_target_refused: {
    zh: '这个地址指向平台内部网络，不能作为外部系统接入。换成外部系统的最终地址（不经过跳转）。',
    en: 'This address points into the platform network and cannot be connected. Use the external system’s final address (no redirect).',
  },
  credentials_in_observe_params: {
    zh: '参数里带了凭据，调用没有发出。不要把凭据当参数传，门会用自己配置的凭据认证。',
    en: 'The parameters carry a credential, so nothing was sent. Do not pass credentials as parameters; the gate authenticates with its own.',
  },
  // S11 GO5b: a goal's revision reason or a note, refused for a credential-looking value.
  credentials_in_text: {
    zh: '这段文字看起来带了凭据（token、key 或密码的值，或 Bearer、Authorization、name=value 这类写法），已拒绝，什么也没保存。写清发生了什么，不要写凭据的值，比如写「token 过期了」。',
    en: 'The text looks like it carries a credential (a token, key or password value, or a Bearer, Authorization or name=value form), so it was refused and nothing was saved. Say what happened without the value, for example "the token expired".',
  },
  // The fallback when no form shows it on its own field (each form says where the credential goes
  // in its own terms): no field name here, since not every place that refuses it has one.
  credentials_in_connection_params: {
    zh: '地址里带了凭据（URL 里的用户名密码，或 token、key 之类的查询参数），已拒绝，什么也没保存。地址里只写地址；凭据交给门保管，不要写进任何地址。',
    en: 'An address carries a credential (a user name and password in the URL, or a token or key in its query), so it was refused and nothing was saved. Keep addresses to the address; the credential belongs to the gate, never in an address.',
  },
  // Legacy 232 (UX acceptance of #593): an agent's request_action naming nothing the gate runs.
  // Said to the person reading the chat, not to the agent: nothing waits on them.
  unknown_operation: {
    zh: '这个门上没有这个名字的动作（或它已弃用），所以什么也没有发起，也不会进审批队列，不需要你处理。agent 一般会先查门上有哪些动作，再重新发起。如果它反复用错名字，到能力目录看这个门提供哪些 Operation；缺少需要的动作时，请构建者提议一个。',
    en: 'This gate has no operation by that name (or it is deprecated), so nothing was requested, nothing entered the approval queue, and nothing needs you. The agent usually looks up what the gate runs and requests again. If it keeps using a wrong name, check in the catalog which Operations this gate offers; if the one it needs is missing, ask a builder to propose it.',
  },
  // Legacy 232 (review #493): a new Operation name that is empty, too long or carries a hidden
  // character — refused before anything was written.
  invalid_operation_name: {
    zh: '新动作的名字为空、超过 128 个字符，或含有看不见的字符（控制字符、零宽字符、会颠倒文字方向的字符），所以没有写入任何东西。换一个只用可见字符、不超过 128 个字符的名字后重新提议。已有的动作不受影响。',
    en: 'The new operation’s name is empty, longer than 128 characters, or carries a character you cannot see (a control, zero-width or text-reversing character), so nothing was written. Propose it again under a name of visible characters, at most 128 long. Existing operations are not affected.',
  },
  // Legacy 320: U+0000 in a name, an id or a setting — refused before anything was written. The
  // same note serves a form the person sent and an agent's call shown in the chat. This is the
  // wording when the error names no field; `unstorableTextNextStep` says which one when it does.
  unstorable_text: {
    zh: `提交的文字里${UNSTORABLE_TEXT_STEP.zh}`,
    en: `The text sent ${UNSTORABLE_TEXT_STEP.en}`,
  },
  // Legacy K (review of #538, G3).
  operation_definition_mismatch: {
    zh: '门现在运行的定义和这次调用批准的那一版不一样，调用没有执行。平台提供的系统：先由平台管理员在「集成」采用门的新清单；再在「系统与授权」打开它，点「与门公告对齐」，到能力目录发布打开的修订草稿，然后重新发起。自己接入的门：在「系统与授权」打开它，点「重新读取门的清单」，到能力目录发布打开的修订草稿，然后重新发起。如果门运行的新定义声明了只能由门自己设置的参数，修订发布不了，要等门的维护者去掉这些参数。',
    en: 'The gate now runs a different definition from the one this call was approved under, so nothing ran. For a platform-provided system: first a platform admin adopts the gate’s new manifest under Integrations; then open the system in Systems, choose “Align with the gate’s announcement”, publish the revision draft it opens in the catalog, and request again. For a gate you connected yourself: open it in Systems, choose “Re-read the gate’s manifest”, publish the revision draft it opens in the catalog, and request again. If the new definition the gate runs declares params only the gate sets, its revision cannot be published until the gate’s maintainer drops them.',
  },
  operation_definition_unavailable: {
    zh: '发起请求时这个 Operation 还没有发布，也没有草稿，所以批准时没有对应的定义，调用没有执行。先在能力目录发布它，再重新发起。',
    en: 'When this was requested the Operation was neither published nor drafted, so no definition was approved and nothing ran. Publish it in the catalog first, then request again.',
  },
  // Console G4: a gate's own draft is fixed in the gate's manifest, not here — the old copy said
  // "remove them from the parameters and publish again", which no console form can do.
  gate_owned_params: {
    zh: '这个 Operation 声明了只能由门自己设置的参数（说明调用者或去向的请求头、查询参数里的凭据、cookie，或调用地址已经固定的查询参数），门每次都会拒绝，所以没有发布。要门的维护者从门的清单里去掉它们：去掉后到「系统与授权」打开这个系统，平台提供的系统点「与门公告对齐」，工作区自己接入的系统点「重新读取门的清单」，重写草稿再发布。',
    en: 'This Operation declares params only the gate sets (a header saying who calls or where the call goes, a credential in the query, a cookie, or a query parameter the call address fixes); the gate would refuse every call, so it was not published. The gate’s maintainer has to drop them from the gate’s manifest: then open the system under Systems & access — “Align with the gate’s announcement” for a platform-provided system, “Re-read the gate’s manifest” for one the workspace connected itself — to rewrite the draft, and publish it.',
  },
  // Legacy 287: an ActionRequest's failure reason says whether the call left the platform. The
  // first two ran nothing and may be requested again; the third may have run.
  gate_unreachable: {
    zh: '这次调用没有发出：连不上这个系统的门，门上什么都没有执行。门恢复后可以重新发起；反复出现时，请检查这个门实例的状态。',
    en: 'This call was not sent: the system’s gate could not be reached, so nothing ran. Request it again once the gate is back; if it keeps happening, check this gate instance.',
  },
  apply_not_received: {
    zh: '门上没有这次请求执行过的记录，所以什么都没跑。仍然需要的话，重新发起。',
    en: 'The gate has no record of this request having run, so nothing ran. Request it again if it is still wanted.',
  },
  outcome_unknown: {
    zh: '这个动作可能已经执行，也可能没有，平台无法确认。不要直接重试：先到目标系统核对它是否生效，再决定要不要重新发起。',
    en: 'This action may or may not have run, and the platform cannot tell which. Do not just retry: check on the target system whether it took effect, then decide whether to request it again.',
  },
  // Legacy 315: the kernel also refuses a publish that would supersede a live version someone
  // else proposed — then "its proposer" is the caller, so the sentence names both cases.
  not_proposer: {
    zh: '这一步只能由提议人或工作区所有者来做：这一项，或它要替换的现行版本，是别人提议的。请那位提议人或工作区所有者来操作。',
    en: 'Only the proposer or a workspace owner can do this: this item, or the live version it would replace, was proposed by someone else. Ask that proposer or a workspace owner.',
  },
  not_published: { zh: '先发布，再做这一步。', en: 'Publish it first.' },
  invalid_step_reference: {
    zh: '有步骤引用了不存在的步骤。检查后再保存。',
    en: 'A step refers to a step that does not exist. Check and save again.',
  },
  unknown_quota_key: {
    zh: '这个配额项不存在。刷新页面后重新选择。',
    en: 'No such quota key. Reload the page and choose again.',
  },
  quota_exceeded: {
    zh: '已经达到配额上限。请工作区所有者调整配额，或等配额周期重置。',
    en: 'The quota is used up. Ask a workspace owner to raise it, or wait for the period to reset.',
  },
  service_unavailable: {
    zh: '它依赖的服务暂时不可用，或者它要读的文件坏了。稍后重试；反复出现时，请平台管理员查看平台运行状态和服务日志。',
    en: 'A service it depends on is unavailable, or a file it reads is broken. Retry later; if it keeps happening, ask a platform administrator to check the platform status and the service logs.',
  },
  internal_error: {
    zh: '平台内部出错了。稍后重试；反复出现时，把「技术细节」发给平台管理员。',
    en: 'The platform hit an internal error. Retry later; if it keeps happening, send the technical details to a platform administrator.',
  },
  timeout: {
    zh: '平台没有及时响应。检查网络后重试。',
    en: 'The platform did not answer in time. Check the network and retry.',
  },
  connection_closed: {
    zh: '和平台的连接断了。刷新页面重新连接。',
    en: 'The connection to the platform closed. Reload the page to reconnect.',
  },
  // Legacy 333 (UX review of #605, P3-1): the caller's own AgentProfile excludes the Worker. The
  // profile is the person's own preference, so the person is the one who turns it back on.
  worker_definition_not_enabled: {
    zh: '你在「我的智能体」里排除了这个 Worker，智能体不能委派给它，这次什么也没有创建。需要它的话，到「我的智能体」的「Worker 定义」里重新勾选并保存，然后重新发起。',
    en: 'You excluded this Worker in My Agent, so your agent cannot delegate to it and nothing was created. If you need it, tick it again under Worker definitions in My Agent, save, and request again.',
  },
  // Sweep of kernel codes with no console copy (legacy 333 follow-up): each says what was refused,
  // that nothing was written, and who acts next and where.
  endpoint_is_platform_gate: {
    zh: '这个地址是平台已经提供的门实例，工作区不能自己再接入一遍，什么也没有保存。到能力目录启用这个平台门；在那里看不到它时，请平台管理员处理。',
    en: 'This address belongs to a gate instance the platform already provides; a workspace cannot connect it again itself, and nothing was saved. Enable that platform gate from the catalog; if it is not there, ask a platform administrator.',
  },
  connector_not_self_serve: {
    zh: '平台目前不允许工作区自己接入这类系统（平台管理员关闭了它，或改由平台提供），什么也没有保存。平台提供的话，到能力目录启用它的门实例；否则请平台管理员在「集成」里开放。',
    en: 'The platform does not let a workspace connect this kind of system itself right now (a platform administrator turned it off, or provides it as a preset), and nothing was saved. If the platform provides it, enable one of its gate instances from the catalog; otherwise ask a platform administrator to allow it under Integrations.',
  },
  module_not_found: {
    zh: '这个平台部署的模块索引里没有它，什么也没有改。刷新页面后重新选择；仍然需要它时，请平台管理员确认部署里带了这个模块。',
    en: 'This deployment’s module index does not carry it, and nothing changed. Reload the page and choose again; if it is still needed, ask a platform administrator to check the deployment ships this module.',
  },
  // S11 P1-C: `preview_pack_install` / `install_pack` named a pack this deployment does not ship.
  pack_not_found: {
    zh: '这个平台部署附带的能力包里没有它，什么也没有改。刷新页面后重新选择；仍然需要它时，请平台管理员确认部署里带了这个能力包。',
    en: 'This deployment ships no such pack, and nothing changed. Reload the page and choose again; if it is still needed, ask a platform administrator to check the deployment ships this pack.',
  },
  not_a_draft: {
    zh: '它已经发布或弃用了，只有草稿才能丢弃，什么也没有改。刷新后查看它现在的状态。',
    en: 'It has been published or deprecated meanwhile; only a draft can be discarded, and nothing changed. Refresh to see its current state.',
  },
  invalid_scope: {
    zh: '申请的权限范围里有不存在的能力，或只能由人在控制台使用的能力，什么也没有签发。刷新页面，重新选择范围后再试。',
    en: 'The requested scope names a capability that does not exist, or one only a person can use in the console, so nothing was issued. Reload the page, choose the scope again, and retry.',
  },
  service_principal_required: {
    zh: '外部运行时凭证只能签发给启用中的服务账号；这个身份是人类用户、智能体，或已停用，什么也没有签发。选一个启用中的服务账号，或先创建一个。',
    en: 'An external-runtime credential can only be issued to an active service account; this one is a person, an agent, or disabled, so nothing was issued. Pick an active service account, or create one first.',
  },
  ontology_violation: {
    zh: '工作区已发布的本体没有声明这种关系，或不允许它连接这两类对象，所以没有写入。到「图谱」查看本体允许的关系类型；需要新的关系类型时，请构建者提议本体修订。',
    en: 'The workspace’s published ontology does not declare this link type, or does not let it join these two kinds of object, so nothing was written. Check the link types the ontology allows under Graph; if a new one is needed, ask a builder to propose an ontology revision.',
  },
  source_identity_conflict: {
    zh: '同一类型下已经有一个同名的来源（别人的，或可见范围不同），什么也没有创建。换一个名称后重新注册。',
    en: 'A Source of this kind with that name already exists (someone else’s, or with the other visibility), so nothing was created. Register it again under another name.',
  },
  // The three `QuotaExceededError` codes (HTTP 429; WS `quota_exceeded` above), each naming the
  // quota the 「模型与配额」 page edits under the same label (`lib/quotas.ts`).
  depth_exceeded: {
    zh: 'Worker 一层层委派下去，超过了工作区的「派生链深度上限」，这次没有创建任务。让智能体少嵌套几层后重新发起，或请工作区所有者在「模型与配额」调高这个上限。',
    en: 'Workers delegating to Workers went past the workspace’s max delegation depth, so no task was created. Have the agent nest less and request again, or ask a workspace owner to raise the limit under Models.',
  },
  concurrency_exceeded: {
    zh: '你同时在运行的 Worker 任务已经达到工作区的「每用户并发 WorkerRun 数」，这次没有创建任务。等一些任务结束（可以在「任务」里查看或取消），或请工作区所有者在「模型与配额」调高这个上限。',
    en: 'You already have as many Worker tasks running as the workspace’s concurrent WorkerRuns per user allows, so no task was created. Wait for some to finish (see or cancel them under Tasks), or ask a workspace owner to raise the limit under Models.',
  },
  daily_cost_exceeded: {
    zh: '工作区今天的花费已经达到「每工作区日成本」，这次没有创建任务。等预算按天重置后再试；急需的话，请工作区所有者在「模型与配额」调高它。',
    en: 'The workspace’s spending today has reached its daily cost budget, so no task was created. Retry once the budget resets for the next day; if it cannot wait, ask a workspace owner to raise it under Models.',
  },
  ...PRINCIPAL_REFUSAL_NEXT_STEPS,
};

/**
 * An error as the console shows it (console audit P1-1): a short title, a body that says what
 * happened in the viewer's language and what to do next, and the kernel's own text plus the raw
 * code for the 「技术细节」 disclosure (`kit/error-details`). The body's sources, most specific
 * first: the page's own `overrides` for this code, a sentence the console wrote itself
 * (`lib/localized-error`), `lib/platform-errors.ts`'s copy, the model proxy's copy, the
 * transport sentence, `ERROR_NEXT_STEPS`; for an unknown code with none of those, a line that
 * points at the technical details.
 */
export interface PresentedError {
  readonly code: string;
  readonly title: string;
  readonly message: string;
  /** The kernel's (or browser's) own text, for the technical details; null when empty or when
   *  it says nothing the body does not. */
  readonly raw: string | null;
  /** Whether `message` is copy written for this code (false: the generic pointer at the
   *  technical details). */
  readonly curated: boolean;
}

export type ErrorOverrides = Readonly<Record<string, string>>;

export function presentError(
  err: unknown,
  t: Translate,
  overrides?: ErrorOverrides,
): PresentedError {
  const described = describeError(err);
  const step = ownEntry(ERROR_NEXT_STEPS, described.code);
  const curated =
    (overrides ? ownEntry(overrides, described.code) : undefined) ??
    (err instanceof LocalizedError ? err.message : null) ??
    platformErrorMessage(err, t) ??
    llmAdminErrorMessage(err, t) ??
    transportErrorMessage(err, t) ??
    (described.code === 'unstorable_text'
      ? unstorableTextNextStep(described.message, t)
      : step
        ? t(step.zh, step.en)
        : null);
  const message =
    curated ??
    t(
      '操作没有完成，原因见下方「技术细节」。',
      'This did not complete; see the technical details below.',
    );
  // A console-written sentence is the body itself; only its underlying detail goes in the fold.
  const raw = (err instanceof LocalizedError ? (err.detail ?? '') : described.message).trim();
  return {
    code: described.code,
    title: localizedErrorTitle(described, t),
    message,
    raw: raw.length > 0 && raw !== message && raw !== described.title ? raw : null,
    curated: curated !== null,
  };
}

/** One line for a toast, which has no room for the 「技术细节」 disclosure: the readable body,
 *  else the kernel's own text, with the code in brackets so a report still names it. */
export function errorToastText(err: unknown, t: Translate, overrides?: ErrorOverrides): string {
  const shown = presentError(err, t, overrides);
  return `${shown.curated ? shown.message : (shown.raw ?? shown.message)} (${shown.code})`;
}

/** Gate refusals a tool call's result can name (`request_action`'s failure reason, an observe
 *  call's error) — the codes the reason starts with or the result carries. Legacy 287 adds what a
 *  failed `request_action` says about delivery: not sent (`gate_unreachable`,
 *  `apply_not_received`) or outcome unknown (`outcome_unknown`). Legacy 320 adds a call refused
 *  for U+0000 (`unstorable_text`). */
const GATE_REASON_CODES = [
  'operation_definition_mismatch',
  'operation_definition_unavailable',
  'operation_refused',
  'credentials_in_observe_params',
  'unknown_operation',
  'invalid_operation_name',
  'unstorable_text',
  'gate_unreachable',
  'apply_not_received',
  'outcome_unknown',
] as const;
const GATE_REASON_PATTERN = new RegExp(`\\b(${GATE_REASON_CODES.join('|')})\\b`);
/** One of those codes as the value of a `reason` or `code` field — `{"status":"failed","reason":
 *  "gate_unreachable: …"}`, `{"error":{"code":"…"}}` — also inside a JSON string (pi's
 *  `content[0].text`, where the quotes are escaped). */
const GATE_REASON_FIELD_PATTERN = new RegExp(
  // `\x22` is `"` — kept out of the literal so text scanners (the i18n-pairs guard) see no quotes.
  `\\\\?\\x22(?:reason|code)\\\\?\\x22\\s*:\\s*\\\\?\\x22(?:${GATE_REASON_CODES.join('|')})\\b`,
);

/** Legacy 224 ③: whether a tool result carries a gate reason as its outcome — the field a refusal
 *  or a failed action reports it in — rather than merely mentioning a code somewhere in a
 *  successful result (a log line, a document about the codes). */
export function carriesGateReason(text: string): boolean {
  return GATE_REASON_FIELD_PATTERN.test(text);
}

/** Reasons that say nothing about the system the call went to (UX acceptance of #602, P2-3): U+0000
 *  in the call's own text is refused by the kernel before any system is asked, so a link to the
 *  system would point the reader at the wrong place. */
const NOT_ABOUT_THE_SYSTEM: ReadonlySet<string> = new Set(['unstorable_text']);

/** How loud each reason's note is (UX acceptance of #586): not sent ran nothing and may be
 *  requested again, so it is a plain note; outcome unknown may have run, and a blind retry can
 *  do it twice, so it is the loudest; the gate's refusals ask for care. */
const GATE_REASON_TONES: Readonly<Record<string, 'info' | 'warn' | 'danger'>> = {
  gate_unreachable: 'info',
  apply_not_received: 'info',
  outcome_unknown: 'danger',
};

/** What to do about a gate refusal a tool call's result names (review of #538, G3) — the chat's
 *  tool row shows it above the raw result, which stays as the agent saw it. `target` names what
 *  the call did (`lib/action-outcome`'s `actionTargetLabel`, "container.restart（name: media）")
 *  and `system` the system (gate) it went to, so an outcome-unknown note says what to check and
 *  where — one Operation name can exist on two systems. `null` for any other result. */
/** UX acceptance of #612 (P2-4): `operation_definition_mismatch` said for the one kind of gate the
 *  call went to, when the reader knows which (the chat's tool row reads whether the system is linked
 *  to a platform gate instance) — the generic note above covers both for when it does not. */
export function definitionMismatchStep(source: 'platform' | 'self', t: Translate): string {
  return source === 'platform'
    ? t(
        '门现在运行的定义和这次调用批准的那一版不一样，调用没有执行。这是平台提供的系统：先由平台管理员在「集成」采用门的新清单；再在「系统与授权」打开它，点「与门公告对齐」，到能力目录发布打开的修订草稿，然后重新发起。如果门运行的新定义声明了只能由门自己设置的参数，修订发布不了，要等门的维护者去掉这些参数。',
        'The gate now runs a different definition from the one this call was approved under, so nothing ran. This is a platform-provided system: first a platform admin adopts the gate’s new manifest under Integrations; then open the system in Systems, choose “Align with the gate’s announcement”, publish the revision draft it opens in the catalog, and request again. If the new definition the gate runs declares params only the gate sets, its revision cannot be published until the gate’s maintainer drops them.',
      )
    : t(
        '门现在运行的定义和这次调用批准的那一版不一样，调用没有执行。这是工作区自己接入的门：打开这个系统，在「门的清单」点「重新读取门的清单」，到能力目录发布打开的修订草稿，然后重新发起。如果门运行的新定义声明了只能由门自己设置的参数，修订发布不了，要等门的维护者去掉这些参数。',
        'The gate now runs a different definition from the one this call was approved under, so nothing ran. This is a gate the workspace connected itself: open the system, choose “Re-read the gate’s manifest” under its manifest section, publish the revision draft it opens in the catalog, and request again. If the new definition the gate runs declares params only the gate sets, its revision cannot be published until the gate’s maintainer drops them.',
      );
}

export function gateReasonNextStep(
  text: string,
  t: Translate,
  target?: string,
  system?: string,
): {
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly tone: 'info' | 'warn' | 'danger';
  /** Whether the system the call went to is where to look (the tool row links it). */
  readonly aboutTheSystem: boolean;
} | null {
  const code = GATE_REASON_PATTERN.exec(text)?.[1];
  if (code === undefined) return null;
  const step = ownEntry(ERROR_NEXT_STEPS, code);
  if (!step) return null;
  const message =
    code === 'outcome_unknown' && (target !== undefined || system !== undefined)
      ? outcomeUnknownStep(t, target, system)
      : code === 'unstorable_text'
        ? unstorableTextNextStep(text, t)
        : t(step.zh, step.en);
  return {
    code,
    title: t(ownEntry(CODE_TITLES_ZH, code) ?? code, ownEntry(CODE_TITLES, code) ?? code),
    message: withPlaintextTlsHint(message, text, t),
    tone: ownEntry(GATE_REASON_TONES, code) ?? 'warn',
    aboutTheSystem: !NOT_ABOUT_THE_SYSTEM.has(code),
  };
}

/** TLS record-layer errors a peer that does not speak TLS raises (which one depends on the OpenSSL
 *  version). Since legacy 287 they read as "may have been delivered" — the same error can come
 *  from plain text written into an established session — so the note adds the usual cause
 *  (#501's review of #586). */
const PLAINTEXT_TLS = /\bERR_SSL_(?:WRONG_VERSION_NUMBER|PACKET_LENGTH_TOO_LONG)\b/;

/** `message`, followed by the usual cause when `text` (a failure reason) names a TLS record-layer
 *  error. */
export function withPlaintextTlsHint(
  message: string,
  text: string | null | undefined,
  t: Translate,
): string {
  if (!text || !PLAINTEXT_TLS.test(text)) return message;
  return `${message}${sentenceGap(t)}${t(
    '常见原因：https 地址指到了只讲明文 HTTP 的端口。',
    'A common cause: an https address pointing at a port that only speaks plain HTTP.',
  )}`;
}

/** The outcome-unknown next step naming what to check (`target`) and where (`system`). */
function outcomeUnknownStep(t: Translate, target?: string, system?: string): string {
  const whereZh = system !== undefined ? `系统「${system}」` : '目标系统';
  const whereEn = system !== undefined ? `the system "${system}"` : 'the target system';
  const whatZh =
    target !== undefined ? ` ${target}${target.endsWith('）') ? '' : ' '}是否已生效` : '它是否生效';
  return t(
    `这个动作可能已经执行，也可能没有，平台无法确认。不要直接重试：先到${whereZh}核对${whatZh}，再决定要不要重新发起。`,
    `This action may or may not have run, and the platform cannot tell which. Do not just retry: check on ${whereEn} whether ${target ?? 'it'} took effect, then decide whether to request it again.`,
  );
}

/** The error's short title in the viewer's language. Known codes use the curated tables; an
 *  unknown code reads `出错了` in Chinese (the raw code is shown next to it either way) and the
 *  derived English label in English. */
export function localizedErrorTitle(described: ErrorDescription, t: Translate): string {
  const zh = ownEntry(CODE_TITLES_ZH, described.code);
  return t(zh ?? '出错了', described.title);
}

/** The bilingual sentence for a transport failure the browser itself reported (`fetch` threw, so
 *  the text is the browser's own English such as "Failed to fetch"), or for a body that was not
 *  the kernel's JSON (usually a proxy or gateway error page). `null` for anything else — kernel
 *  codes are `lib/platform-errors.ts`'s job. The raw text stays visible as the banner's muted line. */
export function transportErrorMessage(err: unknown, t: Translate): string | null {
  if (!(err instanceof HttpError)) return null;
  if (err.kind === 'network') {
    return t(
      '浏览器没有收到控制台服务的响应。检查网络连接，或确认服务正在运行，然后重试',
      'The browser got no response from the console service. Check the network connection or that the service is running, then retry',
    );
  }
  if (err.kind === 'invalid_response') {
    return t(
      '控制台服务返回的内容无法识别，可能是中间的代理或网关返回了错误页。稍后重试，仍然出现请查看服务日志',
      'The console service returned something unrecognizable, probably an error page from a proxy or gateway in between. Retry shortly; if it persists, check the service logs',
    );
  }
  return null;
}

/** Legacy 336 (review #493, recorded in #605): which of HTTP's three codes a WS `UPSTREAM_ERROR`
 *  (-32014) stands for, read off the kernel's message (`interfaces/ws/rpc.ts`): a manifest fetch
 *  says `<capability>: failed to fetch manifestSource …` (`ConnectionManifestFetchError`), a gate
 *  timeout `gatekeeper client: <path> timed out after <n>ms` (`GatekeeperTimeoutError`), and a gate
 *  error starts with the gate's own code instead. Anything else keeps the copy that fits all three. */
const MANIFEST_FETCH_FAILED_MESSAGE = /^[^\s:]+: failed to fetch manifestSource\b/;
const GATEKEEPER_TIMEOUT_MESSAGE = /^gatekeeper client: \S+ timed out after \d+ ?ms\b/;

function upstreamCodeName(message: string): string {
  if (MANIFEST_FETCH_FAILED_MESSAGE.test(message)) return 'manifest_fetch_failed';
  if (GATEKEEPER_TIMEOUT_MESSAGE.test(message)) return 'gatekeeper_timeout';
  return 'gatekeeper_error';
}

/** The kernel's `PrincipalOperationRefusedError` reasons, sent as 409 `conflict` with
 *  `details.reason`. */
const PRINCIPAL_REFUSAL_REASONS: ReadonlySet<string> = new Set<string>(
  PRINCIPAL_REFUSAL_REASON_VALUES,
);

/** A member-management refusal's own reason as the code to show, so it reads as what it is rather
 *  than a generic conflict; `undefined` for any other `conflict` (or a kernel too old to send it). */
function principalRefusalCode(err: HttpError): string | undefined {
  if (err.code !== 'conflict') return undefined;
  const reason = err.details?.reason;
  return typeof reason === 'string' && PRINCIPAL_REFUSAL_REASONS.has(reason) ? reason : undefined;
}

export function describeError(err: unknown): ErrorDescription {
  if (err instanceof HttpError) {
    const code =
      err.kind === 'capability_error'
        ? (principalRefusalCode(err) ?? err.code ?? 'unknown')
        : err.kind;
    return {
      code,
      title: ownEntry(CODE_TITLES, code) ?? titleFromCode(code),
      message: err.message,
    };
  }
  // The model proxy's admin API (lib/llm-admin.ts) has its own stable codes.
  if (err instanceof LlmAdminError) {
    return {
      code: err.code,
      title: ownEntry(CODE_TITLES, err.code) ?? 'Model proxy error',
      message: err.message,
    };
  }
  // The console's own sentence (lib/localized-error); `presentError` shows it as the body.
  if (err instanceof LocalizedError) {
    return {
      code: err.code,
      title: ownEntry(CODE_TITLES, err.code) ?? titleFromCode(err.code),
      message: err.message,
    };
  }
  if (err instanceof TurnAlreadyRunningError) {
    return {
      code: 'turn_already_running',
      title: CODE_TITLES.turn_already_running ?? 'Busy',
      message: err.message,
    };
  }
  if (err instanceof RpcError) {
    const code =
      err.code === -32014
        ? upstreamCodeName(err.message)
        : (ownEntry(RPC_CODE_NAMES, err.code) ?? `rpc_${err.code}`);
    return {
      code,
      title: ownEntry(CODE_TITLES, code) ?? titleFromCode(code),
      message: err.message,
    };
  }
  const message = errorMessage(err);
  if (/^WsClient: /.test(message)) {
    return { code: 'connection_closed', title: 'Connection closed', message };
  }
  return { code: 'unknown', title: 'Error', message };
}

/** Whether `err` is the kernel's 403 (role/scope) — used to hide owner-/operator-only affordances
 *  rather than keep offering a button that can only fail. */
export function isForbiddenError(err: unknown): boolean {
  return describeError(err).code === 'forbidden';
}

/** Review #493 on #583: the Operation draft acted on was revised in place since it was read
 *  (`draftDigest`) — nothing was written, and the reader needs the current one. */
export function isDraftChangedError(err: unknown): boolean {
  return describeError(err).code === 'draft_changed';
}

/** Legacy 300: a publish / install named the version the reader reviewed, and a newer one is there
 *  now (`version_changed`) — nothing was written, and the reader needs the current one. */
export function isVersionChangedError(err: unknown): boolean {
  return describeError(err).code === 'version_changed';
}

/** `gatekeeper_timeout` → `Gatekeeper timeout` for codes this file has no curated title for. */
function titleFromCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words.length === 0 ? 'Error' : words.charAt(0).toUpperCase() + words.slice(1);
}
