# @nexttime/web

React + Vite SPA served statically by caddy (design doc §7.6): the workspace console — login,
chats, approvals, tasks, connections. No UI framework, no router library, no web fonts, no CDN:
the console is served on a LAN host with no internet, so everything ships in the bundle.

## Develop

```bash
corepack pnpm --filter @nexttime/web dev
```

Proxies `/api` and `/ws` to `KERNEL_DEV_URL` (default `http://127.0.0.1:8080`, the kernel's own
default `KERNEL_PORT`) so the app talks to a same-origin `/ws`/`/api/*` exactly as behind caddy
(deploy/caddy/Caddyfile). `KERNEL_DEV_URL=http://127.0.0.1:9090 corepack pnpm --filter @nexttime/web dev`
points it elsewhere.

## Build

```bash
corepack pnpm --filter @nexttime/web... build   # `...` builds @nexttime/shared first
```

Output: `packages/web/dist/` — copied into the caddy image by deploy/caddy/Dockerfile
(docs/runbooks/host-caddy.md §E8.5). `@nexttime/shared` is a real runtime import now (the status
enums and transition tables drive the UI), resolved to its `dist/` by the production build.

## Structure

```
src/
  App.tsx                 session (one WsClient + one HttpClient) + hash routing + providers
  lib/
    http-client.ts        POST /api/cap/<name> — default fetch is a wrapper, never the bare global
    ws-client.ts          /ws JSON-RPC: subscribe-then-page, reconnect, principal pushes, status
    errors.ts             describeError → {code, title, message} (HTTP error.code / JSON-RPC codes)
    clients.ts            CapabilityCaller / PushSource — the narrow interfaces pages depend on
    status-tone.ts        status → tone/label maps typed over @nexttime/shared enums
    router.ts             #/chats, #/chats/<id>, #/approvals[/<id>], #/tasks[/<id>], #/connections
    action-card.ts        the three ActionRequest sources normalized to one ActionCardData
    tasks.ts / connections.ts   wire shapes + pure helpers for those pages
    format.ts             shortId, relative time, duration, redactSensitive
    session.ts            API key in sessionStorage only
  hooks/
    useResource.ts        loading / error / ready(refreshing, refreshError) state machine
    usePermissions.tsx    403-derived "may not call X" for the session
    usePendingCount.ts    sidebar badge; useWsStatus.ts; usePushToasts.ts
  components/ui/          Button StatusChip Card PageHeader EmptyState ErrorBanner Notice Skeleton
                          Field(+Input/Select/Textarea) Drawer Toast DataList Tabs Kbd CopyId Icon
  components/shell/       AppShell, Sidebar
  components/             LoginPage ChatListPage ChatPage ApprovalQueuePage ActionRequestDetail
                          ActionRequestCard TasksPage TaskDetail ConnectionsPage
                          CompleteConnectionForm RequestConnectionForm RegisteredSystemsSection
                          ToolCallRowView TurnStatusBadge SystemStatusLineView
  styles/                 tokens.css base.css shell.css ui.css pages.css (imported by styles.css)
```

## Pages and the capabilities they call

| Page | Reads | Writes | Live |
|---|---|---|---|
| Chats / Chat | `list_chats` `get_chat_history` `subscribe_chat` (WS) | `new_chat` `send_chat_message` `stop_agent` (WS); inline cards: `approve` `reject` `set_auto_approved_action_kind` (HTTP) | `chat.*`, `action.updated` |
| Approvals | `list_pending` `get_action` | `approve` `reject` `set_auto_approved_action_kind` | `action.pending` `action.updated` |
| Tasks | `list_tasks` `get_task` `list_worker_definitions` `list_pending` | `cancel_task` | `task.updated` |
| Connections | `list_connection_requests` `search` (Gatekeeper / Operation) | `request_connection` `create_connection` `publish_manifest` `connect_gatekeeper` | — |

Every page renders one of four states from `useResource`: skeleton, `ErrorBanner` (stable wire
code + kernel message + Retry), `EmptyState`, or the list. Status chips take their vocabulary from
`@nexttime/shared` (`ACTION_REQUEST_STATUS_VALUES`, `TASK_STATUS_VALUES`, `WORKER_RUN_STATUS_VALUES`,
`CONNECTION_REQUEST_STATUS_VALUES`, `PUBLISHABLE_STATUS_VALUES`) — `lib/status-tone.ts` is typed
`Record<Status, ...>` per machine and `StatusChip.test.tsx` walks every value, so a new kernel
state cannot render unstyled unnoticed.

Roles: no capability returns the caller's role, so the console infers denial from the first 403
(`hooks/usePermissions.tsx`) and hides/explains owner- and operator-only affordances from then on.
Kernel gaps the UI works around are listed in docs/runbooks/web-console.md.

## `lib/ws-client.ts`

Typed JSON-RPC 2.0 client for `/ws` (design doc §9.4) — the one place the "subscribe first, then
page history" rule lives. `subscribeChat(chatId, startAfter, handlers)` delivers deduped, in-order
`onMessage`/`onStream`/`onMetadata`/`onCaughtUp`; `-32010` rejects as `TurnAlreadyRunningError`.
Reconnect is automatic (re-authenticate, re-subscribe from the last delivered `sequence`).
Principal-scoped pushes (`onActionPending` / `onActionUpdated` / `onTaskUpdated`) are registered
once per listener and survive reconnects (the server re-subscribes on `authenticate`).
`getStatus()` / `onStatusChange()` expose `connecting | connected | reconnecting | closed` for the
sidebar indicator.

## `lib/http-client.ts`

`POST /api/cap/<name>` with `Authorization: Bearer <api key>`, envelope `{ok:true,result}` /
`{ok:false,error:{code,message}}` → `HttpError` (`kind`: `network | invalid_response |
capability_error`, `code` = the wire code). The default `fetchImpl` is `(input, init) =>
fetch(input, init)` — the bare global assigned as a method was invoked with `this === HttpClient`
and every browser rejected it with `Illegal invocation` (`http-client.default-fetch.test.ts`).

## Tests

```bash
corepack pnpm --filter @nexttime/web test
```

Vitest. `lib/*.test.ts` run in `node`; component tests (`*.test.tsx`) opt into jsdom with a
`// @vitest-environment jsdom` pragma and register `afterEach(cleanup)` themselves
(`globals: false`). Notable suites: `http-client.default-fetch` (receiver of the default fetch),
`ApprovalQueuePage` (loading → error → retry → empty → ready, 403 explanation, optimistic
decisions, push reconcile), `StatusChip` (exhaustive over every shared enum value),
`CompleteConnectionForm` (validation, params shape, 400 field mapping, 502 verbatim),
`ActionRequestCard`, `ws-client` (incl. connection status), `errors`, `format`.

## End-to-end (Playwright)

Opt-in — **not** part of `pnpm test`/CI (no browser, no kernel there). Two suites:

- `e2e/chat.spec.ts` — the S1.8 flow (登录 → 新对话 → 发消息 → 看到流式回复 → 刷新后历史完整).
- `e2e/approvals.spec.ts` — the S2.10 flow (queue row → drawer → Approve → the chat card's chip
  turns `approved` and a status notice appears; holder isolation for a second principal). Needs a
  pending ActionRequest seeded first — see "Seeding a pending ActionRequest".

```bash
corepack pnpm --filter @nexttime/web exec playwright install chromium   # once per machine

corepack pnpm --filter @nexttime/kernel build
AGENT_RUNTIME=fake DATABASE_URL=<postgres-url> node packages/kernel/dist/index.js
corepack pnpm --filter @nexttime/web dev

node packages/kernel/dist/cli/bootstrap.js add-principal \
  --workspace <workspace-id> --name bob --role operator   # prints principal id + API key

WEB_E2E_BASE_URL=http://127.0.0.1:5173 \
WEB_E2E_API_KEY=<owner-api-key> \
WEB_E2E_API_KEY_B=<bob-api-key> \
WEB_E2E_PRINCIPAL_ID_B=<bob-principal-id> \
corepack pnpm --filter @nexttime/web e2e
```

### Seeding a pending ActionRequest

The web owns no capability that can create a *pending* ActionRequest from a bare API key (a real
one needs `request_action` over a Handle plus a reachable Gatekeeper). `e2e/approvals.spec.ts`
expects the database to already hold one per scenario — run the block below **twice**, once per
`resource_scope` marker (`e2e-approve-flow`, `e2e-isolation-flow`; the spec hardcodes both):

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

The `outbox` row is what `application/linkage`'s consumer picks up on its next poll against the
already-running kernel — it writes the `system.action_pending` chat message and publishes the
`action.pending` push exactly as a real `request_action` would; a bare `action_requests` insert
alone produces neither. Sanity-check the column list against
`migrations/governance/000{3,4,5}_*.sql` on first run.
