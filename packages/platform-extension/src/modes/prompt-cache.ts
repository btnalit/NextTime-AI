import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Prompt caching around the per-call context message (v0.45.0 real-model candidate run: the entry
 * agent's cache read stayed at exactly the system prompt + tools on every call while the whole
 * conversation was written to the cache again each time).
 *
 * pi-ai puts the conversation's cache breakpoint on the last block of the last message
 * (`@earendil-works/pi-ai` 1.1.0: `dist/api/anthropic-messages.js` `convertMessages`, "Add
 * cache_control to the last user or system message"; `dist/api/openai-completions.js`
 * `addCacheControlToLastConversationMessage` for a provider with Anthropic-style cache control).
 * Entry and interactive mode append their live context as that last message (`context` hook), so
 * the breakpoint always sat on text that is gone from the next request — no later request ever
 * matched a written prefix, and every call paid the cache-write rate for the whole conversation.
 *
 * The context stays last — it is live state (pending approvals, running tasks) the model should
 * read right before it answers, and a prefix-matching provider (DeepSeek, OpenAI) already caches
 * everything before it. Only the breakpoint moves: `before_provider_request` takes it off the
 * context message and puts it on the last block before it, which the next request repeats byte
 * for byte. The context itself is then sent uncached on each call (it is small and changes).
 *
 * A payload whose last message is not the context this mode just injected, or that carries no
 * breakpoint there (a provider without explicit cache control), is passed through untouched.
 */

/** Block types a breakpoint may sit on (Anthropic Messages; Chat Completions only has `text`). */
const CACHEABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'document',
  'tool_use',
  'tool_result',
  'tool_addition',
  'tool_removal',
]);

type Block = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** pi-ai drops lone UTF-16 surrogates from every text it sends (`sanitizeSurrogates`), so the
 *  payload is compared with the context the same way. */
function withoutLoneSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

/** The message is the injected context: its text blocks read exactly `contextText`. */
function isContextMessage(message: Message, contextText: string): boolean {
  if (message.role !== 'user') return false;
  const expected = withoutLoneSurrogates(contextText);
  if (typeof message.content === 'string') return message.content === expected;
  if (!Array.isArray(message.content)) return false;
  const texts = message.content.filter(
    (block): block is Block => isRecord(block) && block.type === 'text',
  );
  return (
    texts.length > 0 &&
    texts.length === message.content.length &&
    texts.map((block) => block.text).join('') === expected
  );
}

/** Puts `cacheControl` on the message's last block that may carry one; `false` when none can. */
function placeBreakpoint(message: Message, cacheControl: unknown): boolean {
  if (typeof message.content === 'string') {
    if (message.content.length === 0) return false;
    message.content = [{ type: 'text', text: message.content, cache_control: cacheControl }];
    return true;
  }
  if (!Array.isArray(message.content)) return false;
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index];
    if (!isRecord(block) || typeof block.type !== 'string') continue;
    if (!CACHEABLE_BLOCK_TYPES.has(block.type)) continue;
    if (block.type === 'text' && (typeof block.text !== 'string' || block.text.length === 0)) {
      continue;
    }
    block.cache_control = cacheControl;
    return true;
  }
  return false;
}

/**
 * Moves the conversation breakpoint off a trailing context message onto the last block before it
 * (mutates and returns `payload`). Untouched when the last message is not that context or carries
 * no breakpoint, and when no earlier block can take one (the breakpoint then stays where it was).
 */
export function moveCacheBreakpointOffContext(payload: unknown, contextText: string): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages as Message[];
  const last = messages[messages.length - 1];
  if (!isRecord(last) || !isContextMessage(last, contextText)) return payload;
  if (!Array.isArray(last.content)) return payload;
  const marked = (last.content as unknown[]).filter(
    (block): block is Block => isRecord(block) && block.cache_control !== undefined,
  );
  const cacheControl = marked[marked.length - 1]?.cache_control;
  if (cacheControl === undefined) return payload;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (placeBreakpoint(message, cacheControl)) {
      // biome-ignore lint/performance/noDelete: the key must be gone from the request body, not left present as `undefined`.
      for (const block of marked) delete block.cache_control;
      return payload;
    }
  }
  return payload;
}

/**
 * Installs the `before_provider_request` half for a mode that appends its context last. The mode
 * reports what it appended on every `context` call — `undefined` when it appended nothing — so a
 * request is only rewritten when its last message is exactly that context.
 */
export function keepCacheBreakpointOnHistory(
  pi: ExtensionAPI,
): (contextText: string | undefined) => void {
  let appended: string | undefined;
  pi.on('before_provider_request', (event) => {
    if (appended === undefined) return undefined;
    return moveCacheBreakpointOffContext(event.payload, appended);
  });
  return (contextText) => {
    appended = contextText;
  };
}
