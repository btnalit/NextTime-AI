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
// A scenario is a function `(messages) => step[]`, where `step` is one scripted model turn:
// `{tool: {name, args}}` (a single tool call, `finish_reason: 'tool_calls'`) or `{text}` (final
// assistant text, `finish_reason: 'stop'`). Which step fires is `assistantMessageCount(messages)`
// — the number of `role:'assistant'` messages already in the conversation, i.e. how many of this
// scenario's own prior turns have already round-tripped through pi and back — clamped to the last
// step once the scripted sequence is exhausted, so a scenario never needs to guess a session id or
// keep any state of its own across requests (every fake-llm request already carries the entire
// conversation so far, OpenAI-style). A later step's tool-call arguments may depend on an earlier
// step's *real* tool result (`findToolResult`, below) rather than a value guessed ahead of time —
// `entryRestartChatScenario`'s `invoke_worker` call is the concrete example, chaining off whatever
// `find_workers` actually returned.
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

/** A tool-result (`role:'tool'`) message's own text — `content` is a bare string for a plain-text
 *  tool result (the common OpenAI shape) or an array of `{type:'text', text}` parts (some
 *  adapters keep the pi-native content-parts shape even on the outbound wire request); either way
 *  this returns the plain text so it can be `JSON.parse`d. Same content-parts handling as
 *  `lastUserMessageText` above, applied to a different message role. */
function toolMessageText(message) {
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

/** Finds the most recent `assistant` `tool_calls` entry named `toolName` and the JSON-parsed
 *  content of its matching `role:'tool'` result message — used by the entry-mode chat scenarios
 *  below to chain a later tool call's arguments off an earlier tool's *real* result (e.g.
 *  `invoke_worker`'s `definitionId`/`version` off whatever `find_workers` actually returned),
 *  rather than a value accept_s2.sh guessed ahead of time. Returns `undefined` when that tool
 *  hasn't been called yet, or when its result isn't valid JSON — the latter is exactly what
 *  happens today, before packages/platform-extension registers these tools for entry mode: pi
 *  turns a call to an unregistered tool name into a plain-text tool-error result, not JSON (see
 *  entryRestartChatScenario/entryObserveChatScenario's own doc comments and
 *  docs/runbooks/host-accept-s2.md "已知偏离"). */
function findToolResult(messages, toolName) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    const call = message.tool_calls.find((c) => c?.function?.name === toolName);
    if (!call) continue;
    const resultMessage = messages.find((r) => r?.role === 'tool' && r.tool_call_id === call.id);
    if (!resultMessage) return undefined;
    try {
      return JSON.parse(toolMessageText(resultMessage));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** S2.12 step 2 ("重启测试容器" → find_* → invoke_worker → 卡片 → 批准 → 执行 → explain): the
 *  *Worker* half — the container-restart Worker `entryRestartChatScenario` below invokes (or
 *  accept_s2.sh's own direct fallback call — see docs/runbooks/host-accept-s2.md "已知偏离"). The
 *  Worker calls the docker gate's `container.restart` tool (registered by
 *  packages/platform-extension/src/modes/worker.ts from `list_allowed_operations`; tool name
 *  sanitized from `docker.container_restart`, see that file's `sanitizeToolName`), then reports a
 *  result contract with one `factsToAssert` entry — S2.12 step 7 asserts this Fact lands
 *  `epistemic_status='inferred'`.
 */
function dockerRestartScenario(messages) {
  const blob = JSON.stringify(messages);
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
function sshRunScenario(messages) {
  const blob = JSON.stringify(messages);
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

/** S2.12 step 2's *chat-driven* half: a real three-turn chain once
 *  packages/platform-extension/src/modes/entry.ts registers `find_workers`/`invoke_worker` as
 *  entry tools (see docs/runbooks/host-accept-s2.md "已知偏离" — as of this file's own last
 *  update, entry.ts's registered tool set is still only the five S1 observe tools, so this
 *  scenario's first tool call comes back as a pi tool-error result rather than a real kernel
 *  call; the fallback branches below keep the turn settling instead of looping either way).
 *
 *  Turn 1: `find_workers({need: 'restart'})` — accept_s2.sh's `ops_runner_step` gives the
 *  proposed `ops-runner` WorkerDefinition a `description` containing the literal word "restart"
 *  precisely so this need string matches it (`substrate/graph/find-means.ts`'s ILIKE-over-
 *  properties search requires the *whole* `need` string as a contiguous substring, not a
 *  per-word match).
 *
 *  Turn 2: `invoke_worker({definitionId, version, input, wait:false})` — `definitionId`/`version`
 *  come from turn 1's *real* result (`findToolResult`, above), not a value accept_s2.sh guessed
 *  ahead of time; `input` carries the same `ACCEPT_S2_SCENARIO=docker_restart CONTAINER_ID=...`
 *  marker `dockerRestartScenario` (above) expects, extracted from the chat message text
 *  accept_s2.sh sends ("重启测试容器 CONTAINER_ID=<id>" — the marker below still matches on the
 *  substring "重启测试容器" alone). `wait:false`: this is a chat turn, not a synchronous script
 *  call — the entry agent's own turn must end quickly and report back later (§8.2's asynchronous
 *  model), not block for up to 90s waiting for the spawned Worker.
 *
 *  Turn 3: a final text naming the taskId turn 2's *real* result returned.
 */
function entryRestartChatScenario(messages) {
  const blob = JSON.stringify(messages);
  const containerId = extractMarker(blob, 'CONTAINER_ID') ?? 'unknown';
  const foundWorkers = findToolResult(messages, 'find_workers');
  const workerMatch = Array.isArray(foundWorkers)
    ? foundWorkers.find((w) => w && w.kind === 'worker')
    : undefined;
  const invokeResult = findToolResult(messages, 'invoke_worker');

  return [
    { tool: { name: 'find_workers', args: { need: 'restart' } } },
    workerMatch
      ? {
          tool: {
            name: 'invoke_worker',
            args: {
              definitionId: workerMatch.definitionId,
              version: workerMatch.version,
              input: `ACCEPT_S2_SCENARIO=docker_restart CONTAINER_ID=${containerId}`,
              wait: false,
            },
          },
        }
      : { text: 'echo: 重启测试容器 (find_workers did not resolve — see docs/runbooks/host-accept-s2.md)' },
    invokeResult && typeof invokeResult.taskId === 'string'
      ? {
          text: `Started a Worker to restart the container — task ${invokeResult.taskId} is now running, I will follow up once it reports back.`,
        }
      : { text: 'echo: 重启测试容器 (invoke_worker did not resolve — see docs/runbooks/host-accept-s2.md)' },
  ];
}

/** S2.12 step 3's *chat-driven* half — same "real once entry.ts registers the tool" status as
 *  `entryRestartChatScenario` above. `accept_s2_api_stock_get` is the observe-class gate-projected
 *  tool name entry mode is expected to register from `list_allowed_operations` (worker mode's own
 *  `sanitizeToolName` convention — packages/platform-extension/src/modes/worker.ts — applied to
 *  `<gateName>.<opName>`; accept_s2.sh's http connection uses `target: "accept_s2_api"` and the
 *  fixture's one Operation is named `stock.get`, so `accept_s2_api.stock.get` sanitizes to
 *  `accept_s2_api_stock_get`). Turn 2 echoes turn 1's *real* returned data (not a canned string),
 *  so accept_s2.sh's own "reply contains the fixture's stock payload" assertion is a genuine
 *  round trip, not a hardcoded echo.
 */
function entryObserveChatScenario(messages) {
  const observed = findToolResult(messages, 'accept_s2_api_stock_get');
  const data = observed && typeof observed === 'object' ? (observed.data ?? observed) : observed;
  return [
    { tool: { name: 'accept_s2_api_stock_get', args: {} } },
    data !== undefined
      ? { text: `The GET returned: ${JSON.stringify(data)}` }
      : {
          text: 'echo: 测试 API 的 GET 返回什么 (accept_s2_api_stock_get did not resolve — see docs/runbooks/host-accept-s2.md)',
        },
  ];
}

// Order matters: the entry-chat scenarios must be tested first. Once the entry agent has called
// `invoke_worker`, its own message history contains the Worker marker (inside the tool-call
// arguments' `input`), so a Worker-marker-first table would hand the *entry* agent the Worker's
// `report_result` step (observed on the host: "Tool report_result not found"). A Worker's history
// never contains the Chinese chat text, so the chat markers cannot misfire the other way.
const SCENARIOS = [
  { marker: '重启测试容器', build: entryRestartChatScenario, chat: true },
  { marker: '测试 API 的 GET 返回什么', build: entryObserveChatScenario, chat: true },
  { marker: 'ACCEPT_S2_SCENARIO=docker_restart', build: dockerRestartScenario, chat: false },
  { marker: 'ACCEPT_S2_SCENARIO=ssh_run', build: sshRunScenario, chat: false },
];

/**
 * Picks the scenario for this request. An entry agent's pi session is resident — its history keeps
 * every earlier chat turn (ninth host run: a fresh kernel chat still replayed the restart scenario
 * because "重启测试容器" was still in the session) — so among the chat scenarios the one whose marker
 * occurs *latest* in the serialized history wins (the newest question). Worker scenarios are only
 * consulted when no chat marker is present at all: a Worker's history never contains the chat
 * text, while an entry agent's history contains the Worker marker as soon as it has called
 * invoke_worker (inside the tool-call arguments), which must not flip it onto the Worker script.
 */
function pickScenario(blob) {
  let best;
  let bestAt = -1;
  for (const s of SCENARIOS) {
    if (!s.chat) continue;
    const at = blob.lastIndexOf(s.marker);
    if (at > bestAt) {
      best = s;
      bestAt = at;
    }
  }
  if (best) return best;
  return SCENARIOS.find((s) => !s.chat && blob.includes(s.marker));
}

/** Returns the scripted step for this request, or `undefined` if no scenario marker matched
 *  (the caller falls through to the original search/echo logic unchanged). */
function matchScenarioStep(messages) {
  const list = messages ?? [];
  const blob = JSON.stringify(list);
  const scenario = pickScenario(blob);
  if (!scenario) return undefined;
  const steps = scenario.build(list);
  // Which step: for a chat scenario, count assistant messages *since the newest message carrying
  // its marker* (the user's question) — the entry agent's pi session is resident, so the history
  // already holds every earlier turn's assistant messages (tenth host run: the observe scenario
  // jumped straight to its final text). A Worker session is one-shot, so its count stays global —
  // its own marker also rides in the re-injected task context, which would otherwise reset the
  // count on every request.
  let counted = list;
  if (scenario.chat) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (JSON.stringify(list[i]).includes(scenario.marker)) {
        counted = list.slice(i + 1);
        break;
      }
    }
  }
  const index = Math.min(assistantMessageCount(counted), steps.length - 1);
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
