import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from './config.js';
import { runProviderTest } from './provider-test.js';

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
    expect(captured[1]?.body.tool_choice).toEqual({ type: 'tool', name: 'ping' });
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
});
