#!/usr/bin/env node
// Local self-test for deploy/fake-llm/server.mjs's S2.12 scenario logic (docs/development-tasks.md
// S2.12; "a small node self-test of the fake-llm scenario logic if practical" — task brief).
// Starts the real server as a child process, drives it with a handful of representative
// /v1/chat/completions requests, and asserts:
//   1. The pre-existing `search`-trigger and plain-echo behaviors are byte-for-byte unchanged.
//   2. Each S2.12 scenario picks the right tool/args on its first turn and advances to its second
//      scripted turn once one prior assistant message is in history.
//   3. A request matching no scenario and no "search" word still falls through to plain echo.
//   4. Every scripted tool call whose name is a registry capability (search/traverse/get_object/
//      find_workers/invoke_worker) has its args validated against that capability's params JSON
//      Schema in docs/contracts/capabilities.json — a contract drift (e.g. a new required field)
//      fails here instead of surfacing on the host. Non-registry names (gate operations, worker
//      report_result) are skipped, not failed. S11 GO5e-1: the same args are also parsed with the
//      capability's own Zod params schema from packages/shared/dist (the JSON Schema subset above
//      does not reach nested fields, which propose_goal's plan is made of) — build
//      @nexttime/shared first, as for the prompt-contract guard; CI's quality job builds it before
//      this step.
//   5. S5.4 (docs/retrospective-2026-09-11.md §3.1): a request whose `tools[].function.parameters`
//      is not a `type: "object"` schema is rejected with 400 `invalid_function_parameters`, like a
//      real OpenAI-compatible upstream — and a well-formed `tools` array never false-positives.
//
// Not part of `pnpm test` — this directory is not a pnpm workspace package (same reason
// deploy/fake-llm/server.mjs itself is plain ESM, see its own header comment). Run directly:
//   node deploy/accept-s2/fake-llm-scenario-selftest.mjs
// Exits 0 and prints "fake-llm scenario self-test: OK" on success; prints failures and exits 1
// otherwise.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(HERE, '..', 'fake-llm', 'server.mjs');
const PORT = 8790;

// name -> params JSON Schema (draft-07), loaded once from the capability registry itself.
const REGISTRY = new Map(
  JSON.parse(readFileSync(new URL('../../docs/contracts/capabilities.json', import.meta.url))).map((c) => [
    c.name,
    c.params,
  ]),
);

let failures = 0;

// The registry's own module (`getCapability(name).paramsSchema`), loaded in main().
let shared;
async function loadShared() {
  const distIndex = join(HERE, '..', '..', 'packages', 'shared', 'dist', 'index.js');
  try {
    return await import(pathToFileURL(distIndex).href);
  } catch (err) {
    console.error(
      `fake-llm scenario self-test: could not import ${distIndex} — build @nexttime/shared first (\`pnpm --filter @nexttime/shared build\`).`,
    );
    throw err;
  }
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label} ${detail ?? ''}`);
  }
}

// Minimal draft-07 subset validator: required, additionalProperties:false, per-property type/enum.
// anyOf/oneOf/$ref are not evaluated (treated as pass) — none of the capabilities this self-test
// drives use them for their top-level params.
function validateParams(schema, args) {
  const problems = [];
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!(key in args)) problems.push(`missing required "${key}"`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) problems.push(`unknown property "${key}"`);
    }
  }
  const typeMatches = (type, value) => {
    if (type === 'string') return typeof value === 'string';
    if (type === 'number') return typeof value === 'number';
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
    if (type === 'null') return value === null;
    return true; // unrecognized type keyword - don't fail on it
  };
  for (const [key, value] of Object.entries(args)) {
    const propSchema = props[key];
    if (!propSchema || !(key in args)) continue;
    if (propSchema.type) {
      const types = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];
      if (!types.some((t) => typeMatches(t, value))) {
        problems.push(`"${key}" expected type ${types.join('|')}, got ${JSON.stringify(value)}`);
      }
    }
    if (propSchema.enum && !propSchema.enum.includes(value)) {
      problems.push(`"${key}" expected one of ${JSON.stringify(propSchema.enum)}, got ${JSON.stringify(value)}`);
    }
  }
  return problems;
}

// Prove the validator actually bites before relying on it below.
check(
  'validator-catches-missing-required',
  validateParams(REGISTRY.get('search'), { objectType: 'Container' }).some((p) => p.includes('query')),
  JSON.stringify(validateParams(REGISTRY.get('search'), { objectType: 'Container' })),
);
check(
  'validator-catches-unknown-property',
  validateParams(REGISTRY.get('get_object'), { objectId: 'x', extra: 1 }).some((p) => p.includes('extra')),
  JSON.stringify(validateParams(REGISTRY.get('get_object'), { objectId: 'x', extra: 1 })),
);

// Gate operations aren't registry capabilities; skip those, don't fail them. The Worker-side
// report_result is checked against the Worker result contract instead.
function checkToolCallAgainstRegistry(label, call) {
  if (!call) return;
  if (call.name === 'report_result') {
    // A Worker's result contract (packages/platform-extension's report_result tool takes exactly
    // this schema), not a registry capability.
    const parsed = shared.WorkerResultContractSchema.safeParse(call.args);
    check(
      `${label}-result-contract`,
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues),
    );
    return;
  }
  if (!REGISTRY.has(call.name)) {
    console.log(`skip ${label}: ${call.name} is not a registry capability`);
    return;
  }
  const problems = validateParams(REGISTRY.get(call.name), call.args);
  check(`${label}-params-vs-registry`, problems.length === 0, problems.join('; '));
  const parsed = shared.getCapability(call.name).paramsSchema.safeParse(call.args);
  check(
    `${label}-params-vs-schema`,
    parsed.success,
    parsed.success ? '' : JSON.stringify(parsed.error.issues),
  );
}

async function post(messages, stream = false, extra = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-echo', stream, messages, ...extra }),
  });
  if (stream) {
    const text = await res.text();
    return { status: res.status, sse: text };
  }
  return { status: res.status, json: await res.json() };
}

function toolCallOf(json) {
  const call = json.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return undefined;
  return { name: call.function.name, args: JSON.parse(call.function.arguments) };
}

async function main() {
  shared = await loadShared();
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    // Wait for the server to come up.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        if (res.ok) break;
      } catch {
        // not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 1. Pre-existing behavior untouched: plain echo.
    {
      const { json } = await post([{ role: 'user', content: 'hello there' }]);
      check(
        'echo-unchanged',
        json.choices[0].message.content === 'echo: hello there' &&
          json.choices[0].finish_reason === 'stop',
        JSON.stringify(json.choices[0]),
      );
    }

    // 2. Pre-existing behavior untouched: "search" trigger.
    {
      const { json } = await post([{ role: 'user', content: 'please search for X' }]);
      const call = toolCallOf(json);
      check(
        'search-trigger-unchanged',
        json.choices[0].finish_reason === 'tool_calls' &&
          call?.name === 'search' &&
          JSON.stringify(call.args) === '{"query":"test"}',
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('search-trigger-unchanged', call);
    }

    // 3. docker_restart scenario, turn 1 (no prior assistant messages): tool call with extracted
    //    CONTAINER_ID.
    {
      const messages = [
        {
          role: 'custom',
          content:
            '## NextTime worker context\n\n### Task input\nACCEPT_S2_SCENARIO=docker_restart CONTAINER_ID=abc123',
        },
        { role: 'user', content: 'Begin working on your assigned Task now' },
      ];
      const { json } = await post(messages);
      const call = toolCallOf(json);
      check(
        'docker-restart-turn1',
        call?.name === 'docker_container_restart' && call.args.id === 'abc123',
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('docker-restart-turn1', call);
    }

    // 3b. Same turn 1, but the request carries tool definitions (as pi's real requests do): the
    //     restart tool is picked from them, whatever the gate is named — the packaged docker gate
    //     enabled through the platform catalog (`enable_gate_instance`, STATUS leftover 36) is
    //     `gatekeeper-docker`, not `docker`, so `docker_container_restart` is only the no-tools
    //     fallback case 3 above exercises.
    {
      const messages = [
        {
          role: 'custom',
          content:
            '## NextTime worker context\n\n### Task input\nACCEPT_S2_SCENARIO=docker_restart CONTAINER_ID=abc123',
        },
        { role: 'user', content: 'Begin working on your assigned Task now' },
      ];
      const tools = [
        { type: 'function', function: { name: 'report_result', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'gatekeeper-docker_containers_list', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'gatekeeper-docker_container_restart', parameters: { type: 'object' } } },
      ];
      const { json } = await post(messages, false, { tools });
      const call = toolCallOf(json);
      check(
        'docker-restart-turn1-catalog-gate-name',
        call?.name === 'gatekeeper-docker_container_restart' && call.args.id === 'abc123',
        JSON.stringify(json.choices[0]),
      );
    }

    // 4. docker_restart scenario, turn 2 (one prior assistant message): report_result call.
    {
      const messages = [
        {
          role: 'custom',
          content:
            '## NextTime worker context\n\n### Task input\nACCEPT_S2_SCENARIO=docker_restart CONTAINER_ID=abc123',
        },
        { role: 'user', content: 'Begin working on your assigned Task now' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'docker_container_restart', arguments: '{"id":"abc123"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'pending approval, actionRequestId ar-1' },
      ];
      const { json } = await post(messages);
      const call = toolCallOf(json);
      check(
        'docker-restart-turn2',
        call?.name === 'report_result' &&
          Array.isArray(call.args.factsToAssert) &&
          call.args.factsToAssert.length === 1 &&
          call.args.factsToAssert[0].source.identity.containerId === 'abc123',
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('docker-restart-turn2', call);
    }

    // 5. ssh_run scenario, turn 1: tool call with extracted COMMAND, reused identically across two
    //    separate "conversations" (first pending, second auto-approved — same scripted turn 1).
    {
      const messages = [
        {
          role: 'custom',
          content: '### Task input\nACCEPT_S2_SCENARIO=ssh_run COMMAND=uptime',
        },
        { role: 'user', content: 'Begin working on your assigned Task now' },
      ];
      const { json } = await post(messages);
      const call = toolCallOf(json);
      check(
        'ssh-run-turn1',
        call?.name === 'accept_s2_ssh_ssh_run_command' && call.args.command === 'uptime',
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('ssh-run-turn1', call);
    }

    // 6. Entry-mode chat scenarios, turn 1: scripted regardless of whether packages/platform-
    //    extension currently registers the tool being called (see docs/runbooks/
    //    host-accept-s2.md "已知偏离") — this scenario is ready either way.
    {
      const { json } = await post([{ role: 'user', content: '重启测试容器 CONTAINER_ID=deadbeef' }]);
      const call = toolCallOf(json);
      check(
        'entry-restart-chat-turn1',
        call?.name === 'find_workers' && call.args.need === 'restart',
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('entry-restart-chat-turn1', call);
    }
    {
      const { json } = await post([{ role: 'user', content: '测试 API 的 GET 返回什么' }]);
      const call = toolCallOf(json);
      check(
        'entry-observe-chat-turn1',
        call?.name === 'accept_s2_api_stock_get',
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('entry-observe-chat-turn1', call);
    }

    // 6a. entryRestartChatScenario turn 2: once find_workers' *real* result is in history, the
    //     scenario chains invoke_worker off it (definitionId/version from the result, not a
    //     hardcoded guess), carrying the CONTAINER_ID marker through into `input`.
    {
      const messages = [
        { role: 'user', content: '重启测试容器 CONTAINER_ID=deadbeef' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_fw', type: 'function', function: { name: 'find_workers', arguments: '{"need":"restart"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_fw',
          // find_workers is a find_* capability: `{items}` envelope, not a bare array
          // (docs/wire-contract-conventions.md §3; server.mjs reads `.items`).
          content: JSON.stringify({
            items: [{ definitionId: 'ops-runner-uuid', version: 3, kind: 'worker', name: 'ops-runner' }],
          }),
        },
      ];
      const { json } = await post(messages);
      const call = toolCallOf(json);
      check(
        'entry-restart-chat-turn2',
        call?.name === 'invoke_worker' &&
          call.args.definitionId === 'ops-runner-uuid' &&
          call.args.version === 3 &&
          call.args.wait === false &&
          typeof call.args.input === 'string' &&
          call.args.input.includes('ACCEPT_S2_SCENARIO=docker_restart') &&
          call.args.input.includes('CONTAINER_ID=deadbeef'),
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('entry-restart-chat-turn2', call);
    }

    // 6b. entryRestartChatScenario turn 2, find_workers came back empty/unresolved (today's
    //     reality — see the SKIP-replacement fallback text) — never guesses a definitionId.
    {
      const messages = [
        { role: 'user', content: '重启测试容器 CONTAINER_ID=deadbeef' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_fw', type: 'function', function: { name: 'find_workers', arguments: '{"need":"restart"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_fw', content: 'Error: unknown tool "find_workers"' },
      ];
      const { json } = await post(messages);
      check(
        'entry-restart-chat-turn2-unresolved',
        json.choices[0].finish_reason === 'stop' &&
          typeof json.choices[0].message.content === 'string' &&
          json.choices[0].message.content.includes('did not resolve'),
        JSON.stringify(json.choices[0]),
      );
    }

    // 6c. entryRestartChatScenario turn 3: once invoke_worker's *real* result is in history, the
    //     final text names the real taskId.
    {
      const messages = [
        { role: 'user', content: '重启测试容器 CONTAINER_ID=deadbeef' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_fw', type: 'function', function: { name: 'find_workers', arguments: '{"need":"restart"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_fw',
          content: JSON.stringify({ items: [{ definitionId: 'ops-runner-uuid', version: 3, kind: 'worker' }] }),
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_iw', type: 'function', function: { name: 'invoke_worker', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_iw',
          // invoke_worker's result is the created Task resource keyed `id` (docs/wire-contract-
          // conventions.md §2), not `taskId`.
          content: JSON.stringify({ id: 'task-999', workerRunId: 'wr-1', status: 'running' }),
        },
      ];
      const { json } = await post(messages);
      check(
        'entry-restart-chat-turn3',
        json.choices[0].finish_reason === 'stop' &&
          json.choices[0].message.content.includes('task-999'),
        JSON.stringify(json.choices[0]),
      );
    }

    // 6d. entryObserveChatScenario turn 2: echoes accept_s2_api_stock_get's *real* returned data.
    {
      const messages = [
        { role: 'user', content: '测试 API 的 GET 返回什么' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_ob', type: 'function', function: { name: 'accept_s2_api_stock_get', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_ob',
          content: JSON.stringify({ status: 'ok', data: { symbol: 'NXT', quantity: 42 } }),
        },
      ];
      const { json } = await post(messages);
      check(
        'entry-observe-chat-turn2',
        json.choices[0].finish_reason === 'stop' &&
          json.choices[0].message.content.includes('NXT') &&
          json.choices[0].message.content.includes('42'),
        JSON.stringify(json.choices[0]),
      );
    }

    // 6e. S3.9 entryDependencyChatScenario turn 1: "哪个服务依赖哪个" -> search({objectType:'Container'}).
    {
      const { json } = await post([{ role: 'user', content: '哪个服务依赖哪个' }]);
      const call = toolCallOf(json);
      check(
        'entry-dependency-chat-turn1',
        call?.name === 'search' && JSON.stringify(call.args) === '{"query":"","objectType":"Container"}',
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('entry-dependency-chat-turn1', call);
    }

    // 6f. turn 2: once search's *real* result (containing the kernel Container) is in history, the
    //     scenario chains traverse off its real id — never a guessed one.
    {
      const messages = [
        { role: 'user', content: '哪个服务依赖哪个' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_s', type: 'function', function: { name: 'search', arguments: '{"query":"","objectType":"Container"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_s',
          content: JSON.stringify({
            items: [
              { id: 'postgres-container-id', identityKey: { composeProjectId: 'p', serviceName: 'postgres' } },
              { id: 'kernel-container-id', identityKey: { composeProjectId: 'p', serviceName: 'kernel' } },
            ],
          }),
        },
      ];
      const { json } = await post(messages);
      const call = toolCallOf(json);
      check(
        'entry-dependency-chat-turn2',
        call?.name === 'traverse' &&
          call.args.fromId === 'kernel-container-id' &&
          call.args.linkType === 'depends_on' &&
          call.args.depth === 1,
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('entry-dependency-chat-turn2', call);
    }

    // 6g. turn 2, search found no kernel Container — never guesses a fromId.
    {
      const messages = [
        { role: 'user', content: '哪个服务依赖哪个' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_s', type: 'function', function: { name: 'search', arguments: '{"query":"","objectType":"Container"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_s', content: JSON.stringify({ items: [] }) },
      ];
      const { json } = await post(messages);
      check(
        'entry-dependency-chat-turn2-unresolved',
        json.choices[0].finish_reason === 'stop' &&
          typeof json.choices[0].message.content === 'string' &&
          json.choices[0].message.content.includes('did not resolve'),
        JSON.stringify(json.choices[0]),
      );
    }

    // 6h. turn 3: once traverse's *real* result is in history, the scenario chains get_object off
    //     the edge's real targetObjectId.
    {
      const messages = [
        { role: 'user', content: '哪个服务依赖哪个' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_s', type: 'function', function: { name: 'search', arguments: '{"query":"","objectType":"Container"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_s',
          content: JSON.stringify({ items: [{ id: 'kernel-container-id', identityKey: { serviceName: 'kernel' } }] }),
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_t', type: 'function', function: { name: 'traverse', arguments: '{"fromId":"kernel-container-id","linkType":"depends_on","depth":1}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_t',
          content: JSON.stringify({
            nodes: ['postgres-container-id'],
            edges: [{ linkId: 'fact-1', linkType: 'depends_on', sourceObjectId: 'kernel-container-id', targetObjectId: 'postgres-container-id', depth: 1 }],
          }),
        },
      ];
      const { json } = await post(messages);
      const call = toolCallOf(json);
      check(
        'entry-dependency-chat-turn3',
        call?.name === 'get_object' && call.args.objectId === 'postgres-container-id',
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('entry-dependency-chat-turn3', call);
    }

    // 6i. turn 4: once get_object's *real* result is in history, the final text names the real
    //     dependency's serviceName.
    {
      const messages = [
        { role: 'user', content: '哪个服务依赖哪个' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_s', type: 'function', function: { name: 'search', arguments: '{"query":"","objectType":"Container"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_s',
          content: JSON.stringify({ items: [{ id: 'kernel-container-id', identityKey: { serviceName: 'kernel' } }] }),
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_t', type: 'function', function: { name: 'traverse', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_t',
          content: JSON.stringify({
            nodes: ['postgres-container-id'],
            edges: [{ linkId: 'fact-1', linkType: 'depends_on', sourceObjectId: 'kernel-container-id', targetObjectId: 'postgres-container-id', depth: 1 }],
          }),
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_g', type: 'function', function: { name: 'get_object', arguments: '{"objectId":"postgres-container-id"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_g',
          content: JSON.stringify({ id: 'postgres-container-id', identityKey: { serviceName: 'postgres' } }),
        },
      ];
      const { json } = await post(messages);
      check(
        'entry-dependency-chat-turn4',
        json.choices[0].finish_reason === 'stop' &&
          json.choices[0].message.content.includes('postgres') &&
          json.choices[0].message.content.includes('depends_on'),
        JSON.stringify(json.choices[0]),
      );
    }

    // 6j. S11 GO5e-1 entryGoalChatScenario: "发起验收目标" — find_workers, then find_operations,
    //     then propose_goal chained off both *real* results, then the agent's own confirm_goal
    //     attempt, then a final text accept_s2.sh reads.
    {
      const WORKER_ID = '11111111-1111-4111-8111-111111111111';
      const GATE_ID = '22222222-2222-4222-8222-222222222222';
      const GOAL_ID = '33333333-3333-4333-8333-333333333333';
      const ask = { role: 'user', content: '发起验收目标 GOAL_NONCE=n42' };
      const call = (id, name, args) => ({
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      });
      const result = (id, content) => ({
        role: 'tool',
        tool_call_id: id,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      });
      const foundWorkers = [
        call('call_fw', 'find_workers', { need: 'restart' }),
        result('call_fw', { items: [{ definitionId: WORKER_ID, version: 2, kind: 'worker', name: 'ops-runner' }] }),
      ];
      const foundOperations = [
        call('call_fo', 'find_operations', { need: 'stock' }),
        result('call_fo', {
          items: [
            {
              id: 'op-object-id',
              objectType: 'Operation',
              identityKey: { gatekeeperId: GATE_ID, name: 'stock.get', version: 1 },
              properties: { kind: 'observe' },
              reachability: { kind: 'direct' },
            },
          ],
        }),
      ];
      const proposedOnce = [
        call('call_pg', 'propose_goal', {}),
        result('call_pg', { goalRunId: GOAL_ID, status: 'proposed', changed: true, planRevisionId: 'rev-1', hints: [] }),
      ];

      {
        const { json } = await post([ask]);
        const turn1 = toolCallOf(json);
        check('entry-goal-chat-turn1', turn1?.name === 'find_workers' && turn1.args.need === 'restart', JSON.stringify(json.choices[0]));
        checkToolCallAgainstRegistry('entry-goal-chat-turn1', turn1);
      }
      {
        const { json } = await post([ask, ...foundWorkers]);
        const turn2 = toolCallOf(json);
        check('entry-goal-chat-turn2', turn2?.name === 'find_operations' && turn2.args.need === 'stock', JSON.stringify(json.choices[0]));
        checkToolCallAgainstRegistry('entry-goal-chat-turn2', turn2);
      }
      {
        const { json } = await post([ask, call('call_fw', 'find_workers', { need: 'restart' }), result('call_fw', 'Tool find_workers not found')]);
        check(
          'entry-goal-chat-turn2-unresolved',
          json.choices[0].finish_reason === 'stop' && json.choices[0].message.content.includes('did not resolve'),
          JSON.stringify(json.choices[0]),
        );
      }
      {
        const { json } = await post([ask, ...foundWorkers, ...foundOperations]);
        const turn3 = toolCallOf(json);
        const step = turn3?.args?.plan?.steps?.[0];
        const acceptance = turn3?.args?.plan?.acceptance?.[0];
        check(
          'entry-goal-chat-turn3',
          turn3?.name === 'propose_goal' &&
            step?.worker?.definitionId === WORKER_ID &&
            step.worker.version === 2 &&
            step.input === 'ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=n42' &&
            acceptance?.kind === 'observe_predicate' &&
            acceptance.check.gatekeeperId === GATE_ID &&
            acceptance.check.operation === 'stock.get' &&
            turn3.args.idempotencyKey === 'accept-s2-goal-n42',
          JSON.stringify(json.choices[0]),
        );
        // A step's Worker sees its input (and the goal's statement may reach it): the chat marker
        // there would hand the Worker the entry agent's script.
        check(
          'entry-goal-chat-turn3-no-chat-marker',
          turn3 !== undefined && !JSON.stringify(turn3.args).includes('发起验收目标'),
          JSON.stringify(turn3?.args),
        );
        checkToolCallAgainstRegistry('entry-goal-chat-turn3', turn3);
      }
      {
        // The entry agent's session is resident: an earlier asking with another nonce is still in
        // the history. The newest asking's nonce is the one used.
        const earlier = { role: 'user', content: '发起验收目标 GOAL_NONCE=old1' };
        const { json } = await post([earlier, { role: 'assistant', content: 'earlier reply' }, ask, ...foundWorkers, ...foundOperations]);
        const turn3 = toolCallOf(json);
        check(
          'entry-goal-chat-turn3-newest-nonce',
          turn3?.name === 'propose_goal' && turn3.args.idempotencyKey === 'accept-s2-goal-n42',
          JSON.stringify(json.choices[0]),
        );
      }
      {
        const { json } = await post([ask, ...foundWorkers, ...foundOperations, ...proposedOnce]);
        const turn4 = toolCallOf(json);
        check(
          'entry-goal-chat-turn4',
          turn4?.name === 'confirm_goal' && turn4.args.goalRunId === GOAL_ID && turn4.args.revision === 1,
          JSON.stringify(json.choices[0]),
        );
        checkToolCallAgainstRegistry('entry-goal-chat-turn4', turn4);
      }
      {
        // pi's answer to a tool entry mode does not register: plain text, not a confirmation.
        const { json } = await post([
          ask,
          ...foundWorkers,
          ...foundOperations,
          ...proposedOnce,
          call('call_cg', 'confirm_goal', { goalRunId: GOAL_ID, revision: 1 }),
          result('call_cg', 'Tool confirm_goal not found'),
        ]);
        const text = json.choices[0].message.content;
        check(
          'entry-goal-chat-turn5',
          json.choices[0].finish_reason === 'stop' &&
            text.includes(`GOAL_ID=${GOAL_ID}`) &&
            text.includes('GOAL_STATUS=proposed') &&
            text.includes('GOAL_CHANGED=true') &&
            text.includes('CONFIRM_GOAL=unavailable'),
          JSON.stringify(json.choices[0]),
        );
      }
      {
        // Had the confirmation gone through, the reply says so — accept_s2.sh's assertion bites.
        const { json } = await post([
          ask,
          ...foundWorkers,
          ...foundOperations,
          ...proposedOnce,
          call('call_cg', 'confirm_goal', { goalRunId: GOAL_ID, revision: 1 }),
          result('call_cg', { goalRunId: GOAL_ID, status: 'running', changed: true, createdStepRunIds: ['s1'] }),
        ]);
        check(
          'entry-goal-chat-turn5-confirmed-shows',
          json.choices[0].message.content.includes('CONFIRM_GOAL=confirmed'),
          JSON.stringify(json.choices[0]),
        );
      }
      {
        // Asked again in the same chat: the newest asking restarts the script at turn 1, and the
        // agent's earlier propose_goal call (whose input carries the Worker marker) never flips it
        // onto the Worker script.
        const { json } = await post([
          ask,
          ...foundWorkers,
          ...foundOperations,
          ...proposedOnce,
          { role: 'assistant', content: 'first reply' },
          { role: 'user', content: '发起验收目标 GOAL_NONCE=n42' },
        ]);
        const again = toolCallOf(json);
        check('entry-goal-chat-asked-again', again?.name === 'find_workers', JSON.stringify(json.choices[0]));
      }
      {
        const { json } = await post([
          ask,
          call('call_pg', 'propose_goal', { plan: { steps: [{ input: 'ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=n42' }] } }),
          result('call_pg', { goalRunId: GOAL_ID, status: 'proposed', changed: true }),
        ]);
        const notWorker = toolCallOf(json);
        check('entry-goal-chat-not-worker-script', notWorker?.name !== 'report_result', JSON.stringify(json.choices[0]));
      }
    }

    // 6k. S11 GO5e-1 goalStepScenario: the goal's step Worker reports back with no Fact.
    {
      const { json } = await post([
        { role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=n42' },
        { role: 'user', content: 'Begin working on your assigned Task now' },
      ]);
      const call = toolCallOf(json);
      check(
        'goal-step-worker',
        call?.name === 'report_result' &&
          Array.isArray(call.args.factsToAssert) &&
          call.args.factsToAssert.length === 0 &&
          call.args.summary.includes('n42'),
        JSON.stringify(json.choices[0]),
      );
      checkToolCallAgainstRegistry('goal-step-worker', call);
    }

    // 6l. S11 GO7a entryGoalDagChatScenario: "发起三步验收目标" — the same two finds, then a
    //     three-step plan (a and b side by side, c after both) chained off both real results,
    //     then a final text accept_s2.sh reads. Not mistaken for "发起验收目标"'s script.
    {
      const WORKER_ID = '11111111-1111-4111-8111-111111111111';
      const GATE_ID = '22222222-2222-4222-8222-222222222222';
      const GOAL_ID = '44444444-4444-4444-8444-444444444444';
      const ask = { role: 'user', content: '发起三步验收目标 GOAL_NONCE=d42' };
      const call = (id, name, args) => ({
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      });
      const result = (id, content) => ({
        role: 'tool',
        tool_call_id: id,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      });
      const foundWorkers = [
        call('call_fw', 'find_workers', { need: 'restart' }),
        result('call_fw', { items: [{ definitionId: WORKER_ID, version: 2, kind: 'worker', name: 'ops-runner' }] }),
      ];
      const foundOperations = [
        call('call_fo', 'find_operations', { need: 'stock' }),
        result('call_fo', {
          items: [{ id: 'op-object-id', objectType: 'Operation', identityKey: { gatekeeperId: GATE_ID, name: 'stock.get', version: 1 } }],
        }),
      ];
      {
        const { json } = await post([ask]);
        const turn1 = toolCallOf(json);
        check('entry-goal-dag-turn1', turn1?.name === 'find_workers' && turn1.args.need === 'restart', JSON.stringify(json.choices[0]));
      }
      {
        const { json } = await post([ask, ...foundWorkers, ...foundOperations]);
        const turn3 = toolCallOf(json);
        const steps = turn3?.args?.plan?.steps ?? [];
        check(
          'entry-goal-dag-turn3',
          turn3?.name === 'propose_goal' &&
            steps.map((st) => `${st.key}:${(st.dependsOn ?? []).join('+')}`).join(',') === 'a:,b:,c:a+b' &&
            steps.every(
              (st) =>
                st.worker.definitionId === WORKER_ID &&
                st.worker.version === 2 &&
                st.input === `ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=d42 STEP=${st.key}`,
            ) &&
            turn3.args.plan.acceptance?.[0]?.check?.gatekeeperId === GATE_ID &&
            turn3.args.idempotencyKey === 'accept-s2-goal-dag-d42',
          JSON.stringify(json.choices[0]),
        );
        check(
          'entry-goal-dag-turn3-no-chat-marker',
          turn3 !== undefined && !JSON.stringify(turn3.args).includes('验收目标'),
          JSON.stringify(turn3?.args),
        );
        checkToolCallAgainstRegistry('entry-goal-dag-turn3', turn3);
      }
      {
        const { json } = await post([
          ask,
          ...foundWorkers,
          ...foundOperations,
          call('call_pg', 'propose_goal', {}),
          result('call_pg', { goalRunId: GOAL_ID, status: 'proposed', changed: true, planRevisionId: 'rev-1', hints: [] }),
        ]);
        const text = json.choices[0].message.content;
        check(
          'entry-goal-dag-turn4',
          json.choices[0].finish_reason === 'stop' && text.includes(`GOAL_ID=${GOAL_ID}`) && text.includes('GOAL_STATUS=proposed'),
          JSON.stringify(json.choices[0]),
        );
      }
      {
        // "发起验收目标" asked earlier in the same resident session: the newest question wins.
        const { json } = await post([
          { role: 'user', content: '发起验收目标 GOAL_NONCE=n1' },
          { role: 'assistant', content: 'earlier reply' },
          ask,
          ...foundWorkers,
          ...foundOperations,
        ]);
        const turn3 = toolCallOf(json);
        check(
          'entry-goal-dag-after-single',
          turn3?.name === 'propose_goal' && turn3.args.plan.steps.length === 3,
          JSON.stringify(json.choices[0]),
        );
      }
    }

    // 6m. S11 GO7a goalLedgerStepScenario: the step's Worker asks for one ledger entry under the
    //     key its input names, then reports what the platform answered.
    {
      const input = { role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_ledger GOAL_NONCE=l42 LEDGER_KEY=s5-l42' };
      const begin = { role: 'user', content: 'Begin working on your assigned Task now' };
      {
        const { json } = await post([input, begin]);
        const call = toolCallOf(json);
        check(
          'goal-ledger-worker-turn1',
          call?.name === 'accept_s2_api_ledger_add' && call.args.key === 's5-l42',
          JSON.stringify(json.choices[0]),
        );
      }
      {
        const { json } = await post([
          input,
          begin,
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_la', type: 'function', function: { name: 'accept_s2_api_ledger_add', arguments: '{"key":"s5-l42"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_la', content: '{"status":"pending_approval","actionRequestId":"ar-1"}' },
        ]);
        const call = toolCallOf(json);
        check(
          'goal-ledger-worker-turn2',
          call?.name === 'report_result' &&
            call.args.factsToAssert.length === 0 &&
            call.args.summary.includes('s5-l42') &&
            call.args.summary.includes('pending_approval'),
          JSON.stringify(json.choices[0]),
        );
        checkToolCallAgainstRegistry('goal-ledger-worker-turn2', call);
      }
    }

    // 6n. S11 GO7a-3 held turns: a goal step with HOLD=<name> is not answered until the name is
    //     released; while held it is listed and its response headers are already out (its body
    //     waits); once released it never holds again; a turn asked again past the end of the script
    //     (the clamp) is not held; a held request whose client went away drops off the list.
    {
      const holdsBody = async () => (await fetch(`http://127.0.0.1:${PORT}/accept-s2/holds`)).json();
      const holds = async () => (await holdsBody()).holds;
      const release = async (name) =>
        (await (await fetch(`http://127.0.0.1:${PORT}/accept-s2/holds/${name}/release`, { method: 'POST' })).json()).released;
      const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
      const input = { role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=h42 STEP=a HOLD=s12-h42-a' };
      const begin = { role: 'user', content: 'Begin working on your assigned Task now' };
      let answered = false;
      const pending = post([input, begin]).then((reply) => {
        answered = true;
        return reply;
      });
      await settle();
      const listed = await holds();
      check('held-turn-listed', !answered && listed.includes('s12-h42-a'), JSON.stringify({ answered, listed }));
      check('held-turn-release-count', (await release('s12-h42-a')) === 1, 'expected one request released');
      const { json } = await pending;
      const call = toolCallOf(json);
      check('held-turn-answered', call?.name === 'report_result' && call.args.summary.includes('h42'), JSON.stringify(json.choices[0]));
      check('held-turn-unlisted', (await holds()).length === 0, 'expected no hold left');
      const heldCounts = (await holdsBody()).counts['s12-h42-a'];
      check('held-turn-counts', heldCounts?.held === 1 && heldCounts.dropped === 0, JSON.stringify(heldCounts));
      const again = toolCallOf((await post([input, begin])).json);
      check('held-turn-once', again?.name === 'report_result', 'a released name must answer at once');
      check('held-turn-release-none', (await release('never-held')) === 0, 'releasing an unknown name releases nothing');

      // Headers first: llm-proxy answers its client 502 when an upstream sends no response headers
      // within 10 s (UPSTREAM_CONNECT_TIMEOUT_MS), so a held turn has its status and content type
      // at once, streamed or not, and only its body waits for the release.
      for (const [stream, nonce, type] of [
        [true, 'h45', 'text/event-stream'],
        [false, 'h46', 'application/json'],
      ]) {
        const label = stream ? 'stream' : 'json';
        const name = `s12-${nonce}-a`;
        const res = await Promise.race([
          fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'fake-echo',
              stream,
              messages: [{ role: 'custom', content: `### Task input\nACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=${nonce} STEP=a HOLD=${name}` }, begin],
            }),
          }),
          new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
        ]);
        const heldNow = (await holds()).includes(name);
        check(
          `held-turn-headers-first-${label}`,
          res?.status === 200 && (res.headers.get('content-type') ?? '').startsWith(type) && heldNow,
          JSON.stringify({ status: res?.status, type: res?.headers.get('content-type'), heldNow }),
        );
        if (!res) continue;
        let bodyDone = false;
        const body = res.text().then((text) => {
          bodyDone = true;
          return text;
        });
        await settle();
        check(`held-turn-body-waits-${label}`, !bodyDone, 'the body must wait for the release');
        check(`held-turn-headers-first-release-${label}`, (await release(name)) === 1, 'expected one request released');
        const text = await body;
        const answered = stream
          ? text.includes('"report_result"') && text.includes('data: [DONE]')
          : toolCallOf(JSON.parse(text))?.name === 'report_result';
        check(`held-turn-body-after-release-${label}`, answered, text.slice(0, 300));
        const counts = (await holdsBody()).counts[name];
        check(`held-turn-headers-first-counts-${label}`, counts?.held === 1 && counts.dropped === 0, JSON.stringify(counts));
      }

      // The clamp: one assistant message already answered the script's only turn.
      const clampInput = { role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=h43 STEP=a HOLD=s12-h43-a' };
      const reported = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_rr', type: 'function', function: { name: 'report_result', arguments: '{}' } }],
      };
      const clamped = toolCallOf((await post([clampInput, begin, reported, { role: 'tool', tool_call_id: 'call_rr', content: '{}' }])).json);
      check('held-turn-clamp-not-held', clamped?.name === 'report_result' && (await holds()).length === 0, JSON.stringify(clamped));

      // A client that goes away while held.
      const goneInput = { role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=h44 STEP=a HOLD=s12-h44-a' };
      const controller = new AbortController();
      const gone = fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-echo', messages: [goneInput, begin] }),
        signal: controller.signal,
      }).catch(() => 'aborted');
      await settle();
      const before = await holds();
      controller.abort();
      await gone;
      await settle();
      const after = await holds();
      check('held-turn-client-gone', before.includes('s12-h44-a') && !after.includes('s12-h44-a'), JSON.stringify({ before, after }));
      const goneCounts = (await holdsBody()).counts['s12-h44-a'];
      check('held-turn-client-gone-counted', goneCounts?.held === 1 && goneCounts.dropped === 1, JSON.stringify(goneCounts));
      // Asked again after its client went away (a Worker's SDK retrying a cut model call): held
      // again under the same name, the count saying so.
      let againAnswered = false;
      const againPending = post([goneInput, begin]).then((reply) => {
        againAnswered = true;
        return reply;
      });
      await settle();
      const reHeld = await holdsBody();
      check(
        'held-turn-asked-again',
        !againAnswered && reHeld.holds.includes('s12-h44-a') && reHeld.counts['s12-h44-a'].held === 2 && reHeld.counts['s12-h44-a'].dropped === 1,
        JSON.stringify({ againAnswered, reHeld }),
      );
      check('held-turn-asked-again-release', (await release('s12-h44-a')) === 1, 'expected the one request asked again released');
      await againPending;
    }

    // 6o. S11 GO7a-3 goalThreeWritesScenario: three ledger writes under <k>-1..3, the third asked
    //     only once its hold is released, then a report naming each answer.
    {
      const input = { role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_three_writes LEDGER_KEY=s8l-t42 HOLD=s8l-t42-a' };
      const begin = { role: 'user', content: 'Begin working on your assigned Task now' };
      const wrote = (id, key, answer) => [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name: 'accept_s2_api_ledger_add', arguments: JSON.stringify({ key }) } }],
        },
        { role: 'tool', tool_call_id: id, content: answer },
      ];
      const first = toolCallOf((await post([input, begin])).json);
      check('three-writes-turn1', first?.name === 'accept_s2_api_ledger_add' && first.args.key === 's8l-t42-1', JSON.stringify(first));
      const one = wrote('call_w1', 's8l-t42-1', '{"status":"pending_approval","actionRequestId":"ar-1"}');
      const second = toolCallOf((await post([input, begin, ...one])).json);
      check('three-writes-turn2', second?.name === 'accept_s2_api_ledger_add' && second.args.key === 's8l-t42-2', JSON.stringify(second));
      const two = wrote('call_w2', 's8l-t42-2', '{"status":"pending_approval","actionRequestId":"ar-2"}');
      let answered = false;
      const pending = post([input, begin, ...one, ...two]).then((reply) => {
        answered = true;
        return reply;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const listed = (await (await fetch(`http://127.0.0.1:${PORT}/accept-s2/holds`)).json()).holds;
      check('three-writes-third-held', !answered && listed.includes('s8l-t42-a'), JSON.stringify({ answered, listed }));
      await fetch(`http://127.0.0.1:${PORT}/accept-s2/holds/s8l-t42-a/release`, { method: 'POST' });
      const third = toolCallOf((await pending).json);
      check('three-writes-turn3', third?.name === 'accept_s2_api_ledger_add' && third.args.key === 's8l-t42-3', JSON.stringify(third));
      const three = wrote('call_w3', 's8l-t42-3', 'illegal_transition: request_action: goal step sr-1 is superseded and takes no new work (I-G9)');
      const report = toolCallOf((await post([input, begin, ...one, ...two, ...three])).json);
      check(
        'three-writes-report',
        report?.name === 'report_result' &&
          report.args.factsToAssert.length === 0 &&
          report.args.findings.length === 3 &&
          report.args.findings[0].startsWith('s8l-t42-1: ') &&
          report.args.findings[2].startsWith('s8l-t42-3: ') &&
          report.args.findings[2].includes('superseded'),
        JSON.stringify(report),
      );
      checkToolCallAgainstRegistry('three-writes-report', report);
      // Not mistaken for goal_ledger's script (whose marker it does not contain), nor the reverse.
      const ledger = toolCallOf(
        (await post([{ role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_ledger GOAL_NONCE=l43 LEDGER_KEY=s5-l43' }, begin])).json,
      );
      check('three-writes-not-goal-ledger', ledger?.args?.key === 's5-l43', JSON.stringify(ledger));
    }

    // 6p. S11 GO14 goalHandoffStepScenario: the first step writes its token into /workspace/out;
    //     the second reads /upstream/a/handoff.txt, tries to write beside it, and reports both.
    {
      const begin = { role: 'user', content: 'Begin working on your assigned Task now' };
      const called = (id, name, args, answer) => [
        { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        { role: 'tool', tool_call_id: id, content: answer },
      ];
      const writer = { role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_handoff HANDOFF_ROLE=write HANDOFF_MARK=h42tok' };
      const wrote = toolCallOf((await post([writer, begin])).json);
      check(
        'handoff-write-turn1',
        wrote?.name === 'write' && wrote.args.path === '/workspace/out/handoff.txt' && wrote.args.content === 'h42tok\n',
        JSON.stringify(wrote),
      );
      const writeReport = toolCallOf(
        (await post([writer, begin, ...called('call_hw', 'write', wrote?.args ?? {}, 'Successfully wrote 7 bytes to /workspace/out/handoff.txt')])).json,
      );
      check('handoff-write-report', writeReport?.name === 'report_result' && !JSON.stringify(writeReport.args).includes('h42tok'), JSON.stringify(writeReport));
      checkToolCallAgainstRegistry('handoff-write-report', writeReport);

      const reader = { role: 'custom', content: '### Task input\nACCEPT_S2_SCENARIO=goal_handoff HANDOFF_ROLE=read' };
      const read = toolCallOf((await post([reader, begin])).json);
      check('handoff-read-turn1', read?.name === 'read' && read.args.path === '/upstream/a/handoff.txt', JSON.stringify(read));
      const readDone = called('call_hr', 'read', read?.args ?? {}, 'h42tok\n');
      const tamper = toolCallOf((await post([reader, begin, ...readDone])).json);
      check('handoff-read-turn2', tamper?.name === 'bash' && tamper.args.command.includes('/upstream/a/'), JSON.stringify(tamper));
      const tamperDone = called('call_hb', 'bash', tamper?.args ?? {}, "touch: cannot touch '/upstream/a/tamper': Read-only file system\nHANDOFF_WRITE_EXIT=1");
      const readReport = toolCallOf((await post([reader, begin, ...readDone, ...tamperDone])).json);
      check(
        'handoff-read-report',
        readReport?.name === 'report_result' &&
          readReport.args.summary.includes('HANDOFF_READ=[h42tok]') &&
          readReport.args.summary.includes('HANDOFF_WRITE_EXIT=1'),
        JSON.stringify(readReport),
      );
      checkToolCallAgainstRegistry('handoff-read-report', readReport);
    }

    // 6q. S11 GO9a/GO10b goalPlannerScenario (S13, and S6 for legacy 560): the planner's Task
    //     input as the kernel writes it (`### Task input` then the JSON, `kind: goal_planning`). A
    //     failed ledger step with `report-runner` among the workers: `revise`, the step moved onto
    //     it. A round for the goal's own acceptance (`failedAcceptance`, no `failedStep`):
    //     `no_revision`, naming the verification round. Both reports pass the Worker result contract
    //     and their `output` the planner's own schema.
    {
      const begin = { role: 'user', content: 'Begin working on your assigned Task now' };
      const plannerInput = (rest) => ({
        role: 'custom',
        content: `## NextTime worker context\n\n### Task input\n${JSON.stringify({ kind: 'goal_planning', basedOnRevision: 1, ...rest })}\n\n### Rules\nreport_result once.`,
      });
      const plan = {
        steps: [
          { key: 'write', worker: { definitionId: 'd-ops', version: 1 }, input: 'ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=s13a-p42', maxAttempts: 1 },
        ],
        acceptance: [{ kind: 'observe_predicate', key: 'stock-visible', check: {} }],
      };
      const workers = [{ name: 'report-runner', definitionId: 'd-rr', version: 3 }];
      const revise = toolCallOf((await post([plannerInput({ plan, failedStep: { key: 'write' }, workers }), begin])).json);
      const revised = revise?.args?.output?.plan?.steps?.[0];
      check(
        'goal-planner-revise',
        revise?.name === 'report_result' &&
          revise.args.output.decision === 'revise' &&
          revised?.key === 'write' &&
          revised.worker?.definitionId === 'd-rr' &&
          revised.worker.version === 3 &&
          revised.input === 'ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=s13a-p42' &&
          JSON.stringify(revise.args.output.plan.acceptance) === JSON.stringify(plan.acceptance),
        JSON.stringify(revise),
      );
      checkToolCallAgainstRegistry('goal-planner-revise', revise);
      const reviseOutput = shared.PlannerOutputSchema.safeParse(revise?.args?.output);
      check('goal-planner-revise-output', reviseOutput.success, reviseOutput.success ? '' : JSON.stringify(reviseOutput.error.issues));

      const accepted = { ...plan, steps: [{ key: 'report', worker: { definitionId: 'd-ops', version: 1 }, input: 'ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=s6-p42 STEP=report' }] };
      const none = toolCallOf(
        (await post([plannerInput({ plan: accepted, failedAcceptance: { round: 2, checks: [{ key: 'stock-unseen', kind: 'observe_predicate', status: 'failed' }] }, workers }), begin])).json,
      );
      check(
        'goal-planner-acceptance-no-revision',
        none?.name === 'report_result' &&
          none.args.output.decision === 'no_revision' &&
          none.args.output.reason.includes("the goal's acceptance round 2 ") &&
          !none.args.output.reason.includes('(unknown)'),
        JSON.stringify(none),
      );
      checkToolCallAgainstRegistry('goal-planner-acceptance-no-revision', none);
      const noneOutput = shared.PlannerOutputSchema.safeParse(none?.args?.output);
      check('goal-planner-acceptance-no-revision-output', noneOutput.success, noneOutput.success ? '' : JSON.stringify(noneOutput.error.issues));
    }

    // 7. Streaming mode also honors scenarios (SSE contains the scripted tool name).
    {
      const { sse } = await post(
        [
          {
            role: 'custom',
            content: '### Task input\nACCEPT_S2_SCENARIO=docker_restart CONTAINER_ID=xyz789',
          },
          { role: 'user', content: 'Begin working on your assigned Task now' },
        ],
        true,
      );
      check(
        'docker-restart-stream',
        sse.includes('"name":"docker_container_restart"') && sse.includes('xyz789') && sse.includes('data: [DONE]'),
        sse.slice(0, 400),
      );
    }

    // 8. No marker, no "search" word: still plain echo (scenario matching never false-positives).
    {
      const { json } = await post([{ role: 'user', content: 'what is the weather' }]);
      check(
        'no-scenario-fallback',
        json.choices[0].message.content === 'echo: what is the weather',
        JSON.stringify(json.choices[0]),
      );
    }

    // 9. S5.4 tool-schema validation (docs/retrospective-2026-09-11.md §3.1): a request whose
    //    tool's `parameters` is not a `type: "object"` schema is rejected wholesale, like a real
    //    OpenAI-compatible upstream would — this is the exact failure mode §3.1 documents.
    {
      const tools = [{ type: 'function', function: { name: 'bad_tool', parameters: null } }];
      const { status, json } = await post([{ role: 'user', content: 'hello there' }], false, { tools });
      check(
        'invalid-tool-schema-null-rejected',
        status === 400 && json.error?.code === 'invalid_function_parameters' && json.error.message.includes('bad_tool'),
        JSON.stringify({ status, json }),
      );
    }
    // 9a. Same rejection for a non-object top-level schema (e.g. a Gatekeeper Operation whose
    //     params_schema never got normalized to `type: "object"` — the exact §3.1 shape).
    {
      const tools = [{ type: 'function', function: { name: 'other_tool', parameters: { type: 'string' } } }];
      const { status, json } = await post([{ role: 'user', content: 'hello there' }], false, { tools });
      check(
        'invalid-tool-schema-non-object-rejected',
        status === 400 && json.error?.code === 'invalid_function_parameters',
        JSON.stringify({ status, json }),
      );
    }
    // 9b. A well-formed `tools` array never trips the check — plain echo still goes through.
    {
      const tools = [
        { type: 'function', function: { name: 'good_tool', parameters: { type: 'object', properties: {} } } },
      ];
      const { status, json } = await post([{ role: 'user', content: 'hello there' }], false, { tools });
      check(
        'valid-tool-schema-not-rejected',
        status === 200 && json.choices[0].message.content === 'echo: hello there',
        JSON.stringify({ status, json }),
      );
    }
  } finally {
    child.kill();
  }

  if (failures > 0) {
    console.log(`fake-llm scenario self-test: FAILED (${failures} failure(s))`);
    process.exit(1);
  }
  console.log('fake-llm scenario self-test: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
