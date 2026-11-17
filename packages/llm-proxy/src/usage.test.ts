import { describe, expect, it } from 'vitest';
import {
  MAX_USAGE_SCAN_CHARS,
  createStreamUsageAccumulator,
  isRecordableCostUsd,
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

  it('drops a frame larger than the scan cap and still reads the usage frame after it (STATUS leftover 138)', () => {
    const acc = createStreamUsageAccumulator('openai-completions');
    const chunk = 'x'.repeat(1024 * 1024);
    acc.push('data: ');
    for (let sent = 0; sent <= MAX_USAGE_SCAN_CHARS; sent += chunk.length) acc.push(chunk);
    acc.push('\n\n');
    acc.push(
      sseFrame(undefined, JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })),
    );
    expect(acc.result()).toEqual({ inputTokens: 5, outputTokens: 2 });
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

// Legacy 829: every count that leaves the module is a non-negative safe integer, whatever the
// provider's answer held.
describe('usage figures that are not token counts (legacy 829)', () => {
  const NOT_COUNTS: ReadonlyArray<readonly [string, unknown]> = [
    ['a negative number', -1],
    ['a tiny negative number', -0.4],
    ['Infinity (a JSON number too large for a double)', JSON.parse('1e400')],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['a number past the safe integers', Number.MAX_SAFE_INTEGER + 1],
    ['a fraction that rounds past the safe integers', Number.MAX_SAFE_INTEGER + 0.5],
    ['a numeric string', '100'],
    ['a boolean', true],
    ['an object', { value: 1 }],
    ['an array', [1]],
  ];

  it.each(NOT_COUNTS)('reads %s as missing and names the field', (_label, value) => {
    expect(parseOpenAiUsage({ prompt_tokens: value, completion_tokens: 3 } as never)).toEqual({
      inputTokens: 0,
      outputTokens: 3,
      invalidFields: ['prompt_tokens'],
    });
    expect(parseOpenAiResponsesUsage({ input_tokens: 4, output_tokens: value } as never)).toEqual({
      inputTokens: 4,
      outputTokens: 0,
      invalidFields: ['output_tokens'],
    });
    expect(
      parseAnthropicUsage({
        input_tokens: 4,
        output_tokens: 2,
        cache_read_input_tokens: value,
      } as never),
    ).toEqual({ inputTokens: 4, outputTokens: 2, invalidFields: ['cache_read_input_tokens'] });
  });

  it('rounds a fraction to the nearest count, without a note', () => {
    expect(parseOpenAiUsage({ prompt_tokens: 10.4, completion_tokens: 2.5 })).toEqual({
      inputTokens: 10,
      outputTokens: 3,
    });
    expect(parseAnthropicUsage({ input_tokens: 0.4, output_tokens: 7.6 })).toEqual({
      inputTokens: 0,
      outputTokens: 8,
    });
  });

  it('keeps the largest safe integer, and missing figures (null) carry no note', () => {
    expect(
      parseAnthropicUsage({
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: null,
        cache_creation_input_tokens: Number.MAX_SAFE_INTEGER,
      } as never),
    ).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      cacheWriteTokens: Number.MAX_SAFE_INTEGER,
    });
  });

  it('nets the OpenAI input against checked cache figures, so it stays a count', () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: Number.MAX_SAFE_INTEGER,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: Number.MAX_SAFE_INTEGER, cache_write_tokens: -9 },
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: Number.MAX_SAFE_INTEGER,
      invalidFields: ['prompt_tokens_details.cache_write_tokens'],
    });
    expect(
      parseOpenAiResponsesUsage({
        input_tokens: 'many',
        output_tokens: 1,
        input_tokens_details: { cached_tokens: -1, cache_write_tokens: 2 },
      } as never),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 1,
      cacheWriteTokens: 2,
      invalidFields: ['input_tokens_details.cached_tokens', 'input_tokens'],
    });
  });

  it('falls through to the next cache-read field when a higher-priority one is not a count', () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 'lots' },
        prompt_cache_hit_tokens: 40,
        cached_tokens: 99,
      } as never),
    ).toEqual({
      inputTokens: 60,
      outputTokens: 1,
      cacheReadTokens: 40,
      invalidFields: ['prompt_tokens_details.cached_tokens'],
    });
  });

  it('reads the figures of a JSON body the same way', () => {
    expect(
      parseUsageFromJsonBody(
        'openai-completions',
        JSON.parse('{"usage":{"prompt_tokens":1e400,"completion_tokens":-2}}'),
      ),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      invalidFields: ['prompt_tokens', 'completion_tokens'],
    });
  });

  it('streams: the last OpenAI usage object decides the figures and the note', () => {
    const acc = createStreamUsageAccumulator('openai-completions');
    acc.push(`data: ${JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: 1 } })}\n\n`);
    expect(acc.result()).toEqual({
      inputTokens: 0,
      outputTokens: 1,
      invalidFields: ['prompt_tokens'],
    });
    acc.push(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
    expect(acc.result()).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('streams: a Responses terminal event is read the same way', () => {
    const acc = createStreamUsageAccumulator('openai-responses');
    acc.push(
      sseFrame(
        'response.completed',
        JSON.stringify({
          type: 'response.completed',
          response: { usage: { input_tokens: 8, output_tokens: 'x' } },
        }),
      ),
    );
    expect(acc.result()).toEqual({
      inputTokens: 8,
      outputTokens: 0,
      invalidFields: ['output_tokens'],
    });
  });

  it('streams: an Anthropic delta figure that is not a count leaves the earlier figure, once noted', () => {
    const acc = createStreamUsageAccumulator('anthropic-messages');
    acc.push(
      sseFrame(
        'message_start',
        JSON.stringify({
          message: {
            usage: { input_tokens: 'twenty', output_tokens: 1, cache_read_input_tokens: 5 },
          },
        }),
      ),
    );
    expect(acc.result()).toEqual({
      inputTokens: 0,
      outputTokens: 1,
      cacheReadTokens: 5,
      invalidFields: ['input_tokens'],
    });

    acc.push(
      sseFrame(
        'message_delta',
        JSON.stringify({
          usage: {
            input_tokens: 'twenty',
            output_tokens: -30,
            cache_read_input_tokens: 6,
            cache_creation_input_tokens: 2.2,
          },
        }),
      ),
    );
    acc.push(sseFrame('message_delta', '{"usage":{"output_tokens":1e400}}'));
    expect(acc.result()).toEqual({
      inputTokens: 0,
      outputTokens: 1,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
      invalidFields: ['input_tokens', 'output_tokens'],
    });
  });
});

describe('isRecordableCostUsd (legacy 829)', () => {
  it.each([
    [0, true],
    [0.000001, true],
    [999_999_999_999.9998, true],
    [1e12, false],
    [1e15, false],
    [-0.01, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NaN, false],
  ])('%s → %s', (cost, recordable) => {
    expect(isRecordableCostUsd(cost)).toBe(recordable);
  });
});
