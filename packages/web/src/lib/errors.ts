import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { LlmAdminError, llmAdminErrorMessage } from './llm-admin.js';
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
 * code name from `interfaces/ws/rpc.ts`'s `WS_ERROR_CODES`), `title` a short human label for that
 * code, `message` the kernel's own text verbatim. The UI shows all three (`ErrorBanner`) so a
 * report from the field carries the identifier and not only prose.
 */
export interface ErrorDescription {
  readonly code: string;
  readonly title: string;
  readonly message: string;
}

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
  connection_target_refused: 'Address not allowed',
  credentials_in_observe_params: 'Credentials in the parameters',
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
  connection_target_refused: '这个地址不允许接入',
  credentials_in_observe_params: '参数里带了凭据',
  unknown: '出错了',
};

/**
 * Console audit P1-1: what to do next, per stable code — the line an error banner shows as its
 * body when no page or `lib/platform-errors.ts` copy is more specific. The kernel's own text is
 * not the body any more (it is often English, names a capability, or describes the check rather
 * than the fix); it moves into the banner's 「技术细节」 disclosure with the raw code.
 *
 * Gate-side codes (`operation_refused`, `credentials_in_observe_params`, …) are listed even where
 * the kernel still relays them as `gatekeeper_error`, so the copy is ready when the code reaches
 * the console; an MCP endpoint that answers with a redirect has no code of its own yet.
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
  not_proposer: {
    zh: '只有它的提议人或工作区所有者能做这一步。',
    en: 'Only its proposer or a workspace owner can do this.',
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
    zh: '它依赖的服务暂时不可用。稍后重试；反复出现时，请平台管理员查看平台运行状态。',
    en: 'A service it depends on is unavailable. Retry later; if it keeps happening, ask a platform administrator to check the platform status.',
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
};

/**
 * An error as the console shows it (console audit P1-1): a short title, a body that says what
 * happened in the viewer's language and what to do next, and the kernel's own text plus the raw
 * code for the 「技术细节」 disclosure (`kit/error-details`). The body's sources, most specific
 * first: the page's own `overrides` for this code, `lib/platform-errors.ts`'s copy, the
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
    platformErrorMessage(err, t) ??
    llmAdminErrorMessage(err, t) ??
    transportErrorMessage(err, t) ??
    (step ? t(step.zh, step.en) : null);
  const message =
    curated ??
    t(
      '操作没有完成，原因见下方「技术细节」。',
      'This did not complete; see the technical details below.',
    );
  const raw = described.message.trim();
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

export function describeError(err: unknown): ErrorDescription {
  if (err instanceof HttpError) {
    const code = err.kind === 'capability_error' ? (err.code ?? 'unknown') : err.kind;
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
  if (err instanceof TurnAlreadyRunningError) {
    return {
      code: 'turn_already_running',
      title: CODE_TITLES.turn_already_running ?? 'Busy',
      message: err.message,
    };
  }
  if (err instanceof RpcError) {
    const code = ownEntry(RPC_CODE_NAMES, err.code) ?? `rpc_${err.code}`;
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

/** `gatekeeper_timeout` → `Gatekeeper timeout` for codes this file has no curated title for. */
function titleFromCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words.length === 0 ? 'Error' : words.charAt(0).toUpperCase() + words.slice(1);
}
