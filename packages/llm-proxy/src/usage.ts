import type { ModelCost, ProviderApiKind } from './config.js';

/**
 * usage: normalized token-usage extraction for both provider families (S1.7 task brief: "OpenAI
 * 兼容与 Anthropic 两种 usage 解析"). Two independent halves:
 *
 *   - Non-streaming: the full JSON response body's own `usage` field (`parseUsageFromJsonBody`).
 *   - Streaming: an incremental SSE accumulator (`createStreamUsageAccumulator`) fed a *copy* of
 *     the same bytes `proxy.ts` forwards to the client verbatim — this module never sees, and
 *     never influences, what actually reaches the client. Byte-for-byte forwarding is entirely
 *     `proxy.ts`'s concern; this module only extracts numbers from a parallel read of the stream.
 *
 * Field names/shapes verified against pi 0.84.4's own usage-parsing code (cited per function
 * below) — not guessed from the public API docs — since this proxy must agree with what the
 * entry/Worker agent's own pi client will actually receive and (for the streaming case) already
 * expects `stream_options.include_usage: true` to have been set (proxy.ts's "one body mutation").
 */

export interface ParsedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

// -------------------------------------------------------------------------------------------
// Raw provider usage shapes
// -------------------------------------------------------------------------------------------

interface OpenAiRawUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly cached_tokens?: number;
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number;
    readonly cache_write_tokens?: number;
  };
  readonly completion_tokens_details?: {
    readonly reasoning_tokens?: number;
  };
}

interface AnthropicRawUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

/**
 * OpenAI-compatible `usage` (both families of `openai-completions`/`openai-responses` share this
 * shape). Verified against pi 0.84.4's own field mapping
 * (pi-0.84.4/packages/ai/src/api/openai-completions.ts `parseChunkUsage`): providers disagree on
 * where cache-read tokens live (`prompt_tokens_details.cached_tokens` — OpenAI/OpenRouter;
 * `prompt_cache_hit_tokens` — DeepSeek; top-level `cached_tokens` — Kimi), so all three are
 * checked in that priority order. `input` is *net* of both cache axes
 * (`max(0, prompt_tokens - cacheRead - cacheWrite)`) — not the raw `prompt_tokens` — matching
 * pi's own convention exactly, since a configured `ModelCost`'s separate `input`/`cacheRead`/
 * `cacheWrite` rates assume the same non-overlapping accounting; `completion_tokens` is used
 * as-is for `output` (OpenAI already includes reasoning tokens in it, per the same source file).
 */
export function parseOpenAiUsage(raw: OpenAiRawUsage): ParsedUsage {
  const promptTokens = raw.prompt_tokens ?? 0;
  const cacheReadTokens =
    raw.prompt_tokens_details?.cached_tokens ??
    raw.prompt_cache_hit_tokens ??
    raw.cached_tokens ??
    0;
  const cacheWriteTokens = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  const inputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = raw.completion_tokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

/**
 * Anthropic `usage` (verified against pi 0.84.4's own field mapping —
 * pi-0.84.4/packages/ai/src/api/anthropic-messages.ts, the `message_start`/`message_delta`
 * handling around its `output.usage.*` assignments): `input_tokens` is already net of the cache
 * axes (unlike OpenAI's `prompt_tokens`) — Anthropic reports it as a separate, non-overlapping
 * count, so no subtraction is applied here.
 */
export function parseAnthropicUsage(raw: AnthropicRawUsage): ParsedUsage {
  const inputTokens = raw.input_tokens ?? 0;
  const outputTokens = raw.output_tokens ?? 0;
  const cacheReadTokens = raw.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = raw.cache_creation_input_tokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

/** Non-streaming response bodies carry `usage` at the top level for every supported `api` kind
 *  (OpenAI chat/completions, OpenAI responses, and Anthropic messages alike) — only the shape of
 *  that `usage` object differs by family. Returns `undefined` if the field is absent/malformed. */
export function parseUsageFromJsonBody(
  api: ProviderApiKind,
  body: unknown,
): ParsedUsage | undefined {
  if (typeof body !== 'object' || body === null || !('usage' in body)) return undefined;
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  return api === 'anthropic-messages'
    ? parseAnthropicUsage(usage as AnthropicRawUsage)
    : parseOpenAiUsage(usage as OpenAiRawUsage);
}

// -------------------------------------------------------------------------------------------
// SSE line parsing (usage extraction only — never touches what's forwarded to the client)
// -------------------------------------------------------------------------------------------

interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/** Splits raw SSE text into `event`/`data` frames, tolerating a frame split across chunk
 *  boundaries (buffers the incomplete tail). A frame with no `data:` line is dropped — this only
 *  ever needs to see `data:` payloads. */
class SseEventParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const events: SseEvent[] = [];
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const event = SseEventParser.parseBlock(raw);
      if (event) events.push(event);
      idx = this.buffer.indexOf('\n\n');
    }
    return events;
  }

  private static parseBlock(raw: string): SseEvent | undefined {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (dataLines.length === 0) return undefined;
    return { event, data: dataLines.join('\n') };
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------------------------------
// Streaming accumulators
// -------------------------------------------------------------------------------------------

export interface UsageAccumulator {
  /** Feed one decoded (utf-8) text chunk of the response body, in order. */
  push(chunk: string): void;
  /** The usage observed so far, or `undefined` if none has been seen yet. */
  result(): ParsedUsage | undefined;
}

/**
 * OpenAI-compatible streaming: the server sends the *cumulative* usage object once, on the final
 * chunk (requires `stream_options.include_usage: true` on the request — proxy.ts's one body
 * mutation) — not incremental deltas, so the last `usage` object seen simply replaces any earlier
 * one. A `data: [DONE]` sentinel line is not JSON and is skipped.
 */
function createOpenAiStreamUsageAccumulator(): UsageAccumulator {
  const parser = new SseEventParser();
  let usage: ParsedUsage | undefined;

  return {
    push(chunk: string): void {
      for (const event of parser.push(chunk)) {
        if (event.data === '[DONE]') continue;
        const parsed = tryParseJson(event.data);
        const rawUsage = (parsed as { usage?: unknown } | undefined)?.usage;
        if (rawUsage && typeof rawUsage === 'object') {
          usage = parseOpenAiUsage(rawUsage as OpenAiRawUsage);
        }
      }
    },
    result: () => usage,
  };
}

/**
 * Anthropic streaming: `message_start`'s `message.usage` seeds the initial values;
 * `message_delta`'s `usage` only overwrites the fields it actually includes (pi 0.84.4's own
 * comment on this exact behavior: "Only update usage fields if present (not null). Preserves
 * input_tokens from message_start when proxies omit it in message_delta").
 */
function createAnthropicStreamUsageAccumulator(): UsageAccumulator {
  const parser = new SseEventParser();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let seen = false;

  return {
    push(chunk: string): void {
      for (const event of parser.push(chunk)) {
        const parsed = tryParseJson(event.data);
        if (typeof parsed !== 'object' || parsed === null) continue;

        if (event.event === 'message_start') {
          const messageUsage = (parsed as { message?: { usage?: AnthropicRawUsage } }).message
            ?.usage;
          if (!messageUsage) continue;
          seen = true;
          inputTokens = messageUsage.input_tokens ?? 0;
          outputTokens = messageUsage.output_tokens ?? 0;
          cacheReadTokens = messageUsage.cache_read_input_tokens ?? 0;
          cacheWriteTokens = messageUsage.cache_creation_input_tokens ?? 0;
        } else if (event.event === 'message_delta') {
          const deltaUsage = (parsed as { usage?: AnthropicRawUsage }).usage;
          if (!deltaUsage) continue;
          seen = true;
          if (deltaUsage.input_tokens != null) inputTokens = deltaUsage.input_tokens;
          if (deltaUsage.output_tokens != null) outputTokens = deltaUsage.output_tokens;
          if (deltaUsage.cache_read_input_tokens != null) {
            cacheReadTokens = deltaUsage.cache_read_input_tokens;
          }
          if (deltaUsage.cache_creation_input_tokens != null) {
            cacheWriteTokens = deltaUsage.cache_creation_input_tokens;
          }
        }
      }
    },
    result: () =>
      seen
        ? {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
          }
        : undefined,
  };
}

export function createStreamUsageAccumulator(api: ProviderApiKind): UsageAccumulator {
  return api === 'anthropic-messages'
    ? createAnthropicStreamUsageAccumulator()
    : createOpenAiStreamUsageAccumulator();
}

// -------------------------------------------------------------------------------------------
// Cost
// -------------------------------------------------------------------------------------------

/**
 * USD cost for one parsed usage, from a model's configured `ModelCost` (design doc §7.7: "成本元
 * 数据复用 pi-ai 的 ModelCost"). Formula and tier-selection logic ported from pi 0.84.4's own
 * `calculateCost` (pi-0.84.4/packages/ai/src/models.ts): rates are USD per **million** tokens; a
 * tier applies when total input-side tokens (`input + cacheRead + cacheWrite`) exceed its
 * `inputTokensAbove`, picking the highest such threshold. Deliberately omits pi's Anthropic
 * "1-hour cache write" 2x-multiplier special case (`cacheWrite1h`) — this proxy's `ParsedUsage`
 * doesn't carry that distinct sub-count (S1.7 scope; see PR body "假设与偏离"), so every cache
 * write is billed at the plain `cacheWrite` rate.
 */
export function computeCostUsd(cost: ModelCost, usage: ParsedUsage): number {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const totalInputSideTokens = usage.inputTokens + cacheReadTokens + cacheWriteTokens;

  let rates: { input: number; output: number; cacheRead: number; cacheWrite: number } = cost;
  let matchedThreshold = -1;
  for (const tier of cost.tiers ?? []) {
    if (totalInputSideTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }

  const perMillion = (rate: number, tokens: number): number => (rate / 1_000_000) * tokens;
  return (
    perMillion(rates.input, usage.inputTokens) +
    perMillion(rates.output, usage.outputTokens) +
    perMillion(rates.cacheRead, cacheReadTokens) +
    perMillion(rates.cacheWrite, cacheWriteTokens)
  );
}
