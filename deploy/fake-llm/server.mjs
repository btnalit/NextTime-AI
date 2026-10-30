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
//   GET  /accept-s2/holds    -> {holds:[name...], counts:{name:{held, dropped}}}: the scripted
//                                turns held right now, and per name how many requests it held and
//                                how many of those lost their client while held (S11 GO7a-3, see
//                                "Held turns" below).
//   POST /accept-s2/holds/<name>/release -> {released:<n>}: lets the turns held under <name> answer.
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
//
// S5.4 tool-schema validation (docs/development-tasks.md S5.4; docs/retrospective-2026-09-11.md
// §3.1): before any of the above, every request's `tools[].function.parameters` is checked for
// `type: "object"` — the one shape every OpenAI-compatible provider requires — and the whole
// request is rejected with a 400 `invalid_function_parameters` if any entry fails, matching a real
// provider's own behavior (this is what let §3.1's regression pass this double for weeks; see
// `findInvalidToolSchema` below).

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

// -------------------------------------------------------------------------------------------
// S5.4 (docs/development-tasks.md S5.4; docs/retrospective-2026-09-11.md §3.1 "教训"): a real
// OpenAI-compatible upstream rejects the *entire* chat-completions request when any function
// tool's `parameters` is not a `type: "object"` JSON Schema — the exact failure mode §3.1
// documents (a Gatekeeper Operation imported with a `null` `params_schema` took the whole entry
// agent down with a 400 on the real provider, for weeks, because this double never validated
// anything and S2 kept passing). Mirrors that rejection here so the same class of regression fails
// fast against this double too, instead of only being caught by a real-model run.
// -------------------------------------------------------------------------------------------

/** `true` when `schema` is a well-formed function-parameters JSON Schema object — the one shape
 *  every OpenAI-compatible provider requires (`type: "object"`, `undefined`/`null`/any other
 *  top-level `type` is rejected). Deliberately narrow: this double is not a general JSON Schema
 *  validator, only a gate for the one property class §3.1's regression turned on. */
function isObjectToolParameters(schema) {
  return (
    schema !== null &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    schema.type === 'object'
  );
}

/** Scans a request's `tools` array (OpenAI's `{type:'function', function:{name, parameters}}[]`
 *  shape) for the first entry whose `function.parameters` is not an object schema. Returns
 *  `undefined` when `tools` is absent/empty or every entry is well-formed — the common case, and
 *  every case before this task, so every existing behavior stays byte-for-byte unchanged. */
function findInvalidToolSchema(tools) {
  if (!Array.isArray(tools)) return undefined;
  for (let index = 0; index < tools.length; index += 1) {
    const fn = tools[index]?.function;
    if (!fn || typeof fn !== 'object') continue;
    if (!isObjectToolParameters(fn.parameters)) {
      return { index, name: typeof fn.name === 'string' ? fn.name : 'unknown' };
    }
  }
  return undefined;
}

/** Same error shape a real OpenAI-compatible upstream returns for this failure
 *  (`invalid_request_error` / `invalid_function_parameters`) — llm-proxy and pi both read
 *  `error.message`, so this double reproducing the real `type`/`code`/`param` fields costs
 *  nothing and lets a caller that already branches on them (a real provider integration) be
 *  tested against this double too. */
function sendInvalidToolSchemaError(res, invalid) {
  sendJson(res, 400, {
    error: {
      message: `Invalid schema for function '${invalid.name}': the 'parameters' field must be a JSON Schema of 'type: "object"'.`,
      type: 'invalid_request_error',
      param: `tools[${invalid.index}].function.parameters`,
      code: 'invalid_function_parameters',
    },
  });
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
  const text = findToolResultText(messages, toolName);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The plain text of the most recent `toolName` call's result, JSON or not — for a step that has
 *  to tell what came back even when it is pi's plain-text "tool not found" error (S11 GO5e-1's
 *  `confirm_goal` attempt, `entryGoalChatScenario`). `undefined` when that tool has not been
 *  called, or its result is not in the history yet. */
function findToolResultText(messages, toolName) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    const call = message.tool_calls.find((c) => c?.function?.name === toolName);
    if (!call) continue;
    const resultMessage = messages.find((r) => r?.role === 'tool' && r.tool_call_id === call.id);
    return resultMessage ? toolMessageText(resultMessage) : undefined;
  }
  return undefined;
}

/** Every `toolName` call so far, oldest first, with the plain text of its result (`undefined`
 *  while it has none) — for a scenario that makes the same call several times and reports each
 *  answer (`goalThreeWritesScenario`). */
function allToolResults(messages, toolName) {
  if (!Array.isArray(messages)) return [];
  const found = [];
  for (const message of messages) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (call?.function?.name !== toolName) continue;
      let args;
      try {
        args = JSON.parse(call.function.arguments ?? '{}');
      } catch {
        args = {};
      }
      const resultMessage = messages.find((r) => r?.role === 'tool' && r.tool_call_id === call.id);
      found.push({ args, text: resultMessage ? toolMessageText(resultMessage) : undefined });
    }
  }
  return found;
}

/** The serialized newest message carrying `marker` — where a chat scenario reads the markers of
 *  the question it answers. The entry agent's pi session is resident, so the history may hold an
 *  earlier asking of the same question with other marker values (`extractMarker` over the whole
 *  blob would read the oldest). Falls back to the whole history. */
function latestMessageWith(messages, marker) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const serialized = JSON.stringify(list[i]);
    if (serialized.includes(marker)) return serialized;
  }
  return JSON.stringify(list);
}

/** S2.12 step 2 ("重启测试容器" → find_* → invoke_worker → 卡片 → 批准 → 执行 → explain): the
 *  *Worker* half — the container-restart Worker `entryRestartChatScenario` below invokes (or
 *  accept_s2.sh's own direct fallback call — see docs/runbooks/host-accept-s2.md "已知偏离"). The
 *  Worker calls the docker gate's `container.restart` tool (registered by
 *  packages/platform-extension/src/modes/worker.ts from `list_allowed_operations`; tool name
 *  sanitized from `<gateName>.container_restart`, see modes/gate-tools.ts's `sanitizeToolName`),
 *  then reports a result contract with one `factsToAssert` entry — S2.12 step 7 asserts this
 *  Fact lands `epistemic_status='inferred'`.
 *
 *  The gate's name is whatever the workspace's Gatekeeper object is called — `docker` when it was
 *  connected with `target: "docker"`, the catalog instance's display name (`gatekeeper-docker` by
 *  default) once accept_s2.sh enables the packaged gate through `enable_gate_instance` (STATUS
 *  leftover 36: a workspace can no longer `create_connection` to a platform-catalog address). So
 *  the restart tool is picked from the request's own `tools` list, the way a real model picks it
 *  from the tool definitions it is shown; the literal `docker_container_restart` is only the
 *  fallback for a request that carries no tools (the selftest's direct POSTs).
 */
function restartToolName(tools) {
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === 'string' && name.endsWith('_container_restart')) return name;
  }
  return 'docker_container_restart';
}

function dockerRestartScenario(messages, tools) {
  const blob = JSON.stringify(messages);
  const containerId = extractMarker(blob, 'CONTAINER_ID') ?? 'unknown';
  return [
    { tool: { name: restartToolName(tools), args: { id: containerId } } },
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
 *  Turn 3: a final text naming the id (was taskId — docs/wire-contract-conventions.md §2,
 *  invoke_worker's result is now the created Task resource keyed `id`) turn 2's *real* result
 *  returned.
 */
function entryRestartChatScenario(messages) {
  const blob = JSON.stringify(messages);
  const containerId = extractMarker(blob, 'CONTAINER_ID') ?? 'unknown';
  const foundWorkers = findToolResult(messages, 'find_workers');
  // find_workers is a list_*/find_* capability — its result is now {items, nextCursor?}
  // (docs/wire-contract-conventions.md §3), not a bare array.
  const workerMatch = Array.isArray(foundWorkers?.items)
    ? foundWorkers.items.find((w) => w && w.kind === 'worker')
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
    invokeResult && typeof invokeResult.id === 'string'
      ? {
          text: `Started a Worker to restart the container — task ${invokeResult.id} is now running, I will follow up once it reports back.`,
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

/** S3.9 step (c) (docs/development-tasks.md §S3.9; scripts/accept_s3.sh): "哪个服务依赖哪个" — a
 *  real three-tool chain, entirely over already-registered entry observe tools (`search`/
 *  `traverse`/`get_object` — packages/platform-extension/src/modes/entry.ts's
 *  `ENTRY_TOOL_CAPABILITY_NAMES`, all S1, none of the "not yet registered for entry mode" caveats
 *  the older Worker-dispatch scenarios above carry), so every step below chains off a *real*
 *  kernel result (`findToolResult`), never a value accept_s3.sh guessed ahead of time:
 *
 *  Turn 1: `search({objectType:'Container'})` — every Container the host-inventory collector
 *  (S3.3) has written for this workspace.
 *
 *  Turn 2: `traverse({fromId, linkType:'depends_on', depth:1})` on whichever turn-1 result has
 *  `identityKey.serviceName === 'kernel'` — this repo's own docker-compose.yml declares `kernel:
 *  depends_on: {postgres: ...}` (a real, always-true relationship on any running stack, not a
 *  fixture), and Docker Compose stamps that as the `com.docker.compose.depends_on` label the
 *  collector reads (collectors/host-inventory/src/observation-builder.ts) — so this is a genuine
 *  round trip against real observed data, not a canned answer.
 *
 *  Turn 3: `get_object({objectId: <turn 2's first edge's targetObjectId>})` — resolves the
 *  dependency target's own `identityKey.serviceName` (a Container's `depends_on` edge only carries
 *  an opaque object id; naming the dependency by service name needs this extra hop).
 *
 *  Turn 4: final text naming the dependency (`"kernel 依赖（depends_on）服务 <name>。"` when every
 *  hop resolved) — scripts/accept_s3.sh's own chat step asserts this reply is non-empty and names
 *  a dependency; it independently rediscovers a `depends_on` Fact via its own direct `traverse` +
 *  `explain` calls (not by parsing this reply) to verify `explain` resolves back to the
 *  collector's own Source — see that script's own comment for why.
 */
function entryDependencyChatScenario(messages) {
  const searched = findToolResult(messages, 'search');
  const items = Array.isArray(searched?.items) ? searched.items : [];
  const kernelContainer = items.find(
    (item) => item && item.identityKey && item.identityKey.serviceName === 'kernel',
  );
  const traversed = findToolResult(messages, 'traverse');
  const edge =
    traversed && Array.isArray(traversed.edges) && traversed.edges.length > 0
      ? traversed.edges[0]
      : undefined;
  const dependency = findToolResult(messages, 'get_object');
  const dependencyName =
    dependency && dependency.identityKey && typeof dependency.identityKey.serviceName === 'string'
      ? dependency.identityKey.serviceName
      : undefined;

  return [
    { tool: { name: 'search', args: { query: '', objectType: 'Container' } } },
    kernelContainer
      ? {
          tool: {
            name: 'traverse',
            args: { fromId: kernelContainer.id, linkType: 'depends_on', depth: 1 },
          },
        }
      : {
          text: 'echo: 哪个服务依赖哪个 (search did not resolve a kernel Container — see docs/runbooks/host-accept-s3.md)',
        },
    edge
      ? { tool: { name: 'get_object', args: { objectId: edge.targetObjectId } } }
      : {
          text: 'echo: 哪个服务依赖哪个 (traverse returned no depends_on edge — see docs/runbooks/host-accept-s3.md)',
        },
    dependencyName
      ? { text: `kernel 依赖（depends_on）服务 ${dependencyName}。` }
      : {
          text: 'echo: 哪个服务依赖哪个 (get_object did not resolve — see docs/runbooks/host-accept-s3.md)',
        },
  ];
}

/** S11 GO5e-1 (scripts/accept_s2.sh `step9_goal_from_chat`): "发起验收目标 GOAL_NONCE=<n>" — the
 *  entry agent proposes a goal in the conversation and cannot confirm it itself. Every argument
 *  chains off a *real* tool result (`findToolResult`), never a value accept_s2.sh guessed:
 *
 *  Turn 1: `find_workers({need:'restart'})` — the ops-runner WorkerDefinition accept_s2.sh's
 *  `ops_runner_step` publishes (same need as `entryRestartChatScenario`).
 *
 *  Turn 2: `find_operations({need:'stock'})` — the http gate's published observe Operation
 *  `stock.get`; its Object's identity names the Gatekeeper (`identityKey.gatekeeperId`).
 *
 *  Turn 3: `propose_goal` — one step on that Worker (`goalStepScenario` below scripts it; one step
 *  keeps the run short — when a goal is the right call is the entry prompt's business, guarded by
 *  scripts/guards/prompt-contract.mjs, not this script's), the goal
 *  accepted by a check the platform makes (an `observe_predicate` on `stock.get` returning the
 *  fixture's symbol, never the Worker's word), a budget, and an `idempotencyKey` named after the
 *  nonce: asking again in the same chat proposes nothing new (`changed: false`, the same run).
 *  Neither the statement nor the step's input carries this scenario's marker — a step's Worker
 *  sees its input, and a chat marker there would hand the Worker this script (see `SCENARIOS`).
 *
 *  Turn 4: `confirm_goal({goalRunId, revision: 1})` — the agent trying to confirm its own
 *  proposal. Confirmation is the person's: the tool is not registered in entry mode (pi answers
 *  with a plain-text "not found" error) and the kernel refuses the capability on any Handle
 *  (human channel only). accept_s2.sh asserts the run is still `proposed` after the Turn.
 *
 *  Turn 5: a final text with `GOAL_ID=`, `GOAL_STATUS=`, `GOAL_CHANGED=` from turn 3's real result
 *  and `CONFIRM_GOAL=` — `confirmed` only if turn 4 came back as a confirmation, `unavailable`
 *  otherwise — for accept_s2.sh to read.
 */
function entryGoalChatScenario(messages) {
  const asked = latestMessageWith(messages, '发起验收目标');
  const nonce = extractMarker(asked, 'GOAL_NONCE') ?? 'none';
  const foundWorkers = findToolResult(messages, 'find_workers');
  const workerMatch = Array.isArray(foundWorkers?.items)
    ? foundWorkers.items.find((w) => w && w.kind === 'worker')
    : undefined;
  const foundOperations = findToolResult(messages, 'find_operations');
  const stockGet = Array.isArray(foundOperations?.items)
    ? foundOperations.items.find(
        (o) =>
          o?.identityKey?.name === 'stock.get' && typeof o.identityKey.gatekeeperId === 'string',
      )
    : undefined;
  const proposed = findToolResult(messages, 'propose_goal');
  const goalRunId =
    proposed && typeof proposed.goalRunId === 'string' ? proposed.goalRunId : undefined;
  const confirmText = findToolResultText(messages, 'confirm_goal');
  let confirmed = false;
  try {
    const parsed = JSON.parse(confirmText ?? '');
    confirmed = parsed !== null && typeof parsed === 'object' && parsed.goalRunId === goalRunId;
  } catch {
    confirmed = false;
  }

  return [
    { tool: { name: 'find_workers', args: { need: 'restart' } } },
    workerMatch
      ? { tool: { name: 'find_operations', args: { need: 'stock' } } }
      : { text: 'echo: 发起验收目标 (find_workers did not resolve — see docs/runbooks/host-accept-s2.md)' },
    workerMatch && stockGet
      ? {
          tool: {
            name: 'propose_goal',
            args: {
              statement: `accept_s2 goal journey ${nonce}: one ops-runner step reports back, and the platform reads the test stock API to accept the goal.`,
              plan: {
                steps: [
                  {
                    key: 'report',
                    worker: { definitionId: workerMatch.definitionId, version: workerMatch.version },
                    input: `ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=${nonce}`,
                  },
                ],
                acceptance: [
                  {
                    kind: 'observe_predicate',
                    key: 'stock-visible',
                    check: {
                      gatekeeperId: stockGet.identityKey.gatekeeperId,
                      operation: 'stock.get',
                      params: {},
                      expect: { path: 'symbol', op: 'eq', value: 'NXT' },
                    },
                  },
                ],
              },
              budget: { maxTokens: 200000, maxSteps: 3, maxRevisions: 1, maxWallClockSeconds: 1800 },
              idempotencyKey: `accept-s2-goal-${nonce}`,
            },
          },
        }
      : { text: 'echo: 发起验收目标 (find_operations did not resolve stock.get — see docs/runbooks/host-accept-s2.md)' },
    goalRunId
      ? { tool: { name: 'confirm_goal', args: { goalRunId, revision: 1 } } }
      : { text: 'echo: 发起验收目标 (propose_goal did not resolve — see docs/runbooks/host-accept-s2.md)' },
    {
      text: `Proposed goal GOAL_ID=${goalRunId} GOAL_STATUS=${proposed?.status} GOAL_CHANGED=${proposed?.changed} CONFIRM_GOAL=${confirmed ? 'confirmed' : 'unavailable'} — please confirm it in the console under Goals; nothing runs until you do.`,
    },
  ];
}

/** S11 GO5e-1: the *Worker* half of `entryGoalChatScenario` — the goal's one step. Reports back
 *  with no Fact: the goal is accepted on the platform's own observation of the stock API, which a
 *  Worker's report could not stand in for. S11 GO7a-3 (S2, S12): with `HOLD=<name>` in its input
 *  the report is held until accept_s2.sh releases it ("Held turns" below) — the Worker stays alive
 *  and mid model call, its Task running, for as long as the script needs. */
function goalStepScenario(messages) {
  const blob = JSON.stringify(messages);
  const nonce = extractMarker(blob, 'GOAL_NONCE') ?? 'none';
  // S11 GO7a-3: `HOLD=<name>` keeps the report back until accept_s2.sh releases it ("Held turns").
  const hold = extractMarker(blob, 'HOLD');
  return [
    {
      ...(hold ? { hold } : {}),
      tool: {
        name: 'report_result',
        args: {
          summary: `accept_s2: goal step ${nonce} done; the platform checks the stock API itself.`,
          findings: [`goal step ${nonce} reported`],
          factsToAssert: [],
          evidence: [{ kind: 'accept_s2_worker_note', content: { nonce } }],
          artifacts: [],
        },
      },
    },
  ];
}

/** S11 GO7a (scripts/lib/accept-s2-goals.sh `goal_s1_dag`, plan §7.2 S1): "发起三步验收目标
 *  GOAL_NONCE=<n>" — the entry agent proposes a goal of three report-only steps on the ops-runner
 *  Worker (`goalStepScenario` scripts each): `a` and `b` run side by side, `c` after both
 *  (`dependsOn`); the goal accepted by the platform reading `stock.get`, as in
 *  `entryGoalChatScenario`. alice confirms it outside the chat and nobody writes in the chat again:
 *  the run must reach its end on its own, its milestones landing in this chat as status lines.
 *  Every id chains off a real tool result, as in `entryGoalChatScenario`; nothing here tries to
 *  confirm (that scenario covers it). No marker of this scenario in the statement or a step's input
 *  (see `entryGoalChatScenario`).
 *
 *  Turn 1 `find_workers({need:'restart'})`, turn 2 `find_operations({need:'stock'})`, turn 3
 *  `propose_goal`, turn 4 a final text with `GOAL_ID=` and `GOAL_STATUS=` from turn 3's result. */
function entryGoalDagChatScenario(messages) {
  const asked = latestMessageWith(messages, '发起三步验收目标');
  const nonce = extractMarker(asked, 'GOAL_NONCE') ?? 'none';
  const foundWorkers = findToolResult(messages, 'find_workers');
  const workerMatch = Array.isArray(foundWorkers?.items)
    ? foundWorkers.items.find((w) => w && w.kind === 'worker')
    : undefined;
  const foundOperations = findToolResult(messages, 'find_operations');
  const stockGet = Array.isArray(foundOperations?.items)
    ? foundOperations.items.find(
        (o) =>
          o?.identityKey?.name === 'stock.get' && typeof o.identityKey.gatekeeperId === 'string',
      )
    : undefined;
  const proposed = findToolResult(messages, 'propose_goal');
  // Called only once `workerMatch` resolved (the propose_goal turn below).
  const step = (key, dependsOn) => ({
    key,
    worker: { definitionId: workerMatch.definitionId, version: workerMatch.version },
    input: `ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=${nonce} STEP=${key}`,
    ...(dependsOn ? { dependsOn } : {}),
  });

  return [
    { tool: { name: 'find_workers', args: { need: 'restart' } } },
    workerMatch
      ? { tool: { name: 'find_operations', args: { need: 'stock' } } }
      : { text: 'echo: 发起三步验收目标 (find_workers did not resolve — see docs/runbooks/host-accept-s2.md)' },
    workerMatch && stockGet
      ? {
          tool: {
            name: 'propose_goal',
            args: {
              statement: `accept_s2 three-step goal ${nonce}: two ops-runner steps report side by side, a third after both, and the platform reads the test stock API to accept the goal.`,
              plan: {
                steps: [step('a'), step('b'), step('c', ['a', 'b'])],
                acceptance: [
                  {
                    kind: 'observe_predicate',
                    key: 'stock-visible',
                    check: {
                      gatekeeperId: stockGet.identityKey.gatekeeperId,
                      operation: 'stock.get',
                      params: {},
                      expect: { path: 'symbol', op: 'eq', value: 'NXT' },
                    },
                  },
                ],
              },
              budget: { maxTokens: 200000, maxSteps: 6, maxRevisions: 1, maxWallClockSeconds: 1800 },
              idempotencyKey: `accept-s2-goal-dag-${nonce}`,
            },
          },
        }
      : { text: 'echo: 发起三步验收目标 (find_operations did not resolve stock.get — see docs/runbooks/host-accept-s2.md)' },
    {
      text: `Proposed goal GOAL_ID=${proposed?.goalRunId} GOAL_STATUS=${proposed?.status} — please confirm it in the console under Goals; nothing runs until you do.`,
    },
  ];
}

/** S11 GO7a (scripts/lib/accept-s2-goals.sh, plan §7.2 S5 and S11): a goal step whose Worker makes
 *  one governed write — `ledger.add` on the http gate (tool `accept_s2_api_ledger_add`: the
 *  connection's target `accept_s2_api` and the Operation's name), under the key the step's input
 *  names (`LEDGER_KEY=<k>`) — then reports. The Operation is `await_decision: true`, so the call
 *  waits for a decision up to the kernel's own await budget and comes back `pending_approval` when
 *  nobody decided by then (S5), or with the decision made in time (S11's rejection). The report
 *  repeats what came back and claims nothing about the write: the step's acceptance check reads the
 *  ledger itself. Another attempt of the step makes the same call again, and the kernel answers it
 *  with the step's earlier request (step-scoped de-duplication), never a second write. */
function goalLedgerStepScenario(messages) {
  const blob = JSON.stringify(messages);
  const key = extractMarker(blob, 'LEDGER_KEY') ?? 'none';
  const answer = findToolResultText(messages, 'accept_s2_api_ledger_add') ?? '';
  return [
    { tool: { name: 'accept_s2_api_ledger_add', args: { key } } },
    {
      tool: {
        name: 'report_result',
        args: {
          summary: `accept_s2: asked the test ledger for one entry under ${key}; the platform answered: ${answer.slice(0, 300)}`,
          findings: [`ledger.add requested under ${key}`],
          factsToAssert: [],
          evidence: [{ kind: 'accept_s2_worker_note', content: { key } }],
          artifacts: [],
        },
      },
    },
  ];
}

/** S11 GO7a-3 (scripts/lib/accept-s2-goals.sh S8, plan §7.2 S8): a goal step whose Worker makes
 *  three governed writes to the test ledger — `<k>-1`, `<k>-2`, then `<k>-3` (`LEDGER_KEY=<k>`) —
 *  and reports what each came back with. Like `goalLedgerStepScenario`'s, each write waits for a
 *  decision up to the kernel's await budget and comes back `pending_approval` when nobody decided.
 *  The turn that asks for the third write is held (`HOLD=<name>`, "Held turns" below) until
 *  accept_s2.sh releases it: in between the script pauses the goal and revises this step away,
 *  so the third write meets a step that takes no new work (I-G9) when the revision let it finish,
 *  and is never asked at all when it terminated the Worker. */
function goalThreeWritesScenario(messages) {
  const blob = JSON.stringify(messages);
  const key = extractMarker(blob, 'LEDGER_KEY') ?? 'none';
  const hold = extractMarker(blob, 'HOLD');
  const write = (n) => ({ tool: { name: 'accept_s2_api_ledger_add', args: { key: `${key}-${n}` } } });
  const answers = allToolResults(messages, 'accept_s2_api_ledger_add').map(
    (call) => `${call.args?.key}: ${(call.text ?? 'no answer').slice(0, 200)}`,
  );
  return [
    write(1),
    write(2),
    { ...(hold ? { hold } : {}), ...write(3) },
    {
      tool: {
        name: 'report_result',
        args: {
          summary: `accept_s2: asked the test ledger for three entries under ${key}; the platform answered each (findings).`,
          findings: answers.length > 0 ? answers : [`no ledger.add answered under ${key}`],
          factsToAssert: [],
          evidence: [{ kind: 'accept_s2_worker_note', content: { key } }],
          artifacts: [],
        },
      },
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
  { marker: '哪个服务依赖哪个', build: entryDependencyChatScenario, chat: true },
  { marker: '发起验收目标', build: entryGoalChatScenario, chat: true },
  { marker: '发起三步验收目标', build: entryGoalDagChatScenario, chat: true },
  { marker: 'ACCEPT_S2_SCENARIO=docker_restart', build: dockerRestartScenario, chat: false },
  { marker: 'ACCEPT_S2_SCENARIO=ssh_run', build: sshRunScenario, chat: false },
  { marker: 'ACCEPT_S2_SCENARIO=goal_step', build: goalStepScenario, chat: false },
  { marker: 'ACCEPT_S2_SCENARIO=goal_ledger', build: goalLedgerStepScenario, chat: false },
  { marker: 'ACCEPT_S2_SCENARIO=goal_three_writes', build: goalThreeWritesScenario, chat: false },
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
function matchScenarioStep(messages, tools) {
  const list = messages ?? [];
  const blob = JSON.stringify(list);
  const scenario = pickScenario(blob);
  if (!scenario) return undefined;
  // `tools`: the request's tool definitions, for scenarios whose tool name depends on how the
  // gate was connected (`dockerRestartScenario`); the other builders ignore the second argument.
  const steps = scenario.build(list, tools);
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
  const answered = assistantMessageCount(counted);
  const step = steps[Math.min(answered, steps.length - 1)];
  // A turn asked again past the end of the script (the clamp) is never held a second time.
  if (answered >= steps.length && step.hold !== undefined) {
    const { hold: _again, ...rest } = step;
    return rest;
  }
  return step;
}

// -------------------------------------------------------------------------------------------
// Held turns (S11 GO7a-3; scripts/lib/accept-s2-goals.sh S2, S8, S12). A scripted step carrying
// `hold: '<name>'` (its input's `HOLD=<name>` marker) is not answered until accept_s2.sh releases
// that name — `POST /accept-s2/holds/<name>/release` — so the script knows the Worker is alive
// and mid model call (`GET /accept-s2/holds`), and chooses when its next move happens: a service
// restart, a row lock, a revision, each before the Worker reports or writes again. Bounded either
// way: a turn is held at most HOLD_MAX_MS, so a script that died never leaves a Worker waiting on
// this double for longer; a name held once — released or timed out — is never held again (a
// retried attempt answers at once); a request whose client went away while held (a terminated
// Worker) is dropped from the list and never answered. Each name also keeps counts — how many
// requests it held and how many of those were dropped that way — so the script can tell a turn
// held throughout from one whose model call was cut and asked again (S2's kernel kill). In memory
// only: a restarted fake-llm forgets every hold, and the held requests' connections go with it.
// -------------------------------------------------------------------------------------------

const HOLD_MAX_MS = 120_000;
/** name -> the release functions of the requests held under it. */
const HELD = new Map();
/** Names released or timed out: never held again. */
const RELEASED = new Set();
/** name -> {held, dropped}: requests held under it, and those whose client went away while held. */
const HOLD_COUNTS = new Map();

/** Resolves once `name` is released, HOLD_MAX_MS has passed, or `res`'s client went away. */
function holdTurn(name, res) {
  if (RELEASED.has(name)) return Promise.resolve();
  return new Promise((resolve) => {
    const waiting = HELD.get(name) ?? new Set();
    HELD.set(name, waiting);
    const counts = HOLD_COUNTS.get(name) ?? { held: 0, dropped: 0 };
    HOLD_COUNTS.set(name, counts);
    counts.held += 1;
    const release = () => {
      clearTimeout(timer);
      res.off('close', dropped);
      waiting.delete(release);
      if (waiting.size === 0 && HELD.get(name) === waiting) HELD.delete(name);
      resolve();
    };
    const dropped = () => {
      counts.dropped += 1;
      release();
    };
    const timer = setTimeout(() => releaseHold(name), HOLD_MAX_MS);
    res.on('close', dropped);
    waiting.add(release);
  });
}

/** Releases every request held under `name`; returns how many there were. */
function releaseHold(name) {
  RELEASED.add(name);
  const waiting = HELD.get(name);
  if (!waiting) return 0;
  const releases = [...waiting];
  for (const release of releases) release();
  return releases.length;
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

  // S5.4: reject the whole request, like a real OpenAI-compatible upstream does, when any tool's
  // schema is malformed — before scenario matching, so no scripted scenario can mask this.
  const invalidTool = findInvalidToolSchema(parsed.tools);
  if (invalidTool) {
    sendInvalidToolSchemaError(res, invalidTool);
    return;
  }

  // S2.12: a scripted scenario, if one matches, fully owns this response — everything below is
  // the original, untouched search/echo behavior for every other request.
  const scenarioStep = matchScenarioStep(parsed.messages, parsed.tools);
  if (scenarioStep) {
    if (scenarioStep.hold !== undefined) {
      await holdTurn(scenarioStep.hold, res);
      // Its client went away while it was held (a terminated Worker): nobody to answer.
      if (res.destroyed) return;
    }
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
  if (req.method === 'GET' && url.pathname === '/accept-s2/holds') {
    sendJson(res, 200, { holds: [...HELD.keys()].sort(), counts: Object.fromEntries(HOLD_COUNTS) });
    return;
  }
  const releasing = /^\/accept-s2\/holds\/([A-Za-z0-9_.:-]+)\/release$/.exec(url.pathname);
  if (req.method === 'POST' && releasing) {
    sendJson(res, 200, { released: releaseHold(releasing[1]) });
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
