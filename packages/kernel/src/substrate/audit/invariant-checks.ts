import { ACTION_REQUEST_EDGES } from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * substrate/audit/invariant-checks: periodic, read-only, cross-workspace scans for the design
 * doc's own invariant list (§5.4 I1–I16; docs/development-tasks.md S3.8 "不变量监控与混沌").
 *
 * **Scope and posture.** Every check here is a *monitor*, not an enforcement mechanism — I1–I16's
 * real enforcement is the DB constraint/trigger or application code cited in each invariant's own
 * "机制" column (§5.4); this module exists to catch the case where that mechanism itself regresses
 * (a migration drops a trigger, a code path forgets to call the right helper) or where the
 * invariant is enforced entirely in application code with no DB-level backstop at all, and so has
 * no independent check *except* one written here. A check reading `violations: 0` on every tick
 * therefore does not mean "this invariant is unimportant" — several (I4, I7, I12, I13) are checks
 * the DB is already expected to make structurally impossible to violate; they exist as defense in
 * depth, not because a violation is expected.
 *
 * **Cross-workspace, admin-mode reads.** Every query here scans the whole database, not one
 * workspace — invariants are global properties of the schema, and the scheduler
 * (`packages/kernel/src/index.ts`) runs this on a timer, not per-request. Connections are taken
 * directly off a `MinimalPool` (declared locally, mirroring `governance/approval/execution.ts`'s
 * own `MinimalPool` — substrate must not depend on `adapters/db`, §7.10 six-layer rule), never
 * through `withWorkspace()`: the compose Postgres login role is a superuser and bypasses RLS by
 * design for exactly this kind of admin/monitoring scan (`adapters/db/pool.ts`'s own doc comment).
 *
 * **Why raw SQL against tables this module does not "own".** `substrate/audit` owns
 * `audit_records` (writer.ts's own doc comment: "other modules must not query its table
 * directly") — that rule is about *write-path coordination* between modules that both need to
 * change the same data; it is not a statement that nothing outside `audit_records` may ever be
 * *read*. An invariant checker's entire job is to independently verify properties that span
 * tables several different modules own (`action_requests` — governance/approval;
 * `capability_handles` — governance/capability; `links`/`activities` — this package's own graph
 * substrate) without trusting any one of those modules' own write path to have gotten it right —
 * trusting the write path is exactly the failure mode this module exists to catch. Every query
 * below is therefore plain SQL against table names, never an import of another module's internal
 * `src/` file (dependency-cruiser's layer rules are import-based and see none of this; the
 * boundary respected here is a documented, deliberate one, not a mechanical one).
 *
 * ## I1–I16 → check mapping
 *
 * | # | Invariant (§5.4, gloss) | DB-checkable here? | Query / reason |
 * |---|--------------------------|---------------------|-----------------|
 * | I1 | every business-table row has non-null `workspace_id` | No | Every such column is a `NOT NULL` in a composite `(workspace_id, id)` primary key (core/0002_substrate.sql's own doc comment: "impossible at the data layer"). A row violating this cannot exist to be scanned for — there is nothing to query. |
 * | I2 | a `links` row's `link_type` respects that LinkType's declared `domain`/`range` | No | Domain/range live in an ontology definition — the platform meta-ontology YAML (`substrate/ontology/loader.ts`, off-limits to this task) for meta-Links, or a workspace's published `ontology_versions.definition` for domain Links — resolved against `objects.object_type` by the graph write path (S1.2), not by any DB trigger (verified: no `check`/trigger in the migrations enforces this). Reproducing that resolution here would duplicate `substrate/ontology`'s own logic outside the module that owns it, for a module this task is explicitly not allowed to touch. |
 * | I3 | a `links` row has non-null `activity_id`/`asserted_by`/`recorded_at` | No | `NOT NULL` columns (core/0002_substrate.sql) — same structural argument as I1. |
 * | I4 | a recorded `links` row's content is append-only | Yes | `checkI4` — verifies the two enforcing triggers (`links_immutable_content`, `links_immutable_delete`) are present and enabled in `pg_trigger`. The triggers themselves make a real breach unrepresentable in the table; this check watches the mechanism, not the (unreachable) violation. |
 * | I5 | cross-source inconsistency → Conflict; same-source change → supersede | No | The same-source/cross-source branch is decided by comparing `source_id` at write time (S1.2's assert path) — `links` has no `source_id` column (only `activity_id`; the chain to a Source runs through Observation, which a Fact does not reference either). A "two active edges, no Conflict row" scan would conflate legitimate multi-edges with real breaches without replicating that same source comparison outside its owning module — documented gap, not approximated (same posture `get_operation_stats`'s own capability-registry doc comment already takes for its own audit-query gap). |
 * | I6 | an ActionRequest only ever moves along `ACTION_REQUEST_TRANSITIONS`' edges | Yes | `checkI6` — every `action_request.*` transition writes an AuditRecord carrying `resultingStatus` (`transition-log.ts`'s `recordTransition`, called from every mutator in `governance/approval`); consecutive rows for the same ActionRequest are compared against `@nexttime/shared`'s `ACTION_REQUEST_EDGES`. The very first recorded status per ActionRequest (row creation collapses `proposed → policy_evaluated → X` into one write, `request-action.ts`'s own `insertActionRequestRow`) has no predecessor to compare and is not independently re-validated here — that set of legal *initial* statuses is `governance/approval`'s own code-level contract. |
 * | I7 | execution requires a recorded, non-deny Policy decision | Yes | `checkI7` — mirrors the three `action_requests` CHECK constraints (governance/0003_action_requests.sql) that already make this structurally unrepresentable; defense in depth, expected to always read zero. |
 * | I8 | auto-approval requires both the Operation's own `auto_approvable` and the workspace policy rule | No | The Operation's current `auto_approvable` lives on a graph Object (`governance/gatekeepers`'s own projection), not as a column this module can join to without depending on that module's schema assumptions; the workspace rule is `policies.auto_approve`. Reconstructing "was the *double* signal actually satisfied at decision time" would require replicating `governance/policy/engine.ts`'s own evaluation outside the module that owns it. |
 * | I9 | no agent/kernel process holds an external credential | No | Process/environment-level (container env vars), not a database fact — nothing in Postgres represents this either way. |
 * | I10 | agent egress only via the proxy | No | Network/routing-level (no direct route from an agent container; proxy allow/deny) — outside anything a database query can observe. |
 * | I11 | every governed transition writes an AuditRecord in the same transaction | Yes | `checkI11` — a representative, not exhaustive, check: every `action_requests` row past `proposed` must have at least one `audit_records` row with `resource_type = 'action_request'` and matching `resource_id` (the shape `transition-log.ts`'s `recordTransition` always writes). Exhaustive coverage would mean one such check per governed table in the system — out of this task's bounded scope; ActionRequest is the invariant's own table-level example (§5.3 item 3: "已执行的 ActionRequest 没有 Policy 决策记录"). |
 * | I12 | a published OntologyVersion/WorkerDefinition is immutable | Yes | `checkI12` — same trigger-presence posture as I4: verifies `ontology_versions_immutable_definition` and `worker_definitions_immutable_published` are present and enabled. |
 * | I13 | `on_behalf_of` only from a Handle; a child Handle inherits from its parent | Yes | `checkI13` — for every `capability_handles` row with a `parent_jti`, its `on_behalf_of` must equal its parent's and its `expires_at` must not exceed its parent's. Correction from an earlier draft of this table (caught by CI's real-Postgres run, not reproducible in this task's own local environment): `governance/0001_capability_handles.sql`'s own `before update` trigger only blocks `on_behalf_of` from changing *after* issuance, but a separate, later migration — `governance/0008_capability_handle_inheritance.sql`'s `capability_handles_inheritance`, `before insert` — already enforces both of this check's own conditions at write time (a session-mismatch or parent-mismatch `on_behalf_of`, or an `expires_at` exceeding the parent's, is rejected on `INSERT`, not just blocked from being changed afterward). This check is therefore defense in depth like I4/I7/I12, not an independent backstop over an unenforced rule — kept anyway because a trigger-presence check alone would not catch the trigger's own *logic* regressing (e.g. a future edit flips the comparison), only its absence. |
 * | I14 | an approver must hold the `action_kind × resource_scope` they approved | Yes | `checkI14` — for every `approved` ActionRequest, the deciding Principal (via its Approval `decisions` row) must either be `owner` or have held a matching active `capability_grants` row *at `decided_at`* (compared against that row's own `created_at`/`revoked_at`/`expires_at` window, not "is it still active now" — a grant legitimately revoked after a valid approval must not read as a violation). Mirrors `governance/approval/reads.ts`'s own `approverHasScope`/`listPendingForApprover` matching logic. |
 * | I15 | an entry container's working directory/pi dir is mounted only to that user's own entry container | No | Container/filesystem mount-level (`worker-supervisor`'s own spawn spec) — no database representation of what is bind-mounted where. |
 * | I16 | a platform meta-ontology object may only be **published** over the human channel | Yes | `checkI16` — every `audit_records` row whose `action` is one of the five `publish_*` meta-ontology capabilities (`publish_ontology_version`/`publish_operation`/`publish_skill`/`publish_procedure`/`publish_worker_definition`) must carry `payload.channel = 'human'` (the shape `dispatch.ts` always writes). Every one of those five is already registered `channel: 'human'` (so `authorizeCapabilityCall` should refuse a Handle-channel call before a handler — let alone this audit write — is ever reached); this is an independent, DB-level backstop for that registry-level rule, not a re-check of something else already blocks structurally. The companion "Handle 通道只能写对提议者私有的草稿" half of I16 is not covered — it needs the object's `proposed_by` at call time, which the audit payload does not carry, and is left as a documented gap. |
 *
 * ## Beyond I1–I16 — operational-health checks
 *
 * Two extra checks the task brief names by example, tied to design doc §13 (故障恢复) rather than
 * a specific numbered invariant — both DB-enforced already (a partial unique index; the outbox's
 * own "replay anything undispatched" contract), included the same "defense in depth against the
 * mechanism regressing" way I4/I12 are:
 *
 * - `ops.one_running_turn` — at most one `activities` row per `(workspace_id, chat_id)` may be
 *   `kind = 'agent_turn', status = 'running'` at once (core/0008_chat_messages.sql's
 *   `activities_one_running_turn_per_chat_uidx` partial unique index).
 * - `ops.outbox_stuck` — an `outbox` row with `dispatched_at is null` older than a configurable
 *   threshold (default 30 minutes) — §13 "outbox 派发器崩溃 ... 消费者幂等" assumes the dispatcher
 *   eventually catches up; a row stuck well past that is a live symptom worth alerting on.
 */

export interface InvariantCheckResult {
  readonly invariant: string;
  readonly violations: number;
  /** Up to {@link SAMPLE_LIMIT} human-readable identifiers of violating rows — never the full set
   *  (this is a log/metrics line, not a data dump). */
  readonly sample: readonly string[];
}

/** Minimal `pg.Pool`-shaped port, declared locally rather than imported from `adapters/db/pool.ts`
 *  so this module never crosses the substrate→adapters layer boundary (§7.10) — exactly the same
 *  reasoning `governance/approval/execution.ts`'s own `MinimalPool` gives for itself. */
export interface MinimalPool {
  connect(): Promise<PoolClient>;
}

export interface RunInvariantChecksOptions {
  /** `ops.outbox_stuck`'s staleness threshold. Default {@link DEFAULT_OUTBOX_STUCK_THRESHOLD_MS}
   *  (30 minutes). */
  readonly outboxStuckThresholdMs?: number;
}

const SAMPLE_LIMIT = 5;

// -------------------------------------------------------------------------------------------
// Shared helper — trigger-presence checks (I4, I12).
// -------------------------------------------------------------------------------------------

interface ExpectedTrigger {
  readonly table: string;
  readonly trigger: string;
}

/** `'D'` = disabled in `pg_trigger.tgenabled` (Postgres catalog docs) — every other value
 *  (`'O'` origin, `'A'` always, `'R'` replica) counts as "enabled" for this check's purposes. */
async function checkTriggersPresent(
  client: PoolClient,
  invariant: string,
  expected: readonly ExpectedTrigger[],
): Promise<InvariantCheckResult> {
  const missing: string[] = [];
  for (const { table, trigger } of expected) {
    const result = await client.query<{ tgenabled: string }>(
      `select tgenabled from pg_trigger
       where tgrelid = $1::regclass and tgname = $2 and not tgisinternal`,
      [table, trigger],
    );
    const row = result.rows[0];
    if (!row || row.tgenabled === 'D') {
      missing.push(`${table}.${trigger}`);
    }
  }
  return { invariant, violations: missing.length, sample: missing.slice(0, SAMPLE_LIMIT) };
}

async function checkI4(client: PoolClient): Promise<InvariantCheckResult> {
  return checkTriggersPresent(client, 'I4', [
    { table: 'links', trigger: 'links_immutable_content' },
    { table: 'links', trigger: 'links_immutable_delete' },
  ]);
}

async function checkI12(client: PoolClient): Promise<InvariantCheckResult> {
  return checkTriggersPresent(client, 'I12', [
    { table: 'ontology_versions', trigger: 'ontology_versions_immutable_definition' },
    { table: 'worker_definitions', trigger: 'worker_definitions_immutable_published' },
  ]);
}

// -------------------------------------------------------------------------------------------
// I6 — ActionRequest transition legality, derived from its own audit trail.
// -------------------------------------------------------------------------------------------

interface TransitionAuditRow {
  workspace_id: string;
  action_request_id: string;
  from_status: string | null;
  to_status: string | null;
}

const VALID_ACTION_REQUEST_EDGES = new Set(
  ACTION_REQUEST_EDGES.map((edge) => `${edge.from}->${edge.to}`),
);

async function checkI6(client: PoolClient): Promise<InvariantCheckResult> {
  const result = await client.query<TransitionAuditRow>(
    `with transitions as (
       select workspace_id,
              resource_id as action_request_id,
              payload ->> 'resultingStatus' as to_status,
              lag(payload ->> 'resultingStatus') over (
                partition by workspace_id, resource_id order by created_at, id
              ) as from_status
       from audit_records
       where resource_type = 'action_request'
         and action like 'action_request.%'
         and resource_id is not null
     )
     select workspace_id, action_request_id, from_status, to_status
     from transitions
     where from_status is not null`,
  );

  const violations = result.rows.filter(
    (row) => !VALID_ACTION_REQUEST_EDGES.has(`${row.from_status}->${row.to_status}`),
  );
  return {
    invariant: 'I6',
    violations: violations.length,
    sample: violations
      .slice(0, SAMPLE_LIMIT)
      .map(
        (row) =>
          `${row.workspace_id}:${row.action_request_id} ${row.from_status}->${row.to_status}`,
      ),
  };
}

// -------------------------------------------------------------------------------------------
// I7 — defense-in-depth mirror of governance/0003_action_requests.sql's own CHECK constraints.
// -------------------------------------------------------------------------------------------

async function checkI7(client: PoolClient): Promise<InvariantCheckResult> {
  const result = await client.query<{ workspace_id: string; id: string }>(
    `select workspace_id, id
     from action_requests
     where (status <> 'proposed' and policy_decision is null)
        or (
          status in ('executing', 'executed', 'verified', 'compensated')
          and (
            policy_decision is null
            or policy_decision = 'deny'
            or (policy_decision = 'require_approval' and approval_decision_id is null)
          )
        )
        or (status in ('approved', 'rejected') and approval_decision_id is null)`,
  );
  return {
    invariant: 'I7',
    violations: result.rows.length,
    sample: result.rows.slice(0, SAMPLE_LIMIT).map((row) => `${row.workspace_id}:${row.id}`),
  };
}

// -------------------------------------------------------------------------------------------
// I11 — a representative governed-transition table (ActionRequest) always has a matching audit
// trail. See the module doc comment's own "exhaustive vs. representative" note.
// -------------------------------------------------------------------------------------------

async function checkI11(client: PoolClient): Promise<InvariantCheckResult> {
  const result = await client.query<{ workspace_id: string; id: string }>(
    `select ar.workspace_id, ar.id
     from action_requests ar
     where ar.status <> 'proposed'
       and not exists (
         select 1 from audit_records au
         where au.workspace_id = ar.workspace_id
           and au.resource_type = 'action_request'
           and au.resource_id = ar.id
       )`,
  );
  return {
    invariant: 'I11',
    violations: result.rows.length,
    sample: result.rows.slice(0, SAMPLE_LIMIT).map((row) => `${row.workspace_id}:${row.id}`),
  };
}

// -------------------------------------------------------------------------------------------
// I13 — child Handle attenuation: on_behalf_of inheritance + expires_at ceiling. Defense in
// depth — governance/0008_capability_handle_inheritance.sql's `capability_handles_inheritance`
// (`before insert`) already rejects both conditions below at write time; see this module's own
// doc comment table for the correction from an earlier draft that missed that later migration.
// -------------------------------------------------------------------------------------------

async function checkI13(client: PoolClient): Promise<InvariantCheckResult> {
  const result = await client.query<{ workspace_id: string; jti: string }>(
    `select child.workspace_id, child.jti
     from capability_handles child
     join capability_handles parent
       on parent.workspace_id = child.workspace_id and parent.jti = child.parent_jti
     where child.parent_jti is not null
       and (
         child.on_behalf_of is distinct from parent.on_behalf_of
         or child.expires_at > parent.expires_at
       )`,
  );
  return {
    invariant: 'I13',
    violations: result.rows.length,
    sample: result.rows.slice(0, SAMPLE_LIMIT).map((row) => `${row.workspace_id}:${row.jti}`),
  };
}

// -------------------------------------------------------------------------------------------
// I14 — an approver held the scope they approved, evaluated at decision time (not "now").
// -------------------------------------------------------------------------------------------

async function checkI14(client: PoolClient): Promise<InvariantCheckResult> {
  const result = await client.query<{ workspace_id: string; id: string }>(
    `select ar.workspace_id, ar.id
     from action_requests ar
     join decisions d on d.workspace_id = ar.workspace_id and d.id = ar.approval_decision_id
     join principals p on p.workspace_id = ar.workspace_id and p.id = d.decided_by
     where ar.status = 'approved'
       and d.decided_at is not null
       and p.role <> 'owner'
       and not exists (
         select 1 from capability_grants cg
         where cg.workspace_id = ar.workspace_id
           and cg.principal_id = p.id
           and cg.created_at <= d.decided_at
           and (cg.revoked_at is null or cg.revoked_at > d.decided_at)
           and (cg.expires_at is null or cg.expires_at > d.decided_at)
           and (
             (
               cg.resource_type = ar.action_kind
               and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope)
             )
             or (
               ar.resource_scope is not null
               and cg.resource_type = 'gatekeeper'
               and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope)
             )
           )
       )`,
  );
  return {
    invariant: 'I14',
    violations: result.rows.length,
    sample: result.rows.slice(0, SAMPLE_LIMIT).map((row) => `${row.workspace_id}:${row.id}`),
  };
}

// -------------------------------------------------------------------------------------------
// I16 — platform meta-ontology objects publish only over the human channel.
// -------------------------------------------------------------------------------------------

/** The five "publish a meta-ontology object" capabilities (packages/shared/src/capabilities.ts) —
 *  every one is already registered `channel: 'human'`; this is a DB-level backstop for that
 *  registry rule, not the only thing enforcing it (see this module's own doc comment table). */
const META_ONTOLOGY_PUBLISH_ACTIONS = [
  'publish_ontology_version',
  'publish_operation',
  'publish_skill',
  'publish_procedure',
  'publish_worker_definition',
];

async function checkI16(client: PoolClient): Promise<InvariantCheckResult> {
  const result = await client.query<{ workspace_id: string; id: string; action: string }>(
    `select workspace_id, id, action
     from audit_records
     where action = any($1::text[])
       and coalesce(payload ->> 'channel', '') <> 'human'`,
    [META_ONTOLOGY_PUBLISH_ACTIONS],
  );
  return {
    invariant: 'I16',
    violations: result.rows.length,
    sample: result.rows
      .slice(0, SAMPLE_LIMIT)
      .map((row) => `${row.workspace_id}:${row.id} (${row.action})`),
  };
}

// -------------------------------------------------------------------------------------------
// Beyond I1–I16 — operational-health checks (see module doc comment).
// -------------------------------------------------------------------------------------------

async function checkOneRunningTurn(client: PoolClient): Promise<InvariantCheckResult> {
  const result = await client.query<{ workspace_id: string; chat_id: string; n: string }>(
    `select workspace_id, chat_id, count(*)::bigint as n
     from activities
     where kind = 'agent_turn' and status = 'running' and chat_id is not null
     group by workspace_id, chat_id
     having count(*) > 1`,
  );
  return {
    invariant: 'ops.one_running_turn',
    violations: result.rows.length,
    sample: result.rows
      .slice(0, SAMPLE_LIMIT)
      .map((row) => `${row.workspace_id}:${row.chat_id} (${row.n} running)`),
  };
}

export const DEFAULT_OUTBOX_STUCK_THRESHOLD_MS = 30 * 60 * 1000;

async function checkOutboxStuck(
  client: PoolClient,
  thresholdMs: number,
): Promise<InvariantCheckResult> {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const result = await client.query<{ workspace_id: string; id: string }>(
    `select workspace_id, id from outbox
     where dispatched_at is null and created_at < $1::timestamptz`,
    [cutoff],
  );
  return {
    invariant: 'ops.outbox_stuck',
    violations: result.rows.length,
    sample: result.rows.slice(0, SAMPLE_LIMIT).map((row) => `${row.workspace_id}:${row.id}`),
  };
}

// -------------------------------------------------------------------------------------------
// Runner
// -------------------------------------------------------------------------------------------

/** Every DB-checkable invariant's own runtime name, in the fixed order `runInvariantChecks`
 *  always returns them — for a caller (a test, the scheduler) that wants the full, stable list
 *  without running anything. */
export const INVARIANT_CHECK_IDS: readonly string[] = [
  'I4',
  'I6',
  'I7',
  'I11',
  'I12',
  'I13',
  'I14',
  'I16',
  'ops.one_running_turn',
  'ops.outbox_stuck',
];

/** Runs every DB-checkable invariant check once, on one connection taken directly off `pool`
 *  (admin-mode, cross-workspace — see module doc comment). Always resolves with exactly
 *  {@link INVARIANT_CHECK_IDS}`.length` results, in that fixed order; a single check throwing
 *  (a real driver/connectivity error, not an expected "found violations" outcome) propagates and
 *  aborts the whole run — the caller (the scheduler tick) is responsible for catching that and
 *  trying again next tick, the same way every other periodic job in `packages/kernel/src/index.ts`
 *  already does. */
export async function runInvariantChecks(
  pool: MinimalPool,
  options: RunInvariantChecksOptions = {},
): Promise<readonly InvariantCheckResult[]> {
  const thresholdMs = options.outboxStuckThresholdMs ?? DEFAULT_OUTBOX_STUCK_THRESHOLD_MS;
  const client = await pool.connect();
  try {
    return [
      await checkI4(client),
      await checkI6(client),
      await checkI7(client),
      await checkI11(client),
      await checkI12(client),
      await checkI13(client),
      await checkI14(client),
      await checkI16(client),
      await checkOneRunningTurn(client),
      await checkOutboxStuck(client, thresholdMs),
    ];
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------------------------------------
// Prometheus text-format rendering — a pure function so the metrics HTTP route
// (`interfaces/http/internal/metrics.ts`) never has to import this module directly (it must not,
// per dependency-cruiser's `kernel-interfaces-must-not-reach-into-substrate-directly` rule); the
// composition root (`packages/kernel/src/index.ts`, allowed to import across every layer) calls
// this after each scheduled tick and hands the resulting string to that route as a plain closure.
// -------------------------------------------------------------------------------------------

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Renders the most recent check results as Prometheus text-format exposition (OpenMetrics text
 *  0.0.4 — no client library needed for a handful of gauges). `lastRunAt` is `undefined` before
 *  the first tick has completed — rendered as a `0` timestamp, the conventional "never" value for
 *  a Prometheus gauge, rather than omitting the metric (a scrape target with a metric that
 *  sometimes does not exist is harder to alert on than one that reads `0`). */
export function renderInvariantMetricsPrometheus(
  results: readonly InvariantCheckResult[],
  lastRunAt: Date | undefined,
): string {
  const lines: string[] = [
    '# HELP nexttime_invariant_violations Current violation count per invariant, from the most recent scheduled check.',
    '# TYPE nexttime_invariant_violations gauge',
  ];
  for (const result of results) {
    lines.push(
      `nexttime_invariant_violations{invariant="${escapePrometheusLabelValue(result.invariant)}"} ${result.violations}`,
    );
  }
  lines.push(
    '# HELP nexttime_invariant_check_last_run_timestamp_seconds Unix timestamp of the most recent invariant-check tick.',
    '# TYPE nexttime_invariant_check_last_run_timestamp_seconds gauge',
    `nexttime_invariant_check_last_run_timestamp_seconds ${lastRunAt ? Math.floor(lastRunAt.getTime() / 1000) : 0}`,
  );
  return `${lines.join('\n')}\n`;
}
