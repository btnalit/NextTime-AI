import type { ProviderApiKind, ProviderConfig } from './config.js';
import type { StoreTestResult } from './provider-store.js';

/**
 * provider-test: `POST /admin/providers/:id/test` (S6-B, docs/console-completion-plan.md §5.4
 * acceptance: "'测试调用'含一次工具调用往返，不只补全 — Worker 与门工具都依赖它，'兼容零改动'要验过才算";
 * §12 item 2). Two real round trips against the provider's upstream, in order:
 *
 *   1. a plain completion ("reply with the single word OK") — proves base URL, api kind, auth
 *      header and key all line up;
 *   2. a forced tool call — the request declares one function (`ping`) and *forces* the model to
 *      call it (`tool_choice`, per api kind), then checks that the response actually carries a
 *      structured tool call for that name. Forcing matters: without it a model may legitimately
 *      answer in prose and the test would say nothing about whether tool calling works on this
 *      endpoint — the thing Workers and gate tools depend on.
 *
 * Request shapes and the response fields inspected are the documented ones for each of the three
 * api kinds this proxy speaks (config.ts `ProviderApiKind`; the same three pi's own provider
 * implementations use — see config.ts's citations): OpenAI Chat Completions (`tools` +
 * `tool_choice: {type:'function', function:{name}}` → `choices[0].message.tool_calls[]`), OpenAI
 * Responses (`tools: [{type:'function', name, parameters}]` + `tool_choice: {type:'function',
 * name}` → an `output[]` item of `type: 'function_call'`), Anthropic Messages (`tools` +
 * `tool_choice: {type:'tool', name}` → a `content[]` block of `type: 'tool_use'`; `max_tokens`
 * and `anthropic-version` are required there). No `max_tokens` is sent on the OpenAI kinds — the
 * newer reasoning models reject it in favour of `max_completion_tokens`, and the prompts are
 * short enough not to need a cap.
 *
 * This is the one code path where this proxy uses a provider key on its *own* initiative rather
 * than on behalf of a Handle — bounded to these two fixed requests, never a caller-supplied body,
 * and audit-logged by admin-api.ts (which also refuses the test when `credentialPresent` is false
 * rather than sending an empty header upstream). The key never appears in the result: `error`
 * carries the HTTP status and at most a short, key-scrubbed excerpt of the upstream error message.
 */

export interface ProviderTestOptions {
  readonly provider: ProviderConfig;
  readonly model: string;
  readonly realKey: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

const TOOL_NAME = 'ping';
const TOOL_PARAMETERS = {
  type: 'object',
  properties: { text: { type: 'string', description: 'Any short text to echo back.' } },
  required: ['text'],
  additionalProperties: false,
} as const;
const COMPLETION_PROMPT = 'Reply with the single word OK.';
const TOOL_PROMPT = `Call the tool "${TOOL_NAME}" with text set to "pong". Do not answer in prose.`;

interface UpstreamCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly extraHeaders?: Record<string, string>;
}

function completionCall(api: ProviderApiKind, model: string): UpstreamCall {
  switch (api) {
    case 'openai-completions':
      return {
        path: '/v1/chat/completions',
        body: { model, messages: [{ role: 'user', content: COMPLETION_PROMPT }] },
      };
    case 'openai-responses':
      return { path: '/v1/responses', body: { model, input: COMPLETION_PROMPT } };
    case 'anthropic-messages':
      return {
        path: '/v1/messages',
        body: { model, max_tokens: 16, messages: [{ role: 'user', content: COMPLETION_PROMPT }] },
        extraHeaders: { 'anthropic-version': '2023-06-01' },
      };
  }
}

function toolCall(api: ProviderApiKind, model: string): UpstreamCall {
  switch (api) {
    case 'openai-completions':
      return {
        path: '/v1/chat/completions',
        body: {
          model,
          messages: [{ role: 'user', content: TOOL_PROMPT }],
          tools: [
            {
              type: 'function',
              function: { name: TOOL_NAME, description: 'Echo test.', parameters: TOOL_PARAMETERS },
            },
          ],
          tool_choice: { type: 'function', function: { name: TOOL_NAME } },
        },
      };
    case 'openai-responses':
      return {
        path: '/v1/responses',
        body: {
          model,
          input: TOOL_PROMPT,
          tools: [
            {
              type: 'function',
              name: TOOL_NAME,
              description: 'Echo test.',
              parameters: TOOL_PARAMETERS,
            },
          ],
          tool_choice: { type: 'function', name: TOOL_NAME },
        },
      };
    case 'anthropic-messages':
      return {
        path: '/v1/messages',
        body: {
          model,
          max_tokens: 64,
          messages: [{ role: 'user', content: TOOL_PROMPT }],
          tools: [{ name: TOOL_NAME, description: 'Echo test.', input_schema: TOOL_PARAMETERS }],
          tool_choice: { type: 'tool', name: TOOL_NAME },
        },
        extraHeaders: { 'anthropic-version': '2023-06-01' },
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the response body is the api kind's success shape for a plain completion. */
function completionSucceeded(api: ProviderApiKind, body: unknown): boolean {
  if (!isRecord(body)) return false;
  switch (api) {
    case 'openai-completions': {
      const choices = body.choices;
      return Array.isArray(choices) && choices.length > 0 && isRecord(choices[0]);
    }
    case 'openai-responses':
      return Array.isArray(body.output);
    case 'anthropic-messages':
      return Array.isArray(body.content);
  }
}

/** True when the response body carries a structured call of `TOOL_NAME`. */
function toolCallSucceeded(api: ProviderApiKind, body: unknown): boolean {
  if (!isRecord(body)) return false;
  switch (api) {
    case 'openai-completions': {
      const choices = body.choices;
      if (!Array.isArray(choices) || !isRecord(choices[0])) return false;
      const message = choices[0].message;
      if (!isRecord(message) || !Array.isArray(message.tool_calls)) return false;
      return message.tool_calls.some(
        (call) => isRecord(call) && isRecord(call.function) && call.function.name === TOOL_NAME,
      );
    }
    case 'openai-responses': {
      const output = body.output;
      if (!Array.isArray(output)) return false;
      return output.some(
        (item) => isRecord(item) && item.type === 'function_call' && item.name === TOOL_NAME,
      );
    }
    case 'anthropic-messages': {
      const content = body.content;
      if (!Array.isArray(content)) return false;
      return content.some(
        (block) => isRecord(block) && block.type === 'tool_use' && block.name === TOOL_NAME,
      );
    }
  }
}

// P3 hotfix (post-v0.16.0 review): beyond the exact-key scrub (`.split(realKey).join('***')`
// below), also redact anything that merely *looks* like a credential — an upstream error can just
// as easily echo back a *different* secret-shaped string than the one this test call used
// (another provider's key baked into a shared error template, an internal token, a signed-url
// token, …), which an exact-match scrub alone would never catch. Two patterns: a short
// recognizable-prefix run (`sk`/`key`/`tok`-led, case-insensitive, ≥ 8 trailing id chars) and any
// long (≥ 24 char) base64-ish run regardless of prefix.
const TOKEN_LIKE_PREFIX_PATTERN = /(sk|key|tok)[-_A-Za-z0-9]{8,}/gi;
const LONG_BASE64ISH_PATTERN = /[A-Za-z0-9+/_-]{24,}/g;
const ERROR_TEXT_MAX_LENGTH = 200;

/** Scrubs `realKey` verbatim, then every token-like run (see the two patterns above), then
 *  truncates — truncation runs last so a redaction is never cut in half. Shared by
 *  `describeFailure` (a structured upstream error body) and `runProviderTest`'s own two
 *  `catch (err)` blocks (a thrown `Error`'s `String(err)`, which can embed the request URL/body). */
function scrubUpstreamText(text: string, realKey: string): string {
  const scrubbed = text
    .split(realKey)
    .join('***')
    .replace(TOKEN_LIKE_PREFIX_PATTERN, '***')
    .replace(LONG_BASE64ISH_PATTERN, '***');
  return scrubbed.slice(0, ERROR_TEXT_MAX_LENGTH);
}

/** A short, key-scrubbed description of an upstream failure for the result's `error` field. */
function describeFailure(status: number, body: unknown, realKey: string): string {
  let detail = '';
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === 'string') detail = error.message;
    else if (typeof error === 'string') detail = error;
  }
  detail = scrubUpstreamText(detail, realKey);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

async function callUpstream(
  options: ProviderTestOptions,
  call: UpstreamCall,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { provider } = options;
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json',
    ...(call.extraHeaders ?? {}),
  });
  headers.set(
    provider.auth.header,
    provider.auth.scheme ? `${provider.auth.scheme} ${options.realKey}` : options.realKey,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('upstream timeout')),
    options.timeoutMs,
  );
  timeout.unref?.();
  try {
    const res = await fetchImpl(`${provider.upstream_base_url}${call.path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(call.body),
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

/** Runs the two round trips and returns the structured outcome (store shape; admin-api.ts maps
 *  it to the wire). Never throws for an upstream failure — that is a result, not an exception;
 *  only a programming error escapes. */
export async function runProviderTest(options: ProviderTestOptions): Promise<StoreTestResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const { api } = options.provider;
  let completion: StoreTestResult['completion'] = 'error';
  let tool: StoreTestResult['tool_call'] = 'skipped';
  let error: string | null = null;

  try {
    const first = await callUpstream(options, completionCall(api, options.model));
    if (first.ok && completionSucceeded(api, first.body)) {
      completion = 'ok';
    } else {
      error = first.ok
        ? 'completion response did not have the expected shape'
        : describeFailure(first.status, first.body, options.realKey);
    }
  } catch (err) {
    error = `completion request failed: ${scrubUpstreamText(String(err), options.realKey)}`;
  }

  if (completion === 'ok') {
    try {
      const second = await callUpstream(options, toolCall(api, options.model));
      if (second.ok && toolCallSucceeded(api, second.body)) {
        tool = 'ok';
      } else {
        tool = 'error';
        error = second.ok
          ? `tool-call response carried no call of "${TOOL_NAME}"`
          : describeFailure(second.status, second.body, options.realKey);
      }
    } catch (err) {
      tool = 'error';
      error = `tool-call request failed: ${scrubUpstreamText(String(err), options.realKey)}`;
    }
  }

  const finishedAt = now();
  return {
    model: options.model,
    completion,
    tool_call: tool,
    latency_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    error,
    tested_at: finishedAt.toISOString(),
  };
}
