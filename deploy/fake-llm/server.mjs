#!/usr/bin/env node
// fake-llm: a deterministic OpenAI-compatible chat-completions test double used as an
// `llm-proxy` upstream for tests and the S1.10 acceptance path (design doc §7.7, S1.10;
// docs/development-tasks.md S1.5, second half, deliverable 4: "a tiny Node/TS server, no deps
// beyond node"). Written directly in plain ESM JavaScript rather than TypeScript+build: this
// directory is not a pnpm workspace package (`pnpm-workspace.yaml` only globs `packages/*`), so
// adding a TS toolchain here would mean a second, bespoke build step for one file — running the
// source directly with plain `node` is the actual minimal-dependencies reading of "no deps beyond
// node", and keeps this file buildable with nothing but the base `node:24-bookworm-slim` image
// (see this directory's Dockerfile).
//
// Endpoints:
//   GET  /healthz            -> {status:"ok"}
//   GET  /v1/models          -> OpenAI-shaped models list (one model: fake-echo). Never actually
//                                reached through llm-proxy (proxy.ts's respondModelsList
//                                synthesizes /v1/models from the provider's own whitelist without
//                                calling upstream at all) — implemented anyway per this task's own
//                                deliverable list, and useful for testing this server directly.
//   POST /v1/chat/completions -> deterministic reply: `echo: <last user message text>`.
//                                stream:true (SSE) and non-streaming JSON are both supported —
//                                pi always streams, but this is also exercised directly by
//                                packages/llm-proxy's own byte-for-byte SSE passthrough tests
//                                (docs/development-tasks.md S1.7 acceptance).
//
// Tool-call trigger (this task's own deliverable text: "when the prompt contains a tool-use
// trigger word, emits one tool_calls delta so tool-call rows appear"): when the last user
// message's text contains the word "search" (case-insensitive), the reply is a single `search`
// tool call (`search` is one of the entry mode's registered observe tools —
// packages/platform-extension/src/modes/entry.ts's OBSERVE_CAPABILITY_NAMES — so pi actually
// executes it for real against the kernel) with arguments `{"query":"test"}`, `finish_reason:
// "tool_calls"`, no text content. Otherwise the reply is plain echoed text, `finish_reason:
// "stop"`. Verified against pi 0.84.4's own OpenAI-compatible streaming parser
// (pi-0.84.4/packages/ai/src/api/openai-completions.ts) for the exact chunk shapes it expects —
// same source this task's kernel-side `packages/agent-host/src/bridge.ts` cites for the
// event-vocabulary side of the same verification.
//
// No inbound auth check: llm-proxy (packages/llm-proxy/src/proxy.ts) is the trust boundary that
// verifies the caller's Handle and substitutes the real upstream key before ever reaching here —
// this double intentionally does not re-implement that boundary, matching its own scope (an
// upstream stand-in, not a proxy replacement).

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8090);
const MODEL_ID = 'fake-echo';
const TOOL_TRIGGER_WORD = 'search';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Extracts the last `role: 'user'` message's text — `content` may be a bare string or an array
 *  of `{type:'text', text}`/other content parts (OpenAI's content-parts shape); non-text parts
 *  are ignored. */
function lastUserMessageText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const { content } = message;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    }
    return '';
  }
  return '';
}

/** Rough token-count estimate (not tied to any real tokenizer — this is a test double; only the
 *  shape and presence of `usage` matters to `llm-proxy`'s own parsing). */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length > 0 ? chunks : [''];
}

function baseChunk(id, created) {
  return { id, object: 'chat.completion.chunk', created, model: MODEL_ID };
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleChatCompletions(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: { message: `invalid JSON body: ${String(err)}` } });
    return;
  }

  const promptText = lastUserMessageText(parsed.messages);
  const replyText = `echo: ${promptText}`;
  const wantsToolCall = promptText.toLowerCase().includes(TOOL_TRIGGER_WORD);
  const stream = parsed.stream === true;

  const id = `fake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCallId = `call_${Math.random().toString(36).slice(2, 10)}`;
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(wantsToolCall ? '{"query":"test"}' : replyText);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };

  if (!stream) {
    const message = wantsToolCall
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: { name: TOOL_TRIGGER_WORD, arguments: '{"query":"test"}' },
            },
          ],
        }
      : { role: 'assistant', content: replyText };
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: MODEL_ID,
      choices: [
        { index: 0, message, finish_reason: wantsToolCall ? 'tool_calls' : 'stop' },
      ],
      usage,
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  writeSse(res, {
    ...baseChunk(id, created),
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  if (wantsToolCall) {
    writeSse(res, {
      ...baseChunk(id, created),
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: toolCallId, type: 'function', function: { name: TOOL_TRIGGER_WORD, arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    writeSse(res, {
      ...baseChunk(id, created),
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"test"}' } }] },
          finish_reason: null,
        },
      ],
    });
    writeSse(res, {
      ...baseChunk(id, created),
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
  } else {
    for (const piece of chunkText(replyText, 12)) {
      writeSse(res, {
        ...baseChunk(id, created),
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      });
    }
    writeSse(res, {
      ...baseChunk(id, created),
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
  }

  // Final usage-only chunk (`choices: []`) — the OpenAI streaming convention `stream_options.
  // include_usage: true` triggers; llm-proxy's proxy.ts always forces this flag on for a
  // streaming openai-completions/openai-responses request, so always sending it here matches
  // what a real upstream configured that way would do.
  writeSse(res, { ...baseChunk(id, created), choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

function respondModels(res) {
  sendJson(res, 200, {
    object: 'list',
    data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'fake-llm' }],
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake-llm.internal');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    respondModels(res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    handleChatCompletions(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: String(err) } });
      } else {
        res.end();
      }
    });
    return;
  }

  sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'fake-llm: listening', port: PORT }));
});
