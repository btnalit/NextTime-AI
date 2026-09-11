// deploy/accept/driver.mjs — the one JSON-RPC / HTTP driver behind every acceptance and drill
// script (scripts/accept_s1.sh, accept_s2.sh, accept_s3.sh, drill-add-gatekeeper.sh; W6, STATUS
// leftover 7 / retrospective-2026-09-09.md §5.2). Before W6 each script embedded its own
// near-identical copy as a heredoc; a fix (the stdout flush below, a changed capability
// parameter) had to be applied four times and was untestable. Now the scripts only orchestrate:
// scripts/lib/accept-common.sh's `run_driver` bind-mounts this file read-only into a throwaway
// kernel-image container on the control network and runs `node /tmp/driver.mjs <subcommand>
// ...`. The host has no node/corepack (docs/runbooks/accept-s1.md §1), which is why the driver
// runs inside the kernel image; it talks to the kernel directly (http://kernel:8080, ws://
// kernel:8080/ws) rather than through caddy's self-signed TLS.
//
// Deliberately a plain .mjs that is mounted, not a TS CLI baked into the kernel image: every
// harness edit would otherwise need a kernel image rebuild on the host, and the `eval`-based
// extraction below has no place under the kernel's lint/depcruise rules. It is exercised by
// packages/kernel/src/interfaces/accept-driver.test.ts against an in-process fake kernel.
//
// Output contract (unchanged from the four originals): every subcommand prints `KEY=value` lines
// on stdout — never JSON, the calling POSIX shell has no JSON parser — and exits 0. Any thrown
// error prints `ERROR=<message>` and exits 1. Keys are documented per subcommand below; the shell
// side reads them with `parse_kv` (last matching line wins, so noise on stderr is harmless).
//
// Subcommands:
//   cap <token> <capabilityName> <paramsJson> [extractExpr]
//     POST /api/cap/<capabilityName> with `Authorization: Bearer <token>` (omitted when token is
//     empty). Prints HTTP_STATUS= then BODY=<raw json, one line>, then the optional extraction.
//   send-and-wait <token> <chatId|""> <text> <timeoutMs> [strict]
//     Chat WS (design doc §9.4): authenticate -> new_chat if chatId is empty -> subscribe_chat ->
//     send_chat_message(text) -> wait for that Turn's chat.metadata turnStatus or timeoutMs ->
//     get_chat_history. Prints CHAT_ID/TURN_ID/TURN_STATUS/ECHO_SEEN/HISTORY_COUNT plus (W7) the
//     Turn's tool-call outcomes counted from the ephemeral chat.stream deltas: TOOL_CALLS
//     (toolCallStarted), TOOL_ENDED (toolCallEnded), TOOL_ERRORS (toolCallEnded with
//     isError:true), TOOL_ERRORS_KNOWN (toolCallEnded that carried an isError at all — 0 on a
//     runtime that predates the field), TOOL_NAMES and TOOL_ERROR_NAMES (comma-joined). On timeout
//     the default is to report TURN_STATUS= (empty) and exit 0 — accept_s2's entry-mode-gap
//     scenarios deliberately never settle and the caller needs to observe that; pass `strict` as
//     the fifth argument (accept_s1.sh) to make a timeout an ERROR= + exit 1 instead.
//   send-only <token> <chatId> <text>
//     authenticate -> send_chat_message, print CHAT_ID/TURN_ID without waiting (accept_s1's
//     egress step overlaps a container-internal curl with the running Turn).
//   isolation-check <token> <otherChatId>
//     authenticate as a second principal -> get_chat_history on someone else's chat (expect a
//     JSON-RPC error; -32004 = NOT_FOUND) -> list_chats. Prints HISTORY_ERROR_CODE and
//     LIST_CONTAINS_OTHER (1/0).
//   get-history <token> <chatId> [extractExpr]
//     authenticate -> get_chat_history. Prints RESULT=<json array of messages> plus extraction.
//   explorer <apiKey> <path>
//     GET <path> with `x-api-key` (the Explorer API key). Prints HTTP_STATUS= and BODY=.
//   mcp <token> <method> <paramsJson> [extractExpr]
//     One MCP JSON-RPC request to POST /mcp. Prints HTTP_STATUS=, BODY= and the extraction.
//   gate-health <gateUrl>
//     GET <gateUrl>/gate/health with the kernel container's own /run/secrets/gate_token as
//     Bearer (every gate route needs it since the gate-protocol hardening). Prints OK=true|false.
//   transcript-stats <path>
//     (W7) Tool-call outcomes of one Worker run, read from its pi session JSONL (mounted
//     read-only by the caller; no kernel call). Prints ASSISTANT_MESSAGES=, MODEL= and the same
//     TOOL_* fields as send-and-wait. See cmdTranscriptStats for the pinned pi entry shape.
//
// Extraction: when `extractExpr` is given it is evaluated as a JS expression with `d` bound to the
// parsed response (or the messages array for get-history) and printed as EXTRACTED=<value>
// (strings verbatim, everything else JSON-stringified; undefined/null or any failure prints an
// empty EXTRACTED= line, plus EXTRACT_ERROR= on failure, never a thrown error). The expression is
// authored by the calling script, never untrusted input.
//
// Endpoints come from the environment so the test can point the driver at a local fake kernel:
// KERNEL_HTTP (default http://kernel:8080) and WS_URL (default ws://kernel:8080/ws).
// GATE_TOKEN_FILE (default /run/secrets/gate_token) is read only by gate-health.

import { readFileSync } from 'node:fs';

const KERNEL_HTTP = process.env.KERNEL_HTTP || 'http://kernel:8080';
const WS_URL = process.env.WS_URL || 'ws://kernel:8080/ws';
const GATE_TOKEN_FILE = process.env.GATE_TOKEN_FILE || '/run/secrets/gate_token';
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 30000);

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error(`ws connect failed: ${url}`)));
  });
}

function idCounter() {
  let n = 0;
  return () => {
    n += 1;
    return n;
  };
}

/** One JSON-RPC request/response pair over an already-open socket (§9.4). Ignores push
 *  notifications (frames with no `id`) and replies for any other in-flight id — several `call()`s
 *  and one `onPush()` listener can coexist on the same socket. */
function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`rpc timeout: ${method}`));
    }, RPC_TIMEOUT_MS);
    function onMessage(ev) {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) {
        reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      } else {
        resolve(msg.result);
      }
    }
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
  });
}

/** Registers a listener for every push notification (a frame with no `id` — §9.4
 *  chat.message/chat.stream/chat.metadata) for the socket's lifetime. */
function onPush(ws, handler) {
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) return; // request/response frame, not a push
    if (typeof msg.method === 'string') handler(msg);
  });
}

function print(fields) {
  for (const [k, v] of Object.entries(fields)) console.log(`${k}=${v}`);
}

function printExtraction(parsed, expr) {
  if (!expr) return;
  try {
    const d = parsed;
    // expr is authored by the calling script, never untrusted input; see the header comment.
    // eslint-disable-next-line no-eval
    const v = eval(expr);
    if (v === undefined || v === null) {
      console.log('EXTRACTED=');
    } else {
      console.log(`EXTRACTED=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  } catch (err) {
    console.log('EXTRACTED=');
    console.log(`EXTRACT_ERROR=${err?.message || String(err)}`);
  }
}

function parseJsonOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function cmdCap(args) {
  const [token, capabilityName, paramsJson, extractExpr] = args;
  const res = await fetch(`${KERNEL_HTTP}/api/cap/${capabilityName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: paramsJson && paramsJson.length > 0 ? paramsJson : '{}',
  });
  const text = await res.text();
  console.log(`HTTP_STATUS=${res.status}`);
  console.log(`BODY=${text}`);
  printExtraction(parseJsonOrUndefined(text), extractExpr);
}

async function cmdSendAndWait(args) {
  const [token, chatIdArg, text, timeoutMsArg, mode] = args;
  const timeoutMs = Number(timeoutMsArg || 120000);
  const strict = mode === 'strict';
  const ws = await connect(WS_URL);
  const nextId = idCounter();
  await call(ws, nextId(), 'authenticate', { token });

  let chatId = chatIdArg;
  if (!chatId) {
    const chat = await call(ws, nextId(), 'new_chat', {});
    chatId = chat.id;
  }

  await call(ws, nextId(), 'subscribe_chat', { chatId, startAfter: '0' });

  let turnId;
  let turnStatus;
  let echoSeen = false;
  // W7: tool-call outcome counters from the ephemeral `chat.stream` deltas — every
  // `toolCallStarted` is one call, every `toolCallEnded` with `isError: true` is one error
  // (the agent runtime's own verdict, forwarded from pi's `tool_execution_end`; absent on an
  // older runtime, in which case TOOL_ERRORS stays at 0 and TOOL_ERRORS_KNOWN reports 0).
  const toolStats = newToolStats();
  const settled = new Promise((resolve) => {
    onPush(ws, (msg) => {
      if (msg.method === 'chat.metadata' && msg.params?.chatId === chatId) {
        const md = msg.params.metadata ?? {};
        if (turnId && md.turnId === turnId && md.turnStatus) {
          turnStatus = md.turnStatus;
          resolve();
        }
      }
      if (msg.method === 'chat.message' && msg.params?.chatId === chatId) {
        const m = msg.params.message ?? {};
        if (m.role === 'assistant' && typeof m.text === 'string' && m.text.includes('echo:')) {
          echoSeen = true;
        }
      }
      if (msg.method === 'chat.stream' && msg.params?.chatId === chatId) {
        recordStreamPayload(toolStats, msg.params.payload ?? {});
      }
    });
  });

  const sendResult = await call(ws, nextId(), 'send_chat_message', { chatId, text });
  turnId = sendResult.turnId;

  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('turn did not settle before timeout')), timeoutMs);
  });
  try {
    await Promise.race([settled, timedOut]);
  } catch (err) {
    // Non-strict (accept_s2/accept_s3): a timeout is reported as TURN_STATUS= (empty), not as an
    // ERROR= — see the header. Strict (accept_s1): it is a failure of the step itself.
    if (strict) {
      ws.close();
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }

  const history = await call(ws, nextId(), 'get_chat_history', { chatId });

  print({
    CHAT_ID: chatId,
    TURN_ID: turnId,
    TURN_STATUS: turnStatus ?? '',
    ECHO_SEEN: echoSeen ? 1 : 0,
    HISTORY_COUNT: history.items.length,
    ...toolStatsFields(toolStats),
  });
  ws.close();
}

// ---- W7: tool-call outcome counting -----------------------------------------------------------

function newToolStats() {
  return {
    calls: 0,
    ended: 0,
    errors: 0,
    errorsKnown: 0,
    names: [],
    errorNames: [],
    byId: new Map(),
  };
}

/** One `chat.stream` payload (`toolCallStarted` / `toolCallEnded`); anything else is ignored. */
function recordStreamPayload(stats, payload) {
  if (payload.streamKind === 'toolCallStarted') {
    stats.calls += 1;
    const name = typeof payload.name === 'string' ? payload.name : '?';
    stats.names.push(name);
    if (typeof payload.toolCallId === 'string') stats.byId.set(payload.toolCallId, name);
    return;
  }
  if (payload.streamKind === 'toolCallEnded') {
    stats.ended += 1;
    if (typeof payload.isError === 'boolean') {
      stats.errorsKnown += 1;
      if (payload.isError) {
        stats.errors += 1;
        stats.errorNames.push(stats.byId.get(payload.toolCallId) ?? '?');
      }
    }
  }
}

/** The KEY=value fields both `send-and-wait` and `transcript-stats` print (same names, so a shell
 *  caller parses either with the same parse_kv calls). */
function toolStatsFields(stats) {
  return {
    TOOL_CALLS: stats.calls,
    TOOL_ENDED: stats.ended,
    TOOL_ERRORS: stats.errors,
    TOOL_ERRORS_KNOWN: stats.errorsKnown,
    TOOL_NAMES: stats.names.join(','),
    TOOL_ERROR_NAMES: stats.errorNames.join(','),
  };
}

/**
 * transcript-stats <path>: tool-call outcomes of one Worker run, read from the Worker's own pi
 * session JSONL (`sessionJsonlPath` on the `report_task_result` contract; on the host
 * `${NEXTTIME_DATA}/workspaces/tasks/<taskId>/.pi/sessions/*.jsonl`, mounted read-only into this
 * container by the caller). Format (pi-coding-agent 0.84.x, pinned by
 * scripts/check-pi-version-consistency.sh): one JSON entry per line; `type: "message"` entries
 * carry `message.role` = `assistant` (with `content[]` blocks, `type: "toolCall"` = one call,
 * `name`) or `toolResult` (`toolName`, `isError: boolean`). Counts every toolCall block as a call
 * and every toolResult as an ended call, `isError` known for each of them. Prints the same
 * TOOL_* fields as send-and-wait plus ASSISTANT_MESSAGES= and MODEL=.
 */
async function cmdTranscriptStats(args) {
  const [filePath] = args;
  if (!filePath) throw new Error('transcript-stats: missing <path>');
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(filePath, 'utf8');
  const stats = newToolStats();
  let assistantMessages = 0;
  let model = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    if (message.role === 'assistant') {
      assistantMessages += 1;
      if (typeof message.model === 'string' && !model) model = message.model;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'toolCall') {
          recordStreamPayload(stats, {
            streamKind: 'toolCallStarted',
            toolCallId: block.id,
            name: block.name,
          });
        }
      }
    } else if (message.role === 'toolResult') {
      recordStreamPayload(stats, {
        streamKind: 'toolCallEnded',
        toolCallId: message.toolCallId,
        isError: typeof message.isError === 'boolean' ? message.isError : undefined,
      });
    }
  }
  print({ ASSISTANT_MESSAGES: assistantMessages, MODEL: model, ...toolStatsFields(stats) });
}

async function cmdSendOnly(args) {
  const [token, chatId, text] = args;
  const ws = await connect(WS_URL);
  const nextId = idCounter();
  await call(ws, nextId(), 'authenticate', { token });
  const sendResult = await call(ws, nextId(), 'send_chat_message', { chatId, text });
  print({ CHAT_ID: chatId, TURN_ID: sendResult.turnId });
  ws.close();
}

async function cmdIsolationCheck(args) {
  const [token, otherChatId] = args;
  const ws = await connect(WS_URL);
  const nextId = idCounter();
  await call(ws, nextId(), 'authenticate', { token });

  let historyErrorCode = 'none';
  try {
    await call(ws, nextId(), 'get_chat_history', { chatId: otherChatId });
  } catch (err) {
    historyErrorCode = String(err?.code ?? 'unknown');
  }

  const chats = await call(ws, nextId(), 'list_chats', {});
  const containsOther =
    Array.isArray(chats.items) && chats.items.some((c) => c.id === otherChatId) ? 1 : 0;

  print({ HISTORY_ERROR_CODE: historyErrorCode, LIST_CONTAINS_OTHER: containsOther });
  ws.close();
}

async function cmdGetHistory(args) {
  const [token, chatId, extractExpr] = args;
  const ws = await connect(WS_URL);
  const nextId = idCounter();
  await call(ws, nextId(), 'authenticate', { token });
  const history = await call(ws, nextId(), 'get_chat_history', { chatId });
  console.log(`RESULT=${JSON.stringify(history.items)}`);
  printExtraction(history.items, extractExpr);
  ws.close();
}

async function cmdExplorer(args) {
  const [apiKey, path] = args;
  const res = await fetch(`${KERNEL_HTTP}${path}`, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  });
  const text = await res.text();
  console.log(`HTTP_STATUS=${res.status}`);
  console.log(`BODY=${text}`);
}

async function cmdMcp(args) {
  const [token, method, paramsJson, extractExpr] = args;
  const res = await fetch(`${KERNEL_HTTP}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: paramsJson && paramsJson.length > 0 ? JSON.parse(paramsJson) : {},
    }),
  });
  const text = await res.text();
  console.log(`HTTP_STATUS=${res.status}`);
  console.log(`BODY=${text}`);
  printExtraction(parseJsonOrUndefined(text), extractExpr);
}

async function cmdGateHealth(args) {
  const [gateUrl] = args;
  const token = readFileSync(GATE_TOKEN_FILE, 'utf8').trim();
  const res = await fetch(`${gateUrl}/gate/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = parseJsonOrUndefined(await res.text());
  console.log(`OK=${body !== undefined && body.ok === true}`);
}

const COMMANDS = {
  cap: cmdCap,
  'send-and-wait': cmdSendAndWait,
  'send-only': cmdSendOnly,
  'isolation-check': cmdIsolationCheck,
  'get-history': cmdGetHistory,
  explorer: cmdExplorer,
  mcp: cmdMcp,
  'gate-health': cmdGateHealth,
  'transcript-stats': cmdTranscriptStats,
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error(`unknown subcommand: ${cmd}`);
  await fn(rest);
}

// Flush stdout before exiting: inside a container stdout is not a synchronous pipe, and
// process.exit() right after a large console.log (explain on a collector Fact is >400KB) drops
// the tail — the EXTRACTED= line — of the output. write('', cb) fires only after every earlier
// chunk has been flushed.
main()
  .then(() => process.stdout.write('', () => process.exit(0)))
  .catch((err) => {
    console.log(`ERROR=${err?.message || String(err)}`);
    process.stdout.write('', () => process.exit(1));
  });
