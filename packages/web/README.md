# @nexttime/web

React + Vite SPA served statically by caddy (design doc §7.6): the workspace console — login,
chats, approvals, tasks, and (S3.11/S3.14) a governance control plane — members, access, systems,
capability catalog, models/quotas, audit. No UI framework, no router library, no web fonts, no
CDN: the console is served on a LAN host with no internet, so everything ships in the bundle
(`lib/router.ts`'s own hand-rolled hash router included — see that file's doc comment for why
S3.14 extended it instead of adding `react-router-dom`).

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
    errors.ts             describeError, isForbiddenError, isNotFoundError (S3.14: "not deployed yet")
    clients.ts             CapabilityCaller / PushSource — the narrow interfaces pages depend on
    status-tone.ts        status → tone/label maps typed over @nexttime/shared enums (+ grant, role)
    router.ts             hash routes: /login, /work/*, /me/agent, /govern/* (S3.14) — see its own doc
    role.ts                best-effort caller-role inference — fallback only as of S3.13; see "Roles"
    governance.ts          wire shapes for the S3.11 governance capabilities (members/grants/...)
    agent-profile.ts       wire shapes for the S3.13 AgentProfile/AgentPolicy capabilities
    action-card.ts        the three ActionRequest sources normalized to one ActionCardData
    tasks.ts / connections.ts   wire shapes + pure helpers for those pages (S3.12: connections.ts
                           also has operationDetailFromObject/reclassifiedOperationPayload — the
                           full Operation payload the onboarding wizard's review step reclassifies)
    format.ts              shortId, relative time, duration, redactSensitive
    session.ts             API key in sessionStorage only
  hooks/
    useResource.ts        loading / error / ready(refreshing, refreshError) state machine
    useCapability.ts       S3.14 data layer: useCapability/useCapabilityList over CapabilityCaller —
                           cache-by-(caller,name,params), push-triggered reload, nextCursor paging
    usePermissions.tsx    403/200-derived "may/may not call X" for the session (denied + allowed)
    useWorkspaceIdentity.ts  Sidebar's workspace name + role badge
    usePendingCount.ts    sidebar badge; useWsStatus.ts; usePushToasts.ts
  components/ui/          Button StatusChip Card PageHeader EmptyState ErrorBanner Notice Skeleton
                          Field(+Input/Select/Textarea) Drawer Toast DataList Tabs Kbd CopyId Icon
  components/shell/       AppShell, Sidebar (工作 Work / 治理 Governance nav, S3.14)
  components/             LoginPage ChatListPage ChatPage ApprovalQueuePage ActionRequestDetail
                          ActionRequestCard TasksPage TaskDetail ConnectionsPage (now at
                          /govern/systems) CompleteConnectionForm RequestConnectionForm
                          RegisteredSystemsSection GatekeeperDetailDrawer ToolCallRowView
                          TurnStatusBadge SystemStatusLineView
                          — S3.11/S3.14 governance pages: MembersPage (+ CreatePrincipalForm,
                          PrincipalDetail), AccessPage (+ GrantCapabilityForm), CatalogPage,
                          ModelsPage (+ ModelsTable), AuditPage
                          — S3.13: AgentProfilePage (+ AgentProfileForm, the 我的智能体 editor),
                          AgentPolicyForm (owner-only, on ModelsPage)
                          — S3.12: OnboardingWizard (+ OnboardingWizardReview) — the 接入向导 on
                          ConnectionsPage, a guided alternative to the existing "Connect a system"
                          drawer; reuses CompleteConnectionForm for its own step ②
  styles/                 tokens.css base.css shell.css ui.css pages.css (imported by styles.css)
```

## Routes

`lib/router.ts` — a hash route per view; unmatched/legacy hashes fall back to `/work/chats`.

| Path | Page | Section |
|---|---|---|
| `#/login` | (redirects to `/work/chats` once signed in) | — |
| `#/work/chats[/<id>]` | ChatListPage / ChatPage | 工作 chats |
| `#/work/tasks[/<id>]` | TasksPage | 工作 tasks |
| `#/work/approvals[/<id>]` | ApprovalQueuePage | 工作 approvals |
| `#/me/agent` | AgentProfilePage (S3.13) | 工作 agent |
| `#/govern/members` | MembersPage | 治理 members |
| `#/govern/access` | AccessPage | 治理 access |
| `#/govern/systems[/<gatekeeperId>]` | ConnectionsPage + GatekeeperDetailDrawer | 治理 systems |
| `#/govern/catalog[/<tab>]` | CatalogPage (operations/skills/procedures/workers) | 治理 catalog |
| `#/govern/models` | ModelsPage | 治理 models |
| `#/govern/audit` | AuditPage | 治理 audit |

## Pages and the capabilities they call

| Page | Reads | Writes | Live |
|---|---|---|---|
| Chats / Chat | `list_chats` `get_chat_history` `subscribe_chat` (WS) | `new_chat` `send_chat_message` `stop_agent` (WS); inline cards: `approve` `reject` `set_auto_approved_action_kind` (HTTP) | `chat.*`, `action.updated` |
| Approvals | `list_pending` `get_action` | `approve` `reject` `set_auto_approved_action_kind` | `action.pending` `action.updated` |
| Tasks | `list_tasks` `get_task` `list_worker_definitions` `list_pending` | `cancel_task` | `task.updated` |
| Systems (`/govern/systems`) | `list_connection_requests` `search` (Gatekeeper / Operation) `get_gatekeeper` | `request_connection` `create_connection` `publish_manifest` `connect_gatekeeper`; 接入向导 (S3.12, `OnboardingWizard`) additionally: `propose_operation` `publish_operation` (per-row reclassification) | — |
| Members | `list_principals` | `create_principal` `set_principal_role` `rotate_api_key` `disable_principal` | — |
| Access | `list_grants` `list_principals` | `grant_capability` `revoke_capability` | — |
| Catalog | `list_operations` `list_skills` `list_procedures` `list_worker_definitions` | `publish_operation`/`deprecate_operation`, `publish_skill`/`deprecate_skill`, `publish_procedure`/`deprecate_procedure`, `deprecate_worker_definition` | — |
| Models | `list_models` `get_agent_policy` `list_quotas` `list_policies` | `set_agent_policy` (owner; S3.13) | — |
| Audit | `explain` `reconstruct` `audit_query` | — | — |
| My Agent (`/me/agent`) | `get_agent_profile` `get_agent_policy` `list_models` `list_skills` `list_gatekeepers` `list_worker_definitions` `list_principals` (owner's principal picker) | `set_agent_profile` | — |

Every list page renders one of four states from `useResource`/`useCapability`: skeleton,
`ErrorBanner` (stable wire code + kernel message + Retry), `EmptyState`, or the list. Status chips
take their vocabulary from `@nexttime/shared` (`ACTION_REQUEST_STATUS_VALUES`, `TASK_STATUS_VALUES`,
`WORKER_RUN_STATUS_VALUES`, `CONNECTION_REQUEST_STATUS_VALUES`, `PUBLISHABLE_STATUS_VALUES`,
`GRANT_STATUS_VALUES`, `ROLE_VALUES`) — `lib/status-tone.ts` is typed `Record<Status, ...>` per
machine and `StatusChip.test.tsx` walks every value, so a new kernel state cannot render unstyled
unnoticed.

S3.11's governance capabilities (Members/Access/Systems' `get_gatekeeper`/Catalog's
`list_operations`/Models' `list_quotas`/`list_policies`) landed on `main` via PR #100 — this
console's own reads for them are unchanged from when they were coded against the parallel-PR
contract, but they no longer need to degrade for that reason day-to-day. S3.13's AgentProfile/
AgentPolicy capabilities (`get_agent_profile`/`set_agent_profile`/`get_agent_policy`/
`set_agent_policy`) are the current parallel-PR case: every read for them still treats a
`not_found` response (`lib/errors.ts` `isNotFoundError`) as "该能力尚未上线" (not live yet), an
`EmptyState`, never a crash — see `AgentProfilePage`/`ModelsPage`'s own doc comments for exactly
which reads degrade and why. `audit`'s three capabilities (`explain`/`reconstruct`/`audit_query`)
were never gated this way — they already existed and were wired before S3.11.

Roles: `get_workspace` now echoes the resolved caller back (`caller: {id, role, displayName,
kind}`, an S3.11 coordination addendum on top of PR #100) — `hooks/useWorkspaceIdentity.ts` uses
that as the **authoritative** role source (`lib/role.ts`'s `WorkspaceRole`, `{kind:'known', role}`)
the moment it resolves. The pre-S3.11 403/200 inference (`lib/role.ts` `inferRole`, `InferredRole`)
remains as a **fallback** for the window before that call resolves and for a kernel that predates
the `caller` field (`get_workspace` 404s `not_found`) — `{kind:'inferred', role}`. Per-affordance
visibility is unchanged: the first 403 on a capability (and, by the registry's `minRole` closure,
everything that needs at least as much role) marks it denied for the session
(`hooks/usePermissions.tsx`), and owner-/operator-only buttons hide or explain themselves from then
on — this still runs independently of the role badge, since a page's own capability call is always
more specific evidence than the coarse role label. For the Sidebar's role badge and the 治理
Governance nav guard: a known role renders via the same `StatusChip machine="role"` the Members
page uses for every principal's own role chip; an inferred role keeps its own bucket-label badge
(`owner` / `operator+` / `member` / unknown, `ROLE_BADGE_LABEL`) — 治理 hides only once `member` is
*proven*, known or inferred (`isProvenMember`); otherwise it stays visible and the kernel's own 403
renders inline on whichever page the caller opens. Kernel gaps the UI works around are listed in
docs/runbooks/web-console.md.

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

## `hooks/useCapability.ts`

The S3.14 data layer every governance page uses. `useCapability(caller, name, params?, options?)`
returns the same `Resource<T>` shape `hooks/useResource.ts` always has (`state` + `reload` +
`mutate`), seeded from an in-memory cache keyed by `(caller instance, name, serialized params)` —
so switching tabs/pages and back shows the last-known data immediately (`refreshing: true`) while
a fresh load runs in the background, instead of a skeleton flash. `options.reloadOn` re-fetches on
selected principal-scoped pushes (`actionPending`/`actionUpdated`/`taskUpdated`) when `options.pushes`
is given. `useCapabilityList` specializes it for the `{items, nextCursor?}` list envelope
(docs/wire-contract-conventions.md §3), adding `loadMore()`/`loadingMore`/`loadMoreError`. Every
call also feeds `hooks/usePermissions.tsx`'s `markAllowed`/`markDenied` automatically. Pre-S3.14
pages (Chats/Approvals/Tasks/Connections) keep their own `useResource(loader)` calls untouched —
this module is additive, not a rewrite of already-shipped, already-tested loaders.

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
`ActionRequestCard`, `ws-client` (incl. connection status), `errors`, `format`. S3.14 additions:
`router` (route parsing/fallback/href round-trip), `role` (inference), `useCapability` (caching,
push-triggered reload, pagination), `Sidebar` (nav guard + role badge), `MembersPage` (create → key
shown once, role change, disable), `AccessPage` (grant/revoke), `CatalogPage` (tab switching,
publish/deprecate), `GatekeeperDetailDrawer` (health-shape variants), `ModelsPage`.

S3.13 additions: `useWorkspaceIdentity` (known role once `get_workspace` resolves, inferred
fallback on `not_found`/loading), `AgentProfilePage` (pre-filled form, `not_found` degrade on the
self view, the six-field save payload with `null` for inherited/empty fields, 400 field errors,
AgentPolicy narrowing, `memberCanEditProfile` disabling the form, the owner's principal switch),
`ModelsPage` gains AgentPolicy-section cases (member sees a read-only summary, owner sees the
editable form and can save it).

S3.12 additions: `OnboardingWizard` (the full 5-step walkthrough; a successful reclassification's
`propose_operation` → `publish_operation` ordering; the 409 `conflict` a reclassification of an
`origin:'import'` Operation always gets today, rendered via `ErrorBanner` rather than crashing),
`ConnectionsPage` (new — the wizard's entry point and its finish → `onSelectGatekeeper` wiring;
the pre-existing "Connect a system" quick path is unchanged), `CompleteConnectionForm` gains a
case for the new `initialKind`/`hideKindField` props the wizard's own step ② uses.

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
