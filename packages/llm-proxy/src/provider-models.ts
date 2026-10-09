import type { LlmProviderDiscoveredModelWire } from '@nexttime/shared';
import type { ProviderApiKind } from './config.js';
import { readUpstreamJson } from './http-util.js';
import { describeFailure, scrubUpstreamText } from './provider-test.js';

/**
 * provider-models: `POST /admin/model-discovery` (admin-api.ts) — "从供应商获取模型". One
 * `GET <upstream>/v1/models` with the provider's auth header, so the console can offer the
 * provider's real model ids instead of making the administrator type them and find out at test
 * time that one was wrong. The listing shape is the same for the three api kinds this proxy speaks:
 * OpenAI's `{data: [{id}]}` (also what OpenAI-compatible relays answer) and Anthropic's
 * `{data: [{id, display_name}]}` (`anthropic-version` required; `limit` raised to its maximum so
 * one page covers every current model).
 *
 * Same posture as provider-test.ts: a fixed request (no caller-supplied path, query or body), a
 * redirect is a failure rather than a second destination for the key (R-23), the key never
 * appears in a result or error (`scrubUpstreamText`), and the caller (admin-api.ts) decides which
 * credential may go to which upstream and audit-logs the call.
 */

export interface ListUpstreamModelsOptions {
  readonly api: ProviderApiKind;
  readonly upstreamBaseUrl: string;
  readonly authHeader: 'authorization' | 'x-api-key';
  readonly realKey: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export type ListUpstreamModelsResult =
  | {
      readonly ok: true;
      readonly models: readonly LlmProviderDiscoveredModelWire[];
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      /** `upstream_status`: the upstream answered non-2xx; `unreachable`: no answer (DNS, TLS,
       *  timeout, redirect); `invalid_response`: 2xx without a model list. */
      readonly reason: 'upstream_status' | 'unreachable' | 'invalid_response';
      readonly status: number | null;
      /** Sanitized, key-scrubbed, bounded. */
      readonly message: string;
    };

/** The most ids returned to the console — far above any real provider's list, low enough that a
 *  misbehaving upstream cannot bloat the response. */
export const MAX_DISCOVERED_MODELS = 500;

/** The most of a model list the proxy reads (STATUS leftover 138). Large aggregators list a few
 *  hundred models with descriptions and pricing — around a megabyte or two; the cap leaves room
 *  for that and stops an upstream that streams without end. */
export const MAX_MODEL_LIST_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function listUpstreamModels(
  options: ListUpstreamModelsOptions,
): Promise<ListUpstreamModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.upstreamBaseUrl.replace(/\/+$/, '');
  const url =
    options.api === 'anthropic-messages' ? `${base}/v1/models?limit=1000` : `${base}/v1/models`;
  const headers = new Headers({ accept: 'application/json' });
  if (options.api === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01');
  try {
    headers.set(
      options.authHeader,
      options.authHeader === 'authorization' ? `Bearer ${options.realKey}` : options.realKey,
    );
  } catch {
    // A stored or environment key with a character an HTTP header cannot carry (a pasted
    // full-width character, say). `Headers` throws a TypeError naming the value — never echo it.
    return {
      ok: false,
      reason: 'unreachable',
      status: null,
      message: 'the key contains a character that cannot be sent in an HTTP header — re-enter it',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('upstream timeout')),
    options.timeoutMs,
  );
  timeout.unref?.();
  let status: number;
  let body: unknown;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'error',
    });
    status = res.status;
    const read = await readUpstreamJson(res, MAX_MODEL_LIST_BYTES);
    if (read.tooLarge) {
      return {
        ok: false,
        reason: res.ok ? 'invalid_response' : 'upstream_status',
        status,
        message: `the upstream answered with more than ${MAX_MODEL_LIST_BYTES / (1024 * 1024)} MiB, which was not read`,
      };
    }
    body = read.body;
    if (!res.ok) {
      return {
        ok: false,
        reason: 'upstream_status',
        status,
        message: describeFailure(status, body, options.realKey),
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      status: null,
      message: scrubUpstreamText(String(err), options.realKey),
    };
  } finally {
    clearTimeout(timeout);
  }

  const data = isRecord(body) ? body.data : undefined;
  if (!Array.isArray(data)) {
    return {
      ok: false,
      reason: 'invalid_response',
      status,
      message: 'the upstream answered without a model list (no `data` array)',
    };
  }
  const seen = new Set<string>();
  const models: LlmProviderDiscoveredModelWire[] = [];
  for (const item of data) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (id.length === 0 || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof item.display_name === 'string' && item.display_name.trim().length > 0
        ? item.display_name.trim().slice(0, 120)
        : null;
    models.push({ id, displayName: name });
  }
  // Upstream order is kept: Anthropic lists newest first, which is the order an administrator
  // wants to pick from; the console filters, it does not need a sorted list.
  return {
    ok: true,
    models: models.slice(0, MAX_DISCOVERED_MODELS),
    truncated: models.length > MAX_DISCOVERED_MODELS,
  };
}
