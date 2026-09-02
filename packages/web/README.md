# @nexttime/web

React + Vite SPA served statically by caddy (design doc §7.6): login, chat list, chat page. S1.8
scope; approvals/tasks/connections/audit views land with their respective S2/S3 tasks.

## Develop

```bash
corepack pnpm --filter @nexttime/web dev
```

Proxies `/api` and `/ws` to `KERNEL_DEV_URL` (default `http://127.0.0.1:8080`, matching the
kernel's own default `KERNEL_PORT` — packages/kernel/src/index.ts) so the app talks to a
same-origin `/ws`/`/api/*` exactly like it does behind caddy in production (deploy/caddy/Caddyfile).
Point it at a different kernel with:

```bash
KERNEL_DEV_URL=http://127.0.0.1:9090 corepack pnpm --filter @nexttime/web dev
```

## Build

```bash
corepack pnpm --filter @nexttime/web build
```

Output: `packages/web/dist/` (Vite default) — the directory caddy mounts read-only at `/srv/web`
once it replaces the E8 placeholder (see docs/runbooks/host-caddy.md §E8.5).

## `lib/ws-client.ts`

Typed JSON-RPC 2.0 client for the kernel's `/ws` chat socket (design doc §9.4). The one place the
"subscribe first, then page history" rule lives — every caller only sees deduped, in-order
`onMessage`/`onStream`/`onMetadata` callbacks; it never reasons about the race between a live push
and a history page itself.

```ts
const client = new WsClient({ url: wsUrl() });
await client.connect();
await client.authenticate(apiKey); // first frame, per §9.4

const unsubscribe = await client.subscribeChat(chatId, /* startAfter */ 0, {
  onMessage: (message) => {
    /* ChatMessage: {id, role, text, createdAt, sequence} */
  },
  onStream: (turnId, payload) => {
    /* ChatStreamPayload: textDelta | toolCallStarted | toolCallEnded | workerSpawned | taskUpdated */
  },
  onMetadata: (metadata) => {
    /* {turnId, turnStatus} when a Turn ends */
  },
  onCaughtUp: () => {
    /* initial history paging has drained */
  },
});

const { messageId, sequence, turnId } = await client.sendChatMessage(chatId, text);
// -32010 (a Turn is already running) rejects with `TurnAlreadyRunningError`, not a generic error.
await client.stopAgent(chatId);
```

`call(method, params)` is the generic escape hatch for any other `chat`-group capability (e.g.
`list_chats`, `new_chat`) — see packages/shared/src/capabilities.ts for the full set and their
param shapes. Reconnect (an unexpected socket drop) is automatic: `WsClient` re-authenticates with
the same key and, if a chat was subscribed, re-subscribes with `startAfter` set to the last
`sequence` it already delivered — never redelivering a message, never losing one committed while
the socket was down.

## Tests

```bash
corepack pnpm --filter @nexttime/web test
```

Vitest, unit-only: `lib/ws-client.test.ts` (a fake `WebSocketLike`, no real socket or kernel) and
`lib/streaming-reducer.test.ts`. Runs in CI.

## End-to-end (Playwright)

Opt-in — **not** part of `pnpm test`/CI (no browser, no kernel there). Exercises the full S1.8
acceptance flow (docs/development-tasks.md S1.8: 登录 → 新对话 → 发消息 → 看到流式回复 → 刷新后历史完整)
against a real, running kernel.

```bash
# once per machine
corepack pnpm --filter @nexttime/web exec playwright install chromium

# 1. start a kernel with the deterministic fake agent runtime (packages/kernel/src/
#    application/host-bridge/fake-runtime.ts echoes the prompt back as "echo: <prompt>";
#    packages/kernel has no "start" script — it's an @nexttime/kernel library built by `build`
#    and run with plain `node`, or via the kernel service in docker-compose.yml)
corepack pnpm --filter @nexttime/kernel build
AGENT_RUNTIME=fake DATABASE_URL=<postgres-url> node packages/kernel/dist/index.js

# 2. start the web app pointed at it (see "Develop" above), or serve a production build
corepack pnpm --filter @nexttime/web dev

# 3. run the suite against that origin, with a valid API key for the kernel's workspace
WEB_E2E_BASE_URL=http://127.0.0.1:5173 \
WEB_E2E_API_KEY=<api-key> \
corepack pnpm --filter @nexttime/web e2e
```

**S1.10 hookup**: `scripts/accept_s1.sh` (docs/development-tasks.md S1.10) is expected to run this
suite as one of its checks once it exists — start the stack with `AGENT_RUNTIME=fake`, bootstrap a
workspace/principal and mint an API key the way the rest of that script already does for its own
assertions, then invoke `WEB_E2E_BASE_URL=<web origin> WEB_E2E_API_KEY=<key> corepack pnpm
--filter @nexttime/web e2e` and fail the script on a non-zero exit. Against the full deployment
(caddy fronting both kernel and web on one origin, deploy/caddy/Caddyfile), `WEB_E2E_BASE_URL` is
that origin directly — no dev proxy involved.

## 假设与偏离 (S1.8)

- The human (web) channel has no capability to read "is a Turn currently running on this chat" on
  open — `get_entry_context` (design doc §7.4) is Handle-channel only, S1 scope. The chat page
  therefore always opens with the composer enabled and discovers an already-running Turn reactively,
  from `send_chat_message`'s `-32010` response (surfaced as `TurnAlreadyRunningError`). `stop_agent`
  does not require knowing the Turn's id (the kernel resolves the chat's one running Turn
  server-side — `activities_one_running_turn_per_chat_uidx`), so the Stop button is always
  available regardless of whether this page itself started the Turn.
- `interfaces/ws`'s own `subscribe_chat` handler already replays up to `SUBSCRIBE_REPLAY_LIMIT`
  (500) persisted messages as live `chat.message` pushes as a convenience
  (packages/kernel/src/interfaces/ws/server.ts). `WsClient.subscribeChat` does not rely on that
  limit — it always walks `get_chat_history` itself to the end regardless, per the literal
  acceptance rule ("先 subscribe_chat 再 get_chat_history 翻页"); the server's own replay just means
  some of that walk's messages arrive slightly earlier over the live channel, which the
  `sequence`-keyed dedupe already handles.
