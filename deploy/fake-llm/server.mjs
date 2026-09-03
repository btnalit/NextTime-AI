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
//
// S2.12 scripted scenarios (scripts/accept_s2.sh; see SCENARIOS below): additive to every one of
// the behaviors described above, which remain byte-for-byte unchanged for any request that does
// not match a scenario — `handleChatCompletions` tries `matchScenario()` first and only falls
// through to the original search/echo logic when nothing matches, so accept_s1.sh (and every
// existing test) keeps working against this same file untouched.

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

// -------------------------------------------------------------------------------------------
// S2.12 scripted scenarios (docs/development-tasks.md S2.12; scripts/accept_s2.sh).
//
// Deterministic acceptance runs need the model to call specific tools in a specific order for
// specific Worker/entry invocations — accept_s2.sh cannot rely on the `search`-trigger's single
// fixed tool call for that. A scenario is selected by a marker substring found *anywhere* in the
// full JSON-serialized `messages` array (not only the last `user`/`system` message, unlike
// `lastUserMessageText` above): a Worker's actual task text reaches the model through a
// `context`-injected message (packages/platform-extension/src/modes/worker.ts's
// `renderWorkerContext`, role `'custom'`) rather than as the literal last user message, and
// whether/how pi's OpenAI-completions adapter maps a `role:'custom'` message onto a wire role is
// not something this test double should have to assume — searching the whole serialized body is
// robust to that either way. accept_s2.sh embeds one `ACCEPT_S2_SCENARIO=<id> KEY=value ...`
// marker line (no embedded spaces in any value, so a plain `\S+` regex extracts each one) into
// the Task `input` string it passes to `invoke_worker`, or sends the literal Chinese chat text a
// scenario matches on directly as the user's chat message.
//
// A scenario is a function `(blob) => step[]`, where `step` is one scripted model turn:
// `{tool: {name, args}}` (a single tool call, `finish_reason: 'tool_calls'`) or `{text}` (final
// assistant text, `finish_reason: 'stop'`). Which step fires is `assistantMessageCount(messages)`
// — the number of `role:'assistant'` messages already in the conversation, i.e. how many of this
// scenario's own prior turns have already round-tripped through pi and back — clamped to the last
// step once the scripted sequence is exhausted, so a scenario never needs to guess a session id or
// keep any state of its own across requests (every fake-llm request already carries the entire
// conversation so far, OpenAI-style).
// -------------------------------------------------------------------------------------------

function assistantMessageCount(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((m) => m && m.role === 'assistant').length;
}

/** Extracts a `KEY=value` marker's value from the JSON-serialized messages blob. Restricted to
 *  `[A-Za-z0-9_.:-]+` (every value accept_s2.sh ever embeds is a container id, a hostname-safe
 *  gate/tool name fragment, or a spaceless shell command like `uptime`) rather than `\S+` — the
 *  blob is JSON text, so the marker's value is immediately followed by a `"` (the closing quote
 *  of the JSON string it lives in) with no intervening whitespace; a `\S+` class would keep
 *  matching straight through that quote and the JSON structure after it, up to the next
 *  incidental whitespace anywhere later in the blob. */
function extractMarker(blob, key) {
  const match = new RegExp(`${key}=([A-Za-z0-9_.:-]+)`).exec(blob);
  return match ? match[1] : undefined;
}

/** S2.12 step 2 ("重启测试容器" → find_* → invoke_worker → 卡片 → 批准 → 执行 → explain): the
 *  *Worker* half — invoked directly by accept_s2.sh via `invoke_worker` (not through chat; see
 *  docs/runbooks/host-accept-s2.md "已知偏离" for why the chat-driven half is marked SKIP). The
 *  Worker calls the docker gate's `container.restart` tool (registered by
 *  packages/platform-extension/src/modes/worker.ts from `list_allowed_operations`; tool name
 *  sanitized from `docker.container_restart`, see that file's `sanitizeToolName`), then reports a
 *  result contract with one `factsToAssert` entry — S2.12 step 7 asserts this Fact lands
 *  `epistemic_status='inferred'`.
 */
function dockerRestartScenario(blob) {
  const containerId = extractMarker(blob, 'CONTAINER_ID') ?? 'unknown';
  return [
    { tool: { name: 'docker_container_restart', args: { id: containerId } } },
    {
      tool: {
        name: 'report_result',
        args: {
          summary: `accept_s2: requested restart of container ${containerId} via the docker gatekeeper.`,
          findings: [`container ${containerId} restart requested`],
          factsToAssert: [
            {
              linkType: 'accept_s2_restarted',
              source: { objectType: 'AcceptS2Container', identity: { containerId } },
              target: {
                objectType: 'AcceptS2Observation',
                identity: { containerId, kind: 'restart' },
                properties: { containerId },
              },
              confidence: 0.9,
            },
          ],
          evidence: [{ kind: 'accept_s2_worker_note', content: { containerId } }],
          artifacts: [],
        },
      },
    },
  ];
}

/** S2.12 step 4 (Worker runs one *unclassified* command on the SSH host → card → "always allow" →
 *  second identical run auto-approved, no card): the ssh gate's `ssh.run_command` tool, sanitized
 *  from `accept_s2_ssh.ssh.run_command` (accept_s2.sh registers the ssh connection with
 *  `target: "accept_s2_ssh"`). Reused verbatim for both the first (pending_approval) and second
 *  (auto_approved) invocation — the Worker's own turn looks the same either way, it just calls
 *  the tool once and reports; the difference in governance outcome is entirely server-side
 *  (governance/policy/engine.ts, driven by the workspace's `set_auto_approved_action_kind` policy
 *  between the two invocations).
 */
function sshRunScenario(blob) {
  const command = extractMarker(blob, 'COMMAND') ?? 'true';
  return [
    { tool: { name: 'accept_s2_ssh_ssh_run_command', args: { command } } },
    {
      tool: {
        name: 'report_result',
        args: {
          summary: `accept_s2: ran "${command}" on the test SSH host via the ssh gatekeeper.`,
          findings: [`command "${command}" submitted`],
          factsToAssert: [],
          evidence: [{ kind: 'accept_s2_worker_note', content: { command } }],
          artifacts: [],
        },
      },
    },
  ];
}

/** S2.12 step 2's *chat-driven* half (kept here, scripted, so the scenario exists and this file
 *  is ready the day packages/platform-extension/src/modes/entry.ts registers `find_*`/
 *  `invoke_worker` as real tools — see docs/runbooks/host-accept-s2.md "已知偏离"): the entry
 *  agent's registered tool set today (entry.ts's `OBSERVE_CAPABILITY_NAMES`) does not include
 *  `find_workers`, so this tool call is expected to come back as a pi tool-error result, not a
 *  real kernel call — step 2 (this scenario's second turn) always falls back to a plain
 *  acknowledgement text so the turn still settles instead of looping.
 */
function entryRestartChatScenario() {
  return [
    { tool: { name: 'find_workers', args: { need: 'restart a container' } } },
    { text: 'echo: 重启测试容器 (find_workers tool call did not resolve — see accept_s2.sh SKIP)' },
  ];
}

/** S2.12 step 3's *chat-driven* half — same "scripted and ready, but not currently reachable"
 *  status as `entryRestartChatScenario` above: `accept_s2_api_stock_get` is a gate-projected tool
 *  name entry mode never registers today. */
function entryObserveChatScenario() {
  return [
    { tool: { name: 'accept_s2_api_stock_get', args: {} } },
    {
      text: 'echo: 测试 API 的 GET 返回什么 (accept_s2_api_stock_get tool call did not resolve — see accept_s2.sh SKIP)',
    },
  ];
}

const SCENARIOS = [
  { marker: 'ACCEPT_S2_SCENARIO=docker_restart', build: dockerRestartScenario },
  { marker: 'ACCEPT_S2_SCENARIO=ssh_run', build: sshRunScenario },
  { marker: '重启测试容器', build: entryRestartChatScenario },
  { marker: '测试 API 的 GET 返回什么', build: entryObserveChatScenario },
];

/** Returns the scripted step for this request, or `undefined` if no scenario marker matched
 *  (the caller falls through to the original search/echo logic unchanged). */
function matchScenarioStep(messages) {
  const blob = JSON.stringify(messages ?? []);
  const scenario = SCENARIOS.find((s) => blob.includes(s.marker));
  if (!scenario) return undefined;
  const steps = scenario.build(blob);
  const index = Math.min(assistantMessageCount(messages), steps.length - 1);
  return steps[index];
}

function sendScenarioStep(res, step, stream) {
  const id = `fake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCallId = `call_${Math.random().toString(36).slice(2, 10)}`;
  const isTool = step.tool !== undefined;
  const argsJson = isTool ? JSON.stringify(step.tool.args ?? {}) : '';
  const text = isTool ? '' : step.text;
  const usage = {
    prompt_tokens: 1,
    completion_tokens: estimateTokens(isTool ? argsJson : text),
    total_tokens: 1 + estimateTokens(isTool ? argsJson : text),
  };

  if (!stream) {
    const message = isTool
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: toolCallId, type: 'function', function: { name: step.tool.name, arguments: argsJson } },
          ],
        }
      : { role: 'assistant', content: text };
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: MODEL_ID,
      choices: [{ index: 0, message, finish_reason: isTool ? 'tool_calls' : 'stop' }],
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

  if (isTool) {
    writeSse(res, {
      ...baseChunk(id, created),
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: toolCallId, type: 'function', function: { name: step.tool.name, arguments: '' } },
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
          delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] },
          finish_reason: null,
        },
      ],
    });
    writeSse(res, {
      ...baseChunk(id, created),
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
  } else {
    for (const piece of chunkText(text, 12)) {
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

  writeSse(res, { ...baseChunk(id, created), choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleChatCompletions(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: { message: `invalid JSON body: ${String(err)}` } });
    return;
  }

  // S2.12: a scripted scenario, if one matches, fully owns this response — everything below is
  // the original, untouched search/echo behavior for every other request.
  const scenarioStep = matchScenarioStep(parsed.messages);
  if (scenarioStep) {
    sendScenarioStep(res, scenarioStep, parsed.stream === true);
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
