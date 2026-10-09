import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { ownEntry } from './own.js';
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
  unknown: '出错了',
};

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
