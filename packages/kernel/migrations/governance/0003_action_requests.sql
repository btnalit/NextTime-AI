-- module: governance, version: 0003
--
-- action_requests (design doc §5.1.4, §5.4 I6/I7/I13/I14, §5.5, §9.2 increment comment;
-- docs/development-tasks.md S2.1). The ActionRequest state machine's storage: every governed
-- write a Worker attempts against a Gatekeeper (`request_action`, packages/shared/src/
-- capabilities.ts governance group) creates one row here, and every `approve`/`reject`/`execute`
-- against it is a transition on the 13-state graph in packages/shared/src/transitions.ts
-- (`ACTION_REQUEST_TRANSITIONS`) — I6 "ActionRequest 只沿转移表走" is enforced in the application
-- layer by that transition table; this migration's job is to make the *stored* states/columns
-- consistent with it and to add the one cross-cutting invariant (I7) that must hold regardless of
-- which code path writes a row.
--
-- Column provenance (taken from existing code, not re-invented — see PR body "假设" for the ones
-- not literally spelled out in docs/development-tasks.md S2.1's dispatch text):
--   - `gatekeeper_id` / `action_kind` / `resource_scope`: packages/shared/src/events.ts
--     `ActionRequestPendingEvent` (`gatekeeperId: z.string()`, `actionKind: z.string()`,
--     `resourceScope: z.string().optional()`) and `request_action`'s paramsSchema
--     (`{ gatekeeperId: id, operation: z.string(), params: jsonRecord }`, capabilities.ts
--     governance group). `resource_scope` is therefore `text`, not `jsonb` — matching the Zod
--     shape exactly, not the jsonb shape `capability_grants.scope` uses one file up.
--   - No `gatekeepers` table exists to foreign-key `gatekeeper_id` against (deliberate deviation
--     from the literal S2.1 dispatch text, which listed `gatekeepers` as a governance-module
--     deliverable — see PR body "已知偏离"): design doc §9.2's own increment-comment sketch says
--     plainly "gatekeeper_instances / operations / skills / procedures 作为平台元本体存于
--     objects / links，状态与版本在 properties", and §5.1.2/S2.13 confirm a registered Gatekeeper
--     is an `objects` row (platform meta-ontology), not a dedicated relational table — S2.13's
--     `connections/service.ts` "注册门 → 图里生成 Gatekeeper ... 对象". `gatekeeper_id` therefore
--     foreign-keys to `objects` (core module, already applied by the time this file runs — see
--     the runner-ordering note below), not to a table this migration invents.
--   - `blast_radius`: packages/shared/src/enums.ts `BLAST_RADIUS_VALUES` — a snapshot of the
--     invoked Operation's blast_radius at request time (the Operation's own value lives on its
--     graph Object and could change later; the ActionRequest's own audit trail must not).
--   - `policy_decision` / `await_decision` / `on_behalf_of` / `parent_worker_run_id` /
--     `actor_runtime` / `idempotency_key`: docs/development-tasks.md S2.1 dispatch text verbatim.
--   - `approval_decision_id`: "the approval decision reference" (S2.1 dispatch) — the Decision row
--     (`decisions`, core/0002_substrate.sql) that `approve`/`reject` writes in the same
--     transaction (docs/development-tasks.md S2.3: "同事务写 Approval Decision 并推进关联 agent
--     Decision"). `decisions` is a core-module table, so a real FK is possible (see below).
--
-- `policy_decision` is nullable, not `not null` (deviation from the S2.1 dispatch text's literal
-- column sketch — see PR body "已知偏离"): the ActionRequest transition table
-- (ACTION_REQUEST_TRANSITIONS) has a real `proposed` state that exists *before*
-- `evaluate_policy` fires (`{from: 'proposed', event: 'evaluate_policy', to: 'policy_evaluated'}`)
-- — a blanket `not null` would make that state impossible to persist at all, which would
-- contradict I6 more than it protects I7. The dispatch text's own example CHECK ("a row can only
-- be in an executed/executing state when policy_decision is not deny...") is a *conditional* rule
-- keyed off `status`, which only makes sense if `policy_decision` can be null for some
-- (pre-evaluation) status — that reading is what's implemented below. I7 is instead enforced by
-- the two CHECK constraints at the bottom of this table: every non-`proposed` row must carry a
-- decision, and no row may reach an executing-or-later status without an `allow` (or an
-- `approved` `require_approval`) decision on file.
--
-- Runner ordering (docs/development-tasks.md S2.1: "decide based on the actual migration ORDER
-- migrate.ts uses"): packages/kernel/src/adapters/db/migrate.ts's `discoverMigrations` sorts
-- module directories lexicographically, then by version within a module. Module names sort as
-- core < governance < llm-usage < task < worker — so `objects`, `activities`, and `decisions`
-- (all core module) already exist by the time this file runs, and a real composite FK to each is
-- used below. `worker_runs` (task module) does **not** exist yet — `task` sorts after
-- `governance` — so `parent_worker_run_id` below is a bare nullable `uuid` with no FK; the
-- referential check ("does this WorkerRun exist in this workspace?") is an application-level
-- concern for whichever module writes this column (S2.3/S2.7), documented here rather than
-- silently omitted. The same reasoning applies in reverse in
-- migrations/task/0001_tasks.sql for `tasks.worker_definition_id` (the `worker` module sorts
-- after `task`).
select pg_advisory_xact_lock(7241000201);

create table if not exists action_requests (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  status text not null default 'proposed'
    check (status in (
      'proposed', 'policy_evaluated', 'auto_approved', 'pending_approval', 'approved',
      'rejected', 'expired', 'denied', 'executing', 'executed', 'failed', 'verified', 'compensated'
    )),
  gatekeeper_id uuid not null,
  action_kind text not null,
  resource_scope text,
  blast_radius text not null check (blast_radius in ('low', 'medium', 'high')),
  policy_decision text check (policy_decision in ('allow', 'require_approval', 'deny')),
  approval_decision_id uuid,
  await_decision boolean not null default false,
  on_behalf_of uuid not null,
  -- No FK — see the runner-ordering note above; `worker_runs` does not exist when this file runs.
  parent_worker_run_id uuid,
  actor_runtime text not null,
  idempotency_key text,
  requested_at timestamptz not null default now(),
  executed_at timestamptz,
  failed_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, gatekeeper_id) references objects (workspace_id, id),
  foreign key (workspace_id, on_behalf_of) references principals (workspace_id, id),
  foreign key (workspace_id, approval_decision_id) references decisions (workspace_id, id),
  -- I6 (support): every state past `proposed` was reached via `evaluate_policy`, which always
  -- sets `policy_decision` in the same write — a non-`proposed` row with no decision on file is
  -- an invalid state regardless of which status it claims to be in.
  check (status = 'proposed' or policy_decision is not null),
  -- I7 (§5.4 "执行前必有 Policy 决策记录"; §5.3 item 3 "已执行的 ActionRequest 没有 Policy 决策记录"
  -- is a *never-allowed* relationship this CHECK makes unrepresentable): a row may only be in an
  -- executing-or-later status if it carries a decision, that decision is not `deny`, and — when
  -- the decision was `require_approval` — an approval Decision has actually been recorded.
  check (
    status not in ('executing', 'executed', 'verified', 'compensated')
    or (
      policy_decision is not null
      and policy_decision <> 'deny'
      and (policy_decision <> 'require_approval' or approval_decision_id is not null)
    )
  )
);

-- Partial unique index (not a plain `unique` column constraint): idempotency_key is optional —
-- not every caller of `request_action` supplies one — and a plain unique constraint would treat
-- repeated NULLs as non-conflicting under Postgres semantics anyway, but the `where` clause makes
-- that explicit rather than incidental, matching the same pattern
-- core/0006_object_identity.sql uses for `objects.identity_key`.
create unique index if not exists action_requests_idempotency_key_uidx
  on action_requests (workspace_id, idempotency_key)
  where idempotency_key is not null;

-- Index for the approval queue / I14 routing scan (S2.3: "drain 每 Gatekeeper 单飞、升序、遇
-- pending 停") and for `list_pending`.
create index if not exists action_requests_pending_idx
  on action_requests (workspace_id, status, requested_at)
  where status = 'pending_approval';

alter table action_requests enable row level security;

drop policy if exists action_requests_workspace_isolation on action_requests;

-- Workspace-only (not visibility-scoped to `on_behalf_of`), matching the same choice
-- core/0002_substrate.sql already made for `links`/`activities` (assumption — see PR body "假设"):
-- I14's routing explicitly sends a card to *every* Principal holding the matching scope, "不一定
-- 是发起对话的用户" (§8.5) — an owner-only RLS predicate would be actively wrong here, and G4's
-- "B 看不到 A 的卡片" (S2.10) is a UI/query-filtering concern (who a card is *pushed* to), not a
-- row-visibility one; any workspace member with DB access to the row is a `member`+ Principal
-- inside the tenant boundary I1 already protects.
create policy action_requests_workspace_isolation on action_requests
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant (mirrors capability_handles/capability_grants): G2 requires every *executed*
-- ActionRequest to remain reconstructable ("不存在无 policy 决策记录的已执行 ActionRequest") —
-- deleting a row would make that assertion unverifiable after the fact.
grant select, insert, update on action_requests to nexttime_app;
