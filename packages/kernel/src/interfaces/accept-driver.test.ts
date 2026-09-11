import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

/**
 * interfaces/accept-driver.test: exercises `deploy/accept/driver.mjs` (the shared JSON-RPC/HTTP
 * driver behind every acceptance/drill script — its own header comment documents every subcommand
 * and the KEY=value output contract) by spawning it as a real child process against an in-process
 * fake kernel built with `node:http` + `ws`. Not DB-gated: this must run in every CI job.
 */

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const DRIVER_PATH = path.join(REPO_ROOT, 'deploy', 'accept', 'driver.mjs');

interface RecordedCapRequest {
  method: string;
  path: string;
  authorization?: string;
  body: unknown;
}

interface RecordedMcpRequest {
  accept?: string;
  body: unknown;
}

/** Parses the driver's `KEY=value` stdout lines into a map — last occurrence wins, matching the
 *  shell side's own `parse_kv` (see the driver's header comment). */
function parseKv(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

async function runDriver(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number; kv: Map<string, string> }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [DRIVER_PATH, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0, kv: parseKv(stdout) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.code ?? 1,
      kv: parseKv(e.stdout ?? ''),
    };
  }
}

describe('deploy/accept/driver.mjs (against an in-process fake kernel)', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let baseUrl: string;
  let wsUrl: string;
  let gateTokenFile: string;
  const capRequests: RecordedCapRequest[] = [];
  const mcpRequests: RecordedMcpRequest[] = [];
  let listTasksCallCount = 0;
  let listTasksMode: 'progress' | 'always-running' = 'progress';

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const bodyText = await readBody(req);

        const capMatch = url.pathname.match(/^\/api\/cap\/(.+)$/);
        if (capMatch && req.method === 'POST') {
          const name = capMatch[1];
          const parsedBody =
            bodyText.length > 0 ? JSON.parse(bodyText) : ({} as Record<string, unknown>);
          capRequests.push({
            method: req.method,
            path: url.pathname,
            authorization: req.headers.authorization,
            body: parsedBody,
          });
          if (name === 'boom') {
            sendJson(res, 400, { ok: false, error: { code: 'bad' } });
            return;
          }
          if (name === 'big') {
            sendJson(res, 200, { ok: true, pad: 'x'.repeat(600 * 1024) });
            return;
          }
          if (name === 'approve') {
            sendJson(res, 200, { ok: true, result: { id: 'ar1', status: 'approved' } });
            return;
          }
          if (name === 'list_pending') {
            sendJson(res, 200, { ok: true, result: { items: [] } });
            return;
          }
          if (name === 'list_tasks') {
            listTasksCallCount += 1;
            const status =
              listTasksMode === 'always-running'
                ? 'running'
                : listTasksCallCount === 1
                  ? 'running'
                  : 'completed';
            sendJson(res, 200, {
              ok: true,
              result: { items: [{ id: 'task-1', status, workerRuns: [{ id: 'run-1' }] }] },
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            result: { items: [{ id: 'a' }, { id: 'b' }], echo: parsedBody },
          });
          return;
        }

        if (url.pathname === '/explorer/x' && req.method === 'GET') {
          if (req.headers['x-api-key'] !== 'k1') {
            sendJson(res, 401, {});
            return;
          }
          sendJson(res, 200, { nodes: [] });
          return;
        }

        if (url.pathname === '/mcp' && req.method === 'POST') {
          mcpRequests.push({ accept: req.headers.accept, body: JSON.parse(bodyText) });
          sendJson(res, 200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 't1' }] } });
          return;
        }

        if (url.pathname === '/gate/health' && req.method === 'GET') {
          if (req.headers.authorization !== 'Bearer secret-token') {
            sendJson(res, 401, { ok: false });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        sendJson(res, 404, { ok: false });
      })();
    });

    wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws: WsWebSocket) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        const { id, method, params } = msg as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        const reply = (result: unknown) => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
        };
        const replyError = (code: number, message: string) => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
        };
        const push = (pushMethod: string, pushParams: unknown) => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: pushMethod, params: pushParams }));
        };

        switch (method) {
          case 'authenticate':
            reply({ ok: true });
            return;
          case 'new_chat':
            reply({ id: 'chat-1' });
            return;
          case 'subscribe_chat':
            reply({});
            return;
          case 'send_chat_message': {
            const chatId = params?.chatId;
            const text = params?.text;
            reply({ turnId: 'turn-1' });
            if (text !== 'never settles') {
              setTimeout(() => {
                if (text === 'approve please') {
                  push('action.pending', {
                    actionRequestId: 'ar1',
                    gatekeeperId: 'gk-1',
                    title: 'x',
                    description: 'x',
                    actionKind: { tag: 't', label: 't' },
                    awaitDecision: false,
                  });
                }
                if (text === 'tools please') {
                  push('chat.stream', {
                    chatId,
                    turnId: 'turn-1',
                    payload: {
                      streamKind: 'toolCallStarted',
                      toolCallId: 'tc1',
                      name: 'search',
                      args: {},
                    },
                  });
                  push('chat.stream', {
                    chatId,
                    turnId: 'turn-1',
                    payload: {
                      streamKind: 'toolCallEnded',
                      toolCallId: 'tc1',
                      result: { ok: true },
                      isError: false,
                    },
                  });
                  push('chat.stream', {
                    chatId,
                    turnId: 'turn-1',
                    payload: {
                      streamKind: 'toolCallStarted',
                      toolCallId: 'tc2',
                      name: 'traverse',
                      args: {},
                    },
                  });
                  push('chat.stream', {
                    chatId,
                    turnId: 'turn-1',
                    payload: {
                      streamKind: 'toolCallEnded',
                      toolCallId: 'tc2',
                      result: { ok: false },
                      isError: true,
                    },
                  });
                }
                push('chat.message', {
                  chatId,
                  message: { role: 'assistant', text: 'echo: hi' },
                });
                push('chat.metadata', {
                  chatId,
                  metadata: { turnId: 'turn-1', turnStatus: 'completed' },
                });
              }, 50);
            }
            return;
          }
          case 'get_chat_history': {
            const chatId = params?.chatId;
            if (chatId === 'other-chat') {
              replyError(-32004, 'not found');
              return;
            }
            reply({ items: [{ role: 'user' }, { role: 'assistant' }] });
            return;
          }
          case 'list_chats':
            reply({ items: [{ id: 'chat-1' }] });
            return;
          default:
            replyError(-32601, `method not found: ${method}`);
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fixture: server.address() did not return an AddressInfo');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/ws`;

    const dir = mkdtempSync(path.join(tmpdir(), 'accept-driver-test-'));
    gateTokenFile = path.join(dir, 'gate_token');
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function env(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      KERNEL_HTTP: baseUrl,
      WS_URL: wsUrl,
      RPC_TIMEOUT_MS: '2000',
      GATE_TOKEN_FILE: gateTokenFile,
      ...overrides,
    };
  }

  it('cap: posts with a bearer token and extracts a numeric field', async () => {
    const before = capRequests.length;
    const { code, kv } = await runDriver(
      ['cap', 'tok1', 'list_things', '{"q":1}', 'd.result.items.length'],
      env(),
    );
    expect(code).toBe(0);
    expect(kv.get('HTTP_STATUS')).toBe('200');
    expect(JSON.parse(kv.get('BODY') ?? '')).toEqual({
      ok: true,
      result: { items: [{ id: 'a' }, { id: 'b' }], echo: { q: 1 } },
    });
    expect(kv.get('EXTRACTED')).toBe('2');

    const recorded = capRequests[before];
    if (!recorded) throw new Error('fixture: expected a recorded /api/cap request');
    expect(recorded.authorization).toBe('Bearer tok1');
    expect(recorded.body).toEqual({ q: 1 });
  });

  it('cap: empty token omits the authorization header and empty params send {}; error capability returns 400', async () => {
    const before = capRequests.length;
    const { code, kv } = await runDriver(['cap', '', 'list_things', ''], env());
    expect(code).toBe(0);
    const recorded = capRequests[before];
    if (!recorded) throw new Error('fixture: expected a recorded /api/cap request');
    expect(recorded.authorization).toBeUndefined();
    expect(recorded.body).toEqual({});
    expect(kv.get('HTTP_STATUS')).toBe('200');

    const boom = await runDriver(['cap', '', 'boom', '{}'], env());
    expect(boom.kv.get('HTTP_STATUS')).toBe('400');
  });

  it('cap: extraction edge cases — string verbatim, undefined empty, throwing expr reports EXTRACT_ERROR', async () => {
    const stringResult = await runDriver(
      ['cap', '', 'list_things', '{}', 'd.result.items[0].id'],
      env(),
    );
    expect(stringResult.code).toBe(0);
    expect(stringResult.kv.get('EXTRACTED')).toBe('a');

    const undefinedResult = await runDriver(
      ['cap', '', 'list_things', '{}', 'd.result.missingField'],
      env(),
    );
    expect(undefinedResult.code).toBe(0);
    expect(undefinedResult.kv.get('EXTRACTED')).toBe('');

    const throwingResult = await runDriver(['cap', '', 'list_things', '{}', 'd.nope.x'], env());
    expect(throwingResult.code).toBe(0);
    expect(throwingResult.kv.get('EXTRACTED')).toBe('');
    expect(throwingResult.kv.has('EXTRACT_ERROR')).toBe(true);
  });

  it('send-and-wait: default flow settles and reports the full contract', async () => {
    const { code, kv } = await runDriver(['send-and-wait', 'tok', '', 'hi', '3000'], env());
    expect(code).toBe(0);
    expect(kv.get('CHAT_ID')).toBe('chat-1');
    expect(kv.get('TURN_ID')).toBe('turn-1');
    expect(kv.get('TURN_STATUS')).toBe('completed');
    expect(kv.get('ECHO_SEEN')).toBe('1');
    expect(kv.get('HISTORY_COUNT')).toBe('2');
  });

  it('send-and-wait: non-strict timeout reports empty TURN_STATUS and exits 0 with no new_chat call', async () => {
    const { code, kv } = await runDriver(
      ['send-and-wait', 'tok', 'chat-9', 'never settles', '300'],
      env(),
    );
    expect(code).toBe(0);
    expect(kv.get('TURN_STATUS')).toBe('');
    expect(kv.get('CHAT_ID')).toBe('chat-9');
  });

  it('send-and-wait: strict timeout exits 1 with an ERROR mentioning "did not settle"', async () => {
    const { code, kv } = await runDriver(
      ['send-and-wait', 'tok', 'chat-9', 'never settles', '300', 'strict'],
      env(),
    );
    expect(code).toBe(1);
    expect(kv.get('ERROR')).toContain('did not settle');
  });

  it('send-and-wait: W7 tool-call outcome counters from chat.stream pushes', async () => {
    const { code, kv } = await runDriver(
      ['send-and-wait', 'tok', '', 'tools please', '3000'],
      env(),
    );
    expect(code).toBe(0);
    expect(kv.get('TOOL_CALLS')).toBe('2');
    expect(kv.get('TOOL_ENDED')).toBe('2');
    expect(kv.get('TOOL_ERRORS')).toBe('1');
    expect(kv.get('TOOL_ERRORS_KNOWN')).toBe('2');
    expect(kv.get('TOOL_NAMES')).toBe('search,traverse');
    expect(kv.get('TOOL_ERROR_NAMES')).toBe('traverse');
  });

  it('send-and-wait: an ordinary turn with no stream pushes reports zero tool-call counters', async () => {
    const { code, kv } = await runDriver(['send-and-wait', 'tok', '', 'hi', '3000'], env());
    expect(code).toBe(0);
    expect(kv.get('TOOL_CALLS')).toBe('0');
    expect(kv.get('TOOL_ERRORS_KNOWN')).toBe('0');
  });

  it('send-and-wait: auto-approve approves a matching action.pending push', async () => {
    const before = capRequests.length;
    const { code, kv } = await runDriver(
      ['send-and-wait', 'tok', '', 'approve please', '3000', 'auto-approve=gk-1'],
      env(),
    );
    expect(code).toBe(0);
    expect(kv.get('APPROVED')).toBe('ar1');
    const approveRequests = capRequests.slice(before).filter((r) => r.path === '/api/cap/approve');
    expect(approveRequests).toHaveLength(1);
    expect(approveRequests[0]?.body).toEqual({ actionRequestId: 'ar1' });
  });

  it('send-and-wait: auto-approve ignores an action.pending push for a non-matching gatekeeper', async () => {
    const before = capRequests.length;
    const { code, kv } = await runDriver(
      ['send-and-wait', 'tok', '', 'approve please', '3000', 'auto-approve=gk-other'],
      env(),
    );
    expect(code).toBe(0);
    expect(kv.get('APPROVED')).toBe('');
    const approveRequests = capRequests.slice(before).filter((r) => r.path === '/api/cap/approve');
    expect(approveRequests).toHaveLength(0);
  });

  it('send-and-wait: without auto-approve there is no APPROVED= line at all', async () => {
    const { code, kv } = await runDriver(
      ['send-and-wait', 'tok', '', 'approve please', '3000'],
      env(),
    );
    expect(code).toBe(0);
    expect(kv.has('APPROVED')).toBe(false);
  });

  it('wait-task: polls until the Task reaches a terminal status', async () => {
    listTasksMode = 'progress';
    listTasksCallCount = 0;
    const { code, kv } = await runDriver(['wait-task', 'tok', 'task-1', '10000'], env());
    expect(code).toBe(0);
    expect(kv.get('TASK_STATUS')).toBe('completed');
    expect(kv.get('WORKER_RUN_ID')).toBe('run-1');
  }, 10000);

  it('wait-task: timeout reports empty TASK_STATUS and exits 0', async () => {
    listTasksMode = 'always-running';
    listTasksCallCount = 0;
    const { code, kv } = await runDriver(['wait-task', 'tok', 'task-1', '2500'], env());
    expect(code).toBe(0);
    expect(kv.get('TASK_STATUS')).toBe('');
  }, 8000);

  it('wait-task: missing taskId prints ERROR= and exits 1', async () => {
    const { code, kv } = await runDriver(['wait-task', 'tok', '', '1000'], env());
    expect(code).toBe(1);
    expect(kv.get('ERROR')).toContain('missing <taskId>');
  });

  it('send-only: sends without waiting and reports CHAT_ID/TURN_ID', async () => {
    const { code, kv } = await runDriver(['send-only', 'tok', 'chat-1', 'hi'], env());
    expect(code).toBe(0);
    expect(kv.get('CHAT_ID')).toBe('chat-1');
    expect(kv.get('TURN_ID')).toBe('turn-1');
  });

  it('isolation-check: another principal’s chat is inaccessible and not listed', async () => {
    const { code, kv } = await runDriver(['isolation-check', 'tok', 'other-chat'], env());
    expect(code).toBe(0);
    expect(kv.get('HISTORY_ERROR_CODE')).toBe('-32004');
    expect(kv.get('LIST_CONTAINS_OTHER')).toBe('0');
  });

  it('get-history: prints RESULT as a JSON array and extracts its length', async () => {
    const { code, kv } = await runDriver(['get-history', 'tok', 'chat-1', 'd.length'], env());
    expect(code).toBe(0);
    const result = JSON.parse(kv.get('RESULT') ?? '');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(kv.get('EXTRACTED')).toBe('2');
  });

  it('explorer: correct api key returns 200, wrong key returns 401', async () => {
    const ok = await runDriver(['explorer', 'k1', '/explorer/x'], env());
    expect(ok.code).toBe(0);
    expect(ok.kv.get('HTTP_STATUS')).toBe('200');
    expect(JSON.parse(ok.kv.get('BODY') ?? '')).toEqual({ nodes: [] });

    const wrongKey = await runDriver(['explorer', 'nope', '/explorer/x'], env());
    expect(wrongKey.kv.get('HTTP_STATUS')).toBe('401');
  });

  it('mcp: posts a JSON-RPC request with an SSE-capable accept header', async () => {
    const before = mcpRequests.length;
    const { code, kv } = await runDriver(
      ['mcp', 'tok', 'tools/list', '{}', 'd.result.tools.length'],
      env(),
    );
    expect(code).toBe(0);
    expect(kv.get('HTTP_STATUS')).toBe('200');
    expect(kv.get('EXTRACTED')).toBe('1');
    const recorded = mcpRequests[before];
    if (!recorded) throw new Error('fixture: expected a recorded /mcp request');
    expect(recorded.accept).toContain('text/event-stream');
  });

  it('gate-health: reports OK based on the token file contents', async () => {
    writeFileSync(gateTokenFile, 'secret-token\n');
    const good = await runDriver(['gate-health', baseUrl], env());
    expect(good.code).toBe(0);
    expect(good.kv.get('OK')).toBe('true');

    writeFileSync(gateTokenFile, 'wrong');
    const bad = await runDriver(['gate-health', baseUrl], env());
    expect(bad.code).toBe(0);
    expect(bad.kv.get('OK')).toBe('false');
  });

  it('unknown subcommand exits 1 with an ERROR line', async () => {
    const { code, kv } = await runDriver(['nope'], env());
    expect(code).toBe(1);
    expect(kv.get('ERROR')).toBe('unknown subcommand: nope');
  });

  it('large output is not truncated: the last stdout line is still EXTRACTED=true', async () => {
    const { code, stdout } = await runDriver(['cap', '', 'big', '{}', 'd.ok'], env());
    expect(code).toBe(0);
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toBe('EXTRACTED=true');
  });
});

describe('deploy/accept/driver.mjs transcript-stats (against a fixture pi session JSONL)', () => {
  let dir: string;
  let jsonlPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'accept-driver-transcript-'));
    jsonlPath = path.join(dir, 'session.jsonl');
    const lines = [
      { type: 'session', id: 's1' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          model: 'provider/model-x',
          content: [
            { type: 'toolCall', id: 'c1', name: 'bash' },
            { type: 'toolCall', id: 'c2', name: 'report_result' },
          ],
        },
      },
      {
        type: 'message',
        message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', isError: true },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'report_result',
          isError: false,
        },
      },
      'not json',
      { type: 'thinking_level_change' },
    ];
    writeFileSync(
      jsonlPath,
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses the fixture into ASSISTANT_MESSAGES/MODEL and the TOOL_* fields', async () => {
    const { code, kv } = await runDriver(['transcript-stats', jsonlPath], {});
    expect(code).toBe(0);
    expect(kv.get('ASSISTANT_MESSAGES')).toBe('1');
    expect(kv.get('MODEL')).toBe('provider/model-x');
    expect(kv.get('TOOL_CALLS')).toBe('2');
    expect(kv.get('TOOL_ENDED')).toBe('2');
    expect(kv.get('TOOL_ERRORS')).toBe('1');
    expect(kv.get('TOOL_ERRORS_KNOWN')).toBe('2');
    expect(kv.get('TOOL_NAMES')).toBe('bash,report_result');
    expect(kv.get('TOOL_ERROR_NAMES')).toBe('bash');
  });

  it('a missing path argument prints ERROR= and exits 1', async () => {
    const { code, kv } = await runDriver(['transcript-stats'], {});
    expect(code).toBe(1);
    expect(kv.get('ERROR')).toContain('missing <path>');
  });
});
