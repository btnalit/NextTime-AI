import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from './config.js';
import { PROVIDER_TEST_MAX_RESPONSE_BYTES, runProviderTest } from './provider-test.js';

/**
 * provider-test.test: fake upstreams for each api kind exercise the two round trips — the shape
 * checks that make a completion / a forced tool call "ok", the failure paths (upstream 401, a
 * tool-call response without the call, an unreachable upstream) and the guarantee that the real
 * key never appears in the result.
 */

const REAL_KEY = 'sk-very-secret-key';

interface Captured {
  path: string;
  authorization: string | undefined;
  apiKey: string | undefined;
  body: Record<string, unknown>;
}

function fakeUpstream(respond: (captured: Captured) => { status: number; body: unknown }): {
  server: http.Server;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Captured = {
        path: req.url ?? '',
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      };
      captured.push(entry);
      const out = respond(entry);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return { server, captured };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function provider(api: ProviderConfig['api'], port: number): ProviderConfig {
  return {
    api,
    upstream_base_url: `http://127.0.0.1:${port}`,
    api_key_env: 'KEY',
    auth:
      api === 'anthropic-messages'
        ? { header: 'x-api-key' }
        : { header: 'authorization', scheme: 'Bearer' },
    models: [{ id: 'm' }],
  };
}

async function start(respond: Parameters<typeof fakeUpstream>[0]) {
  const { server, captured } = fakeUpstream(respond);
  const port = await listen(server);
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port, captured };
}

describe('runProviderTest', () => {
  it('openai-completions: completion + forced tool call both ok; key sent as Bearer, never in the result', async () => {
    const { port, captured } = await start((c) =>
      c.body.tools
        ? {
            status: 200,
            body: {
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        type: 'function',
                        function: { name: 'ping', arguments: '{"text":"pong"}' },
                      },
                    ],
                  },
                },
              ],
            },
          }
        : { status: 200, body: { choices: [{ message: { content: 'OK' } }] } },
    );
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'ok', error: null, model: 'm' });
    expect(captured.map((c) => c.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    expect(captured[0]?.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(captured[1]?.body.tool_choice).toEqual({ type: 'function', function: { name: 'ping' } });
    expect(JSON.stringify(result)).not.toContain(REAL_KEY);
  });

  it('a key no header can carry is a failed test, not a thrown header error, and is never sent', async () => {
    const { port, captured } = await start(() => ({ status: 200, body: {} }));
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: 'sk-pasted\u3000key-0123456789',
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'error', tool_call: 'skipped' });
    expect(result.error).toContain('cannot be sent in an HTTP header');
    expect(JSON.stringify(result)).not.toContain('0123456789');
    expect(captured).toEqual([]);
  });

  it('openai-responses: expects an output function_call item', async () => {
    const { port, captured } = await start((c) =>
      c.body.tools
        ? {
            status: 200,
            body: { output: [{ type: 'function_call', name: 'ping', arguments: '{}' }] },
          }
        : { status: 200, body: { output: [{ type: 'message' }] } },
    );
    const result = await runProviderTest({
      provider: provider('openai-responses', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'ok' });
    expect(captured.map((c) => c.path)).toEqual(['/v1/responses', '/v1/responses']);
  });

  it('anthropic-messages: x-api-key + anthropic-version, expects a tool_use block', async () => {
    const seenVersions: string[] = [];
    const { server, captured } = fakeUpstream((c) =>
      c.body.tools
        ? { status: 200, body: { content: [{ type: 'tool_use', name: 'ping', input: {} }] } }
        : { status: 200, body: { content: [{ type: 'text', text: 'OK' }] } },
    );
    server.prependListener('request', (req) => {
      seenVersions.push(String(req.headers['anthropic-version']));
    });
    const port = await listen(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const result = await runProviderTest({
      provider: provider('anthropic-messages', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'ok' });
    expect(captured[0]?.apiKey).toBe(REAL_KEY);
    expect(captured[0]?.authorization).toBeUndefined();
    expect(seenVersions).toEqual(['2023-06-01', '2023-06-01']);
    // Current Claude models reject a forced tool_choice (`tool` / `any`) with HTTP 400.
    expect(captured[1]?.body.tool_choice).toEqual({ type: 'auto' });
  });

  // 4.7b host check (2026-10-09): DeepSeek's thinking mode rejects a forced tool_choice with
  // HTTP 400 although it calls tools fine under the default. The probe must retry without it.
  it('openai-completions: a 400 on the forced tool_choice is retried once without tool_choice (DeepSeek thinking mode)', async () => {
    const { port, captured } = await start((c) => {
      if (!c.body.tools)
        return { status: 200, body: { choices: [{ message: { content: 'OK' } }] } };
      if (c.body.tool_choice) {
        return {
          status: 400,
          body: {
            error: {
              message: 'Thinking mode does not support this tool_choice',
              type: 'invalid_request_error',
            },
          },
        };
      }
      return {
        status: 200,
        body: {
          choices: [
            {
              message: {
                reasoning_content: 'The user wants me to call ping.',
                tool_calls: [
                  { type: 'function', function: { name: 'ping', arguments: '{"text":"pong"}' } },
                ],
              },
            },
          ],
        },
      };
    });
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'deepseek-reasoner',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'ok', error: null });
    expect(captured).toHaveLength(3);
    expect(captured[1]?.body.tool_choice).toEqual({ type: 'function', function: { name: 'ping' } });
    expect(captured[2]?.body).not.toHaveProperty('tool_choice');
    expect(captured[2]?.body.tools).toEqual(captured[1]?.body.tools);
  });

  it('openai-responses: the same retry applies to its forced tool_choice', async () => {
    const { port, captured } = await start((c) => {
      if (!c.body.tools) return { status: 200, body: { output: [{ type: 'message' }] } };
      if (c.body.tool_choice) {
        return { status: 422, body: { error: { message: 'tool_choice is not supported' } } };
      }
      return { status: 200, body: { output: [{ type: 'function_call', name: 'ping' }] } };
    });
    const result = await runProviderTest({
      provider: provider('openai-responses', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'ok', error: null });
    expect(captured).toHaveLength(3);
    expect(captured[2]?.body).not.toHaveProperty('tool_choice');
  });

  // Every console preset (web lib/provider-form.ts PROVIDER_PRESETS) against both upstream
  // behaviours the probe can meet: the forced tool_choice accepted, or refused with a 400. Only
  // the DeepSeek text is verbatim (the 4.7b host check); the others stand for "a thinking / reasoning
  // mode that allows only auto" and are not quotes. Anthropic never forces (see the header comment).
  const PRESET_KINDS = [
    ['openai', 'openai-completions', 'gpt-5'],
    ['deepseek', 'openai-completions', 'deepseek-reasoner'],
    ['openrouter', 'openai-completions', 'deepseek/deepseek-r1'],
    ['moonshot', 'openai-completions', 'kimi-k2-thinking'],
    ['dashscope', 'openai-completions', 'qwen3-max'],
    ['siliconflow', 'openai-completions', 'Qwen/Qwen3-32B'],
  ] as const;
  const REFUSALS = {
    deepseek: 'Thinking mode does not support this tool_choice',
    other: 'tool_choice only supports "auto" or "none" when thinking is enabled',
  } as const;
  for (const [preset, api, model] of PRESET_KINDS) {
    for (const refuses of [false, true]) {
      it(`preset ${preset}: tool call ok when the forced tool_choice is ${refuses ? 'refused (retried without it)' : 'accepted'}`, async () => {
        const { port, captured } = await start((c) => {
          if (!c.body.tools) {
            return { status: 200, body: { choices: [{ message: { content: 'OK' } }] } };
          }
          if (refuses && c.body.tool_choice) {
            const message = preset === 'deepseek' ? REFUSALS.deepseek : REFUSALS.other;
            return { status: 400, body: { error: { message } } };
          }
          return {
            status: 200,
            body: {
              choices: [
                { message: { tool_calls: [{ type: 'function', function: { name: 'ping' } }] } },
              ],
            },
          };
        });
        const result = await runProviderTest({
          provider: provider(api, port),
          model,
          realKey: REAL_KEY,
          timeoutMs: 2000,
        });
        expect(result).toMatchObject({ completion: 'ok', tool_call: 'ok', error: null });
        expect(captured).toHaveLength(refuses ? 3 : 2);
      });
    }
  }

  it('when the retry without tool_choice fails too, the error names both rejections', async () => {
    const { port, captured } = await start((c) =>
      c.body.tools
        ? { status: 400, body: { error: { message: `tools are not supported (${REAL_KEY})` } } }
        : { status: 200, body: { choices: [{ message: { content: 'OK' } }] } },
    );
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'error' });
    expect(captured).toHaveLength(3);
    expect(result.error).toMatch(/^HTTP 400: tools are not supported/);
    expect(result.error).toContain('forced tool_choice was rejected');
    expect(JSON.stringify(result)).not.toContain(REAL_KEY);
  });

  it('does not retry a non-400 tool-call failure (401 / 429 / 5xx would fail the same way)', async () => {
    const { port, captured } = await start((c) =>
      c.body.tools
        ? { status: 429, body: { error: { message: 'slow down' } } }
        : { status: 200, body: { choices: [{ message: { content: 'OK' } }] } },
    );
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({
      completion: 'ok',
      tool_call: 'error',
      error: 'HTTP 429: slow down',
    });
    expect(captured).toHaveLength(2);
  });

  it('reports a tool-call failure when the model answers in prose instead of calling the tool', async () => {
    const { port } = await start(() => ({
      status: 200,
      body: { choices: [{ message: { content: 'pong' } }] },
    }));
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'error' });
    expect(result.error).toContain('no call of "ping"');
  });

  it('anthropic-messages: a reply with only thinking and text (no tool_use) is a tool-call failure under auto tool_choice', async () => {
    const { port } = await start((c) =>
      c.body.tools
        ? {
            status: 200,
            body: {
              content: [
                { type: 'thinking', thinking: '', signature: 'sig' },
                { type: 'text', text: 'pong' },
              ],
              stop_reason: 'end_turn',
            },
          }
        : { status: 200, body: { content: [{ type: 'text', text: 'OK' }] } },
    );
    const result = await runProviderTest({
      provider: provider('anthropic-messages', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'error' });
    expect(result.error).toContain('no call of "ping"');
  });

  it('anthropic-messages: a thinking-only reply (max_tokens hit before any tool_use) is a tool-call failure', async () => {
    const { port } = await start((c) =>
      c.body.tools
        ? {
            status: 200,
            body: {
              content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
              stop_reason: 'max_tokens',
            },
          }
        : { status: 200, body: { content: [{ type: 'text', text: 'OK' }] } },
    );
    const result = await runProviderTest({
      provider: provider('anthropic-messages', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'ok', tool_call: 'error' });
    expect(result.error).toContain('no call of "ping"');
  });

  it('reports an upstream 401 as a completion error with a scrubbed excerpt and skips the tool call', async () => {
    const { port, captured } = await start(() => ({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${REAL_KEY}` } },
    }));
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ completion: 'error', tool_call: 'skipped' });
    expect(result.error).toBe('HTTP 401: Incorrect API key provided: ***');
    expect(captured).toHaveLength(1);
  });

  it('redacts a token-like string in the upstream error even when it is not the exact key this test used (P3 hotfix, post-v0.16.0 review)', async () => {
    const leakedToken = 'sk-leaked-other-provider-1234567890';
    const { port } = await start(() => ({
      status: 401,
      body: {
        error: {
          message: `upstream misconfigured, saw stray credential ${leakedToken} in a shared error template`,
        },
      },
    }));
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result.error).not.toContain(leakedToken);
    expect(result.error).toContain('***');
  });

  it('redacts a long base64-ish run in the upstream error even with no sk/key/tok prefix', async () => {
    const longRun = 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8';
    const { port } = await start(() => ({
      status: 500,
      body: { error: { message: `internal error, trace=${longRun}` } },
    }));
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result.error).not.toContain(longRun);
    expect(result.error).toContain('***');
  });

  it('does not read an upstream answer past the byte cap (STATUS leftover 138)', async () => {
    const { port } = await start(() => ({
      status: 200,
      body: { padding: 'x'.repeat(PROVIDER_TEST_MAX_RESPONSE_BYTES + 1) },
    }));
    const result = await runProviderTest({
      provider: provider('openai-completions', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 5000,
    });
    expect(result.completion).toBe('error');
    expect(result.tool_call).toBe('skipped');
    expect(result.error).toBe('HTTP 200: the response was larger than 256 KiB and was not read');
  });

  it('reports an unreachable upstream as an error, not an exception', async () => {
    const result = await runProviderTest({
      provider: { ...provider('openai-completions', 1), upstream_base_url: 'http://127.0.0.1:1' },
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result.completion).toBe('error');
    expect(result.error).toContain('completion request failed');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('a redirecting upstream fails the test; the x-api-key is never resent to the named host (R-23, L6-19)', async () => {
    const { port: elsewherePort, captured: elsewhere } = await start(() => ({
      status: 200,
      body: { content: [{ type: 'text', text: 'OK' }] },
    }));
    const redirecting = http.createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${elsewherePort}/v1/messages` });
      res.end();
    });
    const port = await listen(redirecting);
    cleanup.push(() => new Promise<void>((resolve) => redirecting.close(() => resolve())));
    const result = await runProviderTest({
      provider: provider('anthropic-messages', port),
      model: 'm',
      realKey: REAL_KEY,
      timeoutMs: 2000,
    });
    expect(result.completion).toBe('error');
    expect(result.error).toContain('completion request failed');
    expect(elsewhere).toEqual([]);
  });
});
