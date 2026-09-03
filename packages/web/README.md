# @nexttime/web

React + Vite SPA served statically by caddy (design doc §7.6): login, chat list, chat page,
approval cards + approval queue, Tasks & Workers, and a Connections page shell (S2.10). Audit/
explain views land with S3.

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

**S2.10 addition — `action.pending` / `action.updated` / `task.updated`** (design doc §9.4).
Unlike `chat.message`/`chat.stream`/`chat.metadata`, these three are not scoped to one Chat — the
kernel (`interfaces/ws/server.ts`) auto-subscribes every authenticated connection to its own
principal's copy of these three events the moment `authenticate` succeeds, no separate subscribe
call needed, and they carry no `chatId` at all. `WsClient` therefore exposes three independent
registration methods, dispatched by `method` name *before* the chatId-scoped switch every
`chat.*` push goes through — folding them into that switch would silently drop every one of them:

```ts
const unsubscribe = client.onActionPending((event) => {
  /* ActionPendingPush: {actionRequestId, gatekeeperId, title, description, actionKind:{tag,label},
     awaitDecision, simulated?} — the *only* source that carries title/description/simulated */
});
client.onActionUpdated((event) => {
  /* ActionUpdatedPush: {actionRequestId, status} */
});
client.onTaskUpdated((event) => {
  /* TaskUpdatedPush: {taskId, status} */
});
```

Each returns an `Unsubscribe`; multiple registrations are all delivered independently, and they
survive a reconnect with no extra bookkeeping (the *server* re-subscribes this principal on every
fresh `authenticate`). `ChatPage` uses `onActionUpdated` to update an already-rendered pending
card's status in place; `ApprovalQueuePage`/`TasksPage` use all three/`onTaskUpdated` respectively
to refresh their lists.

The same ActionRequest also lands as a persisted `chat_messages` row (`kind:
'system.action_pending'` / `'system.action_update'`, `packages/shared/src/chat-message-content.ts`)
in each holder's and the requester's own Chat — `ChatMessage.kind`/`.content` (added this task)
carry that shape verbatim. The `isHolder` field on that content is what decides whether
`ActionRequestCard` renders approve/reject buttons or a status-only line.

## `lib/http-client.ts`

`POST /api/cap/<name>` client (design doc §9.3) for every capability the chat WS socket cannot
reach — `interfaces/ws/server.ts` only forwards methods in the `chat` capability group
(`packages/shared/src/capabilities.ts`), so `approve`/`reject`/`list_pending`/`get_action`/
`set_auto_approved_action_kind`/`get_task`/`list_tasks`/the `connection` group all go over HTTP
instead, `Authorization: Bearer <api key>` (the same key `WsClient.authenticate` used), envelope
`{ok:true,result}` / `{ok:false,error:{code,message}}`. Mirrors
`packages/platform-extension/src/kernel-client.ts`'s shape without importing it (that package is
Node-only tooling, not published for browser import) — `HttpClient.call<T>(name, params)` resolves
with `result` or throws `HttpError` (`kind`: `'network' | 'invalid_response' | 'capability_error'`,
`code` = the wire error code on the latter).

## `lib/action-card.ts` / `lib/system-status.ts`

Three different shapes an ActionRequest can arrive in — a live `action.pending` push, a persisted
`system.action_pending` chat message, or a `list_pending`/`get_action` HTTP row — normalize into
one `ActionCardData` (`actionCardFromPush` / `actionCardFromPendingContent` / `actionCardFromRow`)
that `components/ActionRequestCard.tsx` renders. Only the push carries a real `title`/Markdown-ish
`description`/`simulated`; the other two synthesize a title from `actionKind`
(`humanizeActionKind`, mirroring the kernel's own `application/linkage` title-builder convention —
see that file's module doc comment for the full reasoning). `system.action_update`/
`system.task_update` are never cards — always a compact status line
(`lib/system-status.ts`'s `systemStatusLineFromMessage`, rendered by `SystemStatusLineView`).

## Views

- **Chat page** (`components/ChatPage.tsx`): `system.action_pending` messages render as
  `ActionRequestCard`s inline in the message list — full card with Approve/Reject(+reason)/"Always
  approve this kind" buttons when `isHolder`, status-only otherwise; `await_decision: true` and
  still pending gets the blocking (`.action-card-blocking`) style. A card's status updates in
  place from two sources that agree once both have arrived: a live `action.updated` push
  (`actionStatusOverrides` state) and a later `system.action_update` message already in this
  chat's own history (`latestActionStatus`, derived from `messages`). `system.action_update`/
  `system.task_update` render as compact `SystemStatusLineView` lines.
- **Approval queue** (`#/approvals`, `components/ApprovalQueuePage.tsx`): `list_pending` — the
  caller's own I14-scoped queue, every row `isHolder: true` by construction. Refreshes on
  `action.pending`/`action.updated`; a decided row simply leaves the list on the next refresh
  (`list_pending` only ever returns `pending_approval` rows) — the durable "this card, now
  decided" record lives in the chat instead.
- **Tasks & Workers** (`#/tasks`, `components/TasksPage.tsx`): the caller's own Tasks (newest
  first) with status/failure reason/a truncated result summary, and each Task's WorkerRuns in a
  small table. Uses the S2.10-added `list_tasks` capability (see "Kernel addition" below) and
  refreshes on `task.updated`.
- **Connections** (`#/connections`, `components/ConnectionsPage.tsx` + `ConnectionCard.tsx`): page
  shell + a connection card (kind/address/credentials) wired to `create_connection`
  (`packages/shared/src/capabilities.ts`, `group: 'connection'`). That capability's *shape* landed
  on `main` from S2.1 scaffolding, but S2.13 (`governance/connections`, the module that actually
  implements it) has not — every submission today gets the kernel's stable `501 not_implemented`
  envelope, shown as a distinct "not implemented yet" note rather than a generic error. See "已知偏离"
  below.

## Kernel addition — `list_tasks`

§9.3 never defined a list capability for Task (only `get_task`, one at a time by id) — the Tasks &
Workers view needs one, so this task adds `list_tasks` (`packages/shared/src/capabilities.ts`,
`channel: 'human'`, `minRole: 'member'`, no params): the caller's own Tasks, newest first, each
with its WorkerRuns. `application/task/service.ts`'s `listTasksForPrincipal` (one query for the
Task rows scoped to `on_behalf_of`, one batched query for every WorkerRun across them) plus a
`gateway/handlers.ts` handler reusing `get_task`'s own wire-shape mapper (`toWireTask`, extracted
from `getTaskHandler` so both share it) are the only kernel-side changes — `channel: 'human'` (not
`'handle'` like `get_task`) since this is a web-only "browse my own Tasks" facility a Worker/entry
Handle has no use for. Neither `ENTRY_CEILING_CAPABILITIES` nor `WORKER_CEILING_CAPABILITIES`
(`governance/capability/handles.ts`) derive from `group === 'task'` — both are explicit allowlists
— so this addition cannot leak into either Handle ceiling.

## Tests

```bash
corepack pnpm --filter @nexttime/web test
```

Vitest, unit-only. `lib/*.test.ts` (`ws-client`, `http-client`, `action-card`, `system-status`,
`streaming-reducer`) run in Vitest's default `node` environment — fakes for `WebSocketLike`/
`fetch`, no real socket, HTTP call, or kernel. `components/*.test.tsx` (`ActionRequestCard`,
`SystemStatusLineView`) render into `jsdom` via `@testing-library/react` — each such file opts in
with a `// @vitest-environment jsdom` pragma comment (`vitest.base.ts`'s shared default stays
`node`) and registers `afterEach(cleanup)` itself (`globals: false` means the library's automatic
cleanup hook never fires without an explicit registration). All run in CI (`corepack pnpm -r test`).

## End-to-end (Playwright)

Opt-in — **not** part of `pnpm test`/CI (no browser, no kernel there). Two suites:

- `e2e/chat.spec.ts` — the S1.8 flow (登录 → 新对话 → 发消息 → 看到流式回复 → 刷新后历史完整).
- `e2e/approvals.spec.ts` — the S2.10 flow (docs/development-tasks.md S2.10: 卡片出现 → 批准 →
  状态更新 → 对话里出现更新；用户 B 看不到 A 的卡片；授予 B 该动作范围后卡片出现在 B 自己的队列并可批准，
  A 的对话里只显示状态). **Needs a pending ActionRequest already in the database** before it runs —
  see "Seeding a pending ActionRequest" below.

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

# 3. bootstrap a second principal (role operator — approve/list_pending/grant_capability's target
#    need it) for the isolation suite, if one does not already exist
node packages/kernel/dist/cli/bootstrap.js add-principal \
  --workspace <workspace-id> --name bob --role operator
# prints: principal created: <principal-id>   (this is WEB_E2E_PRINCIPAL_ID_B below)
# API key (shown once — store it securely, only its hash is kept):
# <api-key>                                    (this is WEB_E2E_API_KEY_B below)

# 4. seed the two pending ActionRequests this suite needs (see next section), then run it
WEB_E2E_BASE_URL=http://127.0.0.1:5173 \
WEB_E2E_API_KEY=<owner-api-key> \
WEB_E2E_API_KEY_B=<bob-api-key> \
WEB_E2E_PRINCIPAL_ID_B=<bob-principal-id> \
corepack pnpm --filter @nexttime/web e2e
```

### Seeding a pending ActionRequest

`packages/web` owns no capability that can create a *pending, awaiting-a-human-decision*
ActionRequest from a bare API key — a real one requires `request_action` (handle-channel only) plus
a real, reachable Gatekeeper to evaluate policy against (S2.4/S2.13 scope, not this task's). Per
this task's dispatch brief ("a pending row inserted via psql then approved through the UI is
acceptable for this spec"), `e2e/approvals.spec.ts` instead expects the *database* to already have
one seeded — run the block below **twice**, once per `resource_scope` marker (`e2e-approve-flow`
for the first suite, `e2e-isolation-flow` for the second — the spec file hardcodes both literals,
so they must match exactly), against the same Postgres the kernel under test is using:

```bash
psql "$DATABASE_URL" -v workspace_id=<workspace-id> -v on_behalf_of=<owner-principal-id> \
  -v resource_scope=e2e-approve-flow <<'SQL'
insert into objects (workspace_id, object_type, properties)
values (:'workspace_id'::uuid, 'Gatekeeper', '{"name":"e2e-test-gate"}'::jsonb)
returning id as gatekeeper_id \gset

insert into action_requests
  (workspace_id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
   policy_decision, await_decision, on_behalf_of, actor_runtime, params)
values
  (:'workspace_id'::uuid, 'pending_approval', :'gatekeeper_id'::uuid, 'e2e.approval_card_test',
   :'resource_scope', 'medium', 'require_approval', true, :'on_behalf_of'::uuid, 'worker',
   '{}'::jsonb)
returning id as action_request_id \gset

insert into outbox (workspace_id, event_type, payload)
values (
  :'workspace_id'::uuid,
  'ActionRequestPending',
  jsonb_build_object(
    'type', 'ActionRequestPending',
    'workspaceId', :'workspace_id',
    'actionRequestId', :'action_request_id',
    'gatekeeperId', :'gatekeeper_id',
    'actionKind', 'e2e.approval_card_test',
    'resourceScope', :'resource_scope',
    'holderPrincipalIds', jsonb_build_array(:'on_behalf_of')
  )
);

\echo seeded action_request_id: :action_request_id
SQL
```

Run it again with `-v resource_scope=e2e-isolation-flow` for the second suite. `on_behalf_of` is
the **owner**'s principal id both times (the `WEB_E2E_API_KEY` principal) — the second row's sole
initial holder is deliberately only the owner too (`holderPrincipalIds` = just `on_behalf_of`), so
`bob` (B) starts out with no visibility into it, matching the isolation test's first assertion.

Why a raw `action_requests` insert alone is not enough: nothing dispatches a domain event for it,
so no `chat.message`/`action.pending` push ever fires and no card appears anywhere — the *outbox*
row above is what `application/linkage`'s `registerActionRequestConsumers`
(packages/kernel/src/application/linkage/action-request-consumer.ts) picks up on its next poll
tick against the *already-running* kernel from step 1, writing the `system.action_pending` chat
message and publishing the `action.pending` push exactly as a real `request_action` call would.
The `objects` row satisfies `action_requests.gatekeeper_id`'s foreign key with something real
enough to read back (`object_type: 'Gatekeeper'`) without needing a live Gatekeeper endpoint —
nothing in this flow ever calls it.

**Not verified against a live Postgres from this sandbox** (no Docker/DB available here) — sanity-
check the column list against `migrations/governance/000{3,4}_action_requests*.sql` on first run
and adjust if the schema has drifted since this was written.

**S1.10/S2.12 hookup**: `scripts/accept_s1.sh`/`scripts/accept_s2.sh` are expected to run these
suites as part of their own checks — start the stack with `AGENT_RUNTIME=fake`, bootstrap
workspace/principals and mint API keys the way those scripts already do for their own assertions,
seed as above, then invoke `corepack pnpm --filter @nexttime/web e2e` with the env vars set and
fail the script on a non-zero exit. Against the full deployment (caddy fronting both kernel and web
on one origin, deploy/caddy/Caddyfile), `WEB_E2E_BASE_URL` is that origin directly — no dev proxy
involved.

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
