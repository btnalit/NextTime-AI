#!/usr/bin/env node
// Local self-test for deploy/fake-llm/server.mjs's S2.12 scenario logic (docs/development-tasks.md
// S2.12; "a small node self-test of the fake-llm scenario logic if practical" — task brief).
// Starts the real server as a child process, drives it with a handful of representative
// /v1/chat/completions requests, and asserts:
//   1. The pre-existing `search`-trigger and plain-echo behaviors are byte-for-byte unchanged.
//   2. Each S2.12 scenario picks the right tool/args on its first turn and advances to its second
//      scripted turn once one prior assistant message is in history.
//   3. A request matching no scenario and no "search" word still falls through to plain echo.
//
// Not part of `pnpm test` — this directory is not a pnpm workspace package (same reason
// deploy/fake-llm/server.mjs itself is plain ESM, see its own header comment). Run directly:
//   node deploy/accept-s2/fake-llm-scenario-selftest.mjs
// Exits 0 and prints "fake-llm scenario self-test: OK" on success; prints failures and exits 1
// otherwise.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(HERE, '..', 'fake-llm', 'server.mjs');
const PORT = 8790;

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label} ${detail ?? ''}`);
  }
}

async function post(messages, stream = false) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-echo', stream, messages }),
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
    }

    // 6. Entry-mode gap scenarios: scripted, first turn attempts the (currently unregistered) tool.
    {
      const { json } = await post([{ role: 'user', content: '重启测试容器' }]);
      const call = toolCallOf(json);
      check('entry-restart-chat-turn1', call?.name === 'find_workers', JSON.stringify(json.choices[0]));
    }
    {
      const { json } = await post([{ role: 'user', content: '测试 API 的 GET 返回什么' }]);
      const call = toolCallOf(json);
      check(
        'entry-observe-chat-turn1',
        call?.name === 'accept_s2_api_stock_get',
        JSON.stringify(json.choices[0]),
      );
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
