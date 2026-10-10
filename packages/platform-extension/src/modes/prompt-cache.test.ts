import { describe, expect, it } from 'vitest';
import { moveCacheBreakpointOffContext } from './prompt-cache.js';

/**
 * prompt-cache.test: the payload half of keeping the conversation's cache breakpoint off the
 * per-call context message. The request built by the real pi-ai is covered in
 * `prompt-cache.sdk.test.ts`; these pin the rewrite itself on both payload shapes pi-ai marks.
 */

const EPHEMERAL = { type: 'ephemeral' };
const CONTEXT = '## NextTime entry context\n\n### Pending approvals\n- ar-1';

function anthropicPayload(lastBefore: unknown, context: unknown = CONTEXT) {
  return {
    model: 'claude-test',
    system: [{ type: 'text', text: 'system', cache_control: EPHEMERAL }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is running?' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_task', input: {} }],
      },
      lastBefore,
      { role: 'user', content: [{ type: 'text', text: context, cache_control: EPHEMERAL }] },
    ],
  };
}

const TOOL_RESULT = {
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
};

describe('moveCacheBreakpointOffContext', () => {
  it('moves the breakpoint from the context onto the last block before it (Anthropic Messages)', () => {
    const payload = anthropicPayload(structuredClone(TOOL_RESULT));
    moveCacheBreakpointOffContext(payload, CONTEXT);
    expect(payload.messages[3]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: CONTEXT }],
    });
    expect(payload.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', cache_control: EPHEMERAL },
      ],
    });
    // Nothing else moves: one message-level breakpoint, the system one untouched.
    expect(JSON.stringify(payload.messages).match(/cache_control/g)).toHaveLength(1);
    expect(payload.system[0]?.cache_control).toEqual(EPHEMERAL);
  });

  it('keeps the same cache_control value (a 1h TTL stays 1h)', () => {
    const longTtl = { type: 'ephemeral', ttl: '1h' };
    const payload = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'user', content: [{ type: 'text', text: CONTEXT, cache_control: longTtl }] },
      ],
    };
    moveCacheBreakpointOffContext(payload, CONTEXT);
    expect(payload.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: longTtl }],
    });
  });

  it('skips blocks that cannot carry a breakpoint (thinking, empty text) and messages with none', () => {
    const payload = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'thinking', thinking: 'hmm', signature: 's' },
          ],
        },
        { role: 'system', content: [] },
        { role: 'user', content: [{ type: 'text', text: CONTEXT, cache_control: EPHEMERAL }] },
      ],
    };
    moveCacheBreakpointOffContext(payload, CONTEXT);
    expect(payload.messages[1]?.content).toEqual([
      { type: 'text', text: 'Looking.', cache_control: EPHEMERAL },
      { type: 'thinking', thinking: 'hmm', signature: 's' },
    ]);
    expect(JSON.stringify(payload.messages[3])).not.toContain('cache_control');
  });

  it('Chat Completions with Anthropic-style cache control: a string tool result takes it as a text part', () => {
    const payload = {
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'What is running?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: CONTEXT, cache_control: EPHEMERAL }] },
      ],
    };
    moveCacheBreakpointOffContext(payload, CONTEXT);
    expect(payload.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: [{ type: 'text', text: 'ok', cache_control: EPHEMERAL }],
    });
    expect(payload.messages[4]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: CONTEXT }],
    });
  });

  it('leaves a payload alone when the last message is not that context, or carries no breakpoint', () => {
    const notOurs = anthropicPayload(structuredClone(TOOL_RESULT), 'someone else’s text');
    const before = JSON.stringify(notOurs);
    moveCacheBreakpointOffContext(notOurs, CONTEXT);
    expect(JSON.stringify(notOurs)).toBe(before);

    // A prefix-caching provider (DeepSeek, OpenAI) sends no breakpoint at all.
    const automatic = {
      messages: [
        { role: 'user', content: 'What is running?' },
        { role: 'user', content: CONTEXT },
      ],
    };
    const automaticBefore = JSON.stringify(automatic);
    moveCacheBreakpointOffContext(automatic, CONTEXT);
    expect(JSON.stringify(automatic)).toBe(automaticBefore);

    // A context that is not last (another message followed it) is not ours to move.
    const followed = anthropicPayload(structuredClone(TOOL_RESULT));
    followed.messages.push(structuredClone(TOOL_RESULT));
    const followedBefore = JSON.stringify(followed);
    moveCacheBreakpointOffContext(followed, CONTEXT);
    expect(JSON.stringify(followed)).toBe(followedBefore);
  });

  it('keeps the breakpoint on the context when nothing before it can take one', () => {
    const payload = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: CONTEXT, cache_control: EPHEMERAL }] },
      ],
    };
    moveCacheBreakpointOffContext(payload, CONTEXT);
    expect(payload.messages[0]?.content).toEqual([
      { type: 'text', text: CONTEXT, cache_control: EPHEMERAL },
    ]);
  });

  it('matches the context after pi-ai drops lone surrogates from it', () => {
    const lone = `${CONTEXT} \uD83D`;
    const payload = anthropicPayload(structuredClone(TOOL_RESULT), `${CONTEXT} `);
    moveCacheBreakpointOffContext(payload, lone);
    expect(JSON.stringify(payload.messages[3])).not.toContain('cache_control');
  });
});
