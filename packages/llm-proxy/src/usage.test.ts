import { describe, expect, it } from 'vitest';
import {
  createStreamUsageAccumulator,
  parseAnthropicUsage,
  parseOpenAiResponsesUsage,
  parseOpenAiUsage,
  parseUsageFromJsonBody,
} from './usage.js';

describe('parseOpenAiUsage', () => {
  it('nets prompt_tokens against cache read/write, output as-is', () => {
    const usage = parseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
    });
    expect(usage).toEqual({
      inputTokens: 60,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    });
  });

  it('falls back to prompt_cache_hit_tokens then top-level cached_tokens', () => {
    expect(
      parseOpenAiUsage({ prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 20 }),
    ).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      cacheReadTokens: 20,
    });
    expect(
      parseOpenAiUsage({ prompt_tokens: 50, completion_tokens: 5, cached_tokens: 10 }),
    ).toEqual({
      inputTokens: 40,
      outputTokens: 5,
      cacheReadTokens: 10,
    });
  });

  it('omits cache fields entirely when zero', () => {
    const usage = parseOpenAiUsage({ prompt_tokens: 10, completion_tokens: 5 });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect('cacheReadTokens' in usage).toBe(false);
    expect('cacheWriteTokens' in usage).toBe(false);
  });

  it('never returns a negative input (clamped at 0)', () => {
    const usage = parseOpenAiUsage({
      prompt_tokens: 5,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 10 },
    });
    expect(usage.inputTokens).toBe(0);
  });
});

describe('parseAnthropicUsage', () => {
  it('reads input_tokens as-is (not net of cache — a separate axis)', () => {
    const usage = parseAnthropicUsage({
      input_tokens: 25,
      output_tokens: 15,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 8,
    });
    expect(usage).toEqual({
      inputTokens: 25,
      outputTokens: 15,
      cacheReadTokens: 5,
      cacheWriteTokens: 8,
    });
  });

  it('omits cache fields when zero/absent', () => {
    expect(parseAnthropicUsage({ input_tokens: 10, output_tokens: 3 })).toEqual({
      inputTokens: 10,
      outputTokens: 3,
    });
  });
});

describe('parseOpenAiResponsesUsage', () => {
  it('nets input_tokens against cached/cache-write tokens; output_tokens as-is (incl. reasoning)', () => {
    const usage = parseOpenAiResponsesUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 25 },
      total_tokens: 140,
    });
    expect(usage).toEqual({
      inputTokens: 60,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    });
  });

  it('omits cache fields when zero and clamps input at 0', () => {
    expect(
      parseOpenAiResponsesUsage({
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(
      parseOpenAiResponsesUsage({ input_tokens: 5, input_tokens_details: { cached_tokens: 10 } })
        .inputTokens,
    ).toBe(0);
  });
});

describe('parseUsageFromJsonBody', () => {
  it('parses Chat Completions usage for openai-completions', () => {
    const body = { id: 'x', usage: { prompt_tokens: 10, completion_tokens: 2 } };
    expect(parseUsageFromJsonBody('openai-completions', body)).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it('parses Responses usage (input_tokens/output_tokens) for openai-responses (R-10)', () => {
    // The official Response object's top-level `usage` (ResponseUsage).
    const body = {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 36,
        input_tokens_details: { cached_tokens: 6, cache_write_tokens: 0 },
        output_tokens: 87,
        output_tokens_details: { reasoning_tokens: 64 },
        total_tokens: 123,
      },
    };
    expect(parseUsageFromJsonBody('openai-responses', body)).toEqual({
      inputTokens: 30,
      outputTokens: 87,
      cacheReadTokens: 6,
    });
  });

  it('parses Anthropic-shaped usage for anthropic-messages', () => {
    const body = { id: 'x', usage: { input_tokens: 7, output_tokens: 3 } };
    expect(parseUsageFromJsonBody('anthropic-messages', body)).toEqual({
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it('returns undefined when usage is absent or the body is not an object', () => {
    expect(parseUsageFromJsonBody('openai-completions', { id: 'x' })).toBeUndefined();
    expect(parseUsageFromJsonBody('openai-completions', null)).toBeUndefined();
    expect(parseUsageFromJsonBody('openai-completions', 'not an object')).toBeUndefined();
  });
});

function sseFrame(event: string | undefined, data: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${data}\n\n`;
}

describe('createStreamUsageAccumulator — openai-completions', () => {
  it('takes the cumulative usage from the final chunk, ignoring [DONE]', () => {
    const acc = createStreamUsageAccumulator('openai-completions');
    acc.push(sseFrame(undefined, JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })));
    acc.push(
      sseFrame(
        undefined,
        JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
      ),
    );
    acc.push(sseFrame(undefined, '[DONE]'));

    expect(acc.result()).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it('handles a frame split across two push() calls', () => {
    const acc = createStreamUsageAccumulator('openai-completions');
    const full = sseFrame(
      undefined,
      JSON.stringify({ usage: { prompt_tokens: 8, completion_tokens: 1 } }),
    );
    const splitAt = Math.floor(full.length / 2);
    acc.push(full.slice(0, splitAt));
    expect(acc.result()).toBeUndefined();
    acc.push(full.slice(splitAt));
    expect(acc.result()).toEqual({ inputTokens: 8, outputTokens: 1 });
  });

  it('returns undefined when no usage was ever observed', () => {
    const acc = createStreamUsageAccumulator('openai-completions');
    acc.push(sseFrame(undefined, JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })));
    expect(acc.result()).toBeUndefined();
  });
});

describe('createStreamUsageAccumulator — openai-responses (R-10)', () => {
  const completedUsage = {
    input_tokens: 50,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
    output_tokens: 12,
    output_tokens_details: { reasoning_tokens: 4 },
    total_tokens: 62,
  };

  it('reads usage from response.completed’s response.usage, ignoring earlier events', () => {
    const acc = createStreamUsageAccumulator('openai-responses');
    acc.push(
      sseFrame(
        'response.created',
        JSON.stringify({
          type: 'response.created',
          sequence_number: 0,
          response: { id: 'resp_1', status: 'in_progress', usage: null },
        }),
      ),
    );
    acc.push(
      sseFrame(
        'response.output_text.delta',
        JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, delta: 'hi' }),
      ),
    );
    expect(acc.result()).toBeUndefined();
    acc.push(
      sseFrame(
        'response.completed',
        JSON.stringify({
          type: 'response.completed',
          sequence_number: 2,
          response: { id: 'resp_1', status: 'completed', usage: completedUsage },
        }),
      ),
    );
    expect(acc.result()).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 20 });
  });

  it('also reads response.incomplete (e.g. max_output_tokens hit), split across pushes', () => {
    const acc = createStreamUsageAccumulator('openai-responses');
    const full = sseFrame(
      'response.incomplete',
      JSON.stringify({
        type: 'response.incomplete',
        sequence_number: 5,
        response: { id: 'resp_2', status: 'incomplete', usage: completedUsage },
      }),
    );
    const splitAt = Math.floor(full.length / 2);
    acc.push(full.slice(0, splitAt));
    expect(acc.result()).toBeUndefined();
    acc.push(full.slice(splitAt));
    expect(acc.result()).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 20 });
  });

  it('ignores a Chat Completions-style top-level usage — not a Responses event', () => {
    const acc = createStreamUsageAccumulator('openai-responses');
    acc.push(sseFrame(undefined, JSON.stringify({ usage: { prompt_tokens: 8 } })));
    expect(acc.result()).toBeUndefined();
  });
});

describe('createStreamUsageAccumulator — anthropic-messages', () => {
  it('seeds from message_start and only overrides fields message_delta actually includes', () => {
    const acc = createStreamUsageAccumulator('anthropic-messages');
    acc.push(
      sseFrame(
        'message_start',
        JSON.stringify({
          message: {
            usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 5 },
          },
        }),
      ),
    );
    expect(acc.result()).toEqual({ inputTokens: 20, outputTokens: 0, cacheReadTokens: 5 });

    // message_delta updates only output_tokens — input_tokens/cacheReadTokens must be preserved.
    acc.push(sseFrame('message_delta', JSON.stringify({ usage: { output_tokens: 30 } })));
    expect(acc.result()).toEqual({ inputTokens: 20, outputTokens: 30, cacheReadTokens: 5 });
  });

  it('returns undefined when neither message_start nor message_delta carried usage', () => {
    const acc = createStreamUsageAccumulator('anthropic-messages');
    acc.push(sseFrame('content_block_delta', JSON.stringify({ delta: { text: 'hi' } })));
    expect(acc.result()).toBeUndefined();
  });
});
