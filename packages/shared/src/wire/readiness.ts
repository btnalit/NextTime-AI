import { z } from 'zod';
import { ObjectWireSchema } from './graph.js';

/**
 * wire/readiness: `execution_readiness`'s result shape (S8 W1-C, docs/development-tasks.md §5e
 * decision F6; ui-audit-2026-09-23 J1/O1 — "让入口 agent 能执行" needs gate-enablement + grant +
 * published-Worker to all show up in one place). Mirrors
 * `application/gateway/execution-readiness-handler.ts`'s own projection.
 */

/** A machine code naming one concrete reason readiness (or one Worker's own delegability) is
 *  blocked — the console maps each code to a page/action, never rendered as text by the kernel
 *  itself (ui-audit S14 "内部术语外泄" — page routes are a console concern). `gateId` is present
 *  for `no_grant` (the specific Gatekeeper this principal has no active grant for);
 *  `workerDefinitionId` is present when the item is scoped to one WorkerDefinition rather than the
 *  whole workspace. Both absent for a workspace-wide gap (`no_enabled_gate`/`no_published_worker`
 *  with nothing more specific to point at). */
export const ExecutionReadinessMissingCodeSchema = z.enum([
  'no_enabled_gate',
  'no_grant',
  'no_published_worker',
  /** Published Workers exist but none declares any gate — delegating reaches no system. */
  'no_worker_gate',
  /** The member's own AgentProfile excludes it (a granted gate, or a published Worker) — fixed on
   *  我的智能体, not by an owner (console redesign M2). */
  'excluded_by_profile',
  /** A granted gate the workspace AgentPolicy's gate cap leaves out — fixed by an owner on 模型与配额. */
  'excluded_by_policy',
  /** Production incident 2026-09-26: every published Operation on this gate is disabled by the
   *  platform's connector deny list (平台 · 集成) — fixed by a platform admin, not by an owner or the
   *  member. */
  'disabled_by_platform',
]);
export type ExecutionReadinessMissingCode = z.infer<typeof ExecutionReadinessMissingCodeSchema>;

/** Console redesign M2 / M3: how this principal's entry agent can reach a gate or one Operation. */
export const GateReachabilityStatusSchema = z.enum(['direct', 'via_worker', 'unreachable']);
export type GateReachabilityStatus = z.infer<typeof GateReachabilityStatusSchema>;

/** The first unmet condition, in the order a person fixes them. */
export const GateUnreachableReasonSchema = z.enum([
  'no_published_operation',
  /** Production incident 2026-09-26: every published Operation on this gate is disabled by the
   *  platform's connector deny list (平台 · 集成) — see `ExecutionReadinessMissingCodeSchema`'s own
   *  identical value above. */
  'disabled_by_platform',
  'not_granted',
  'excluded_by_policy',
  'excluded_by_profile',
  'no_worker',
]);
export type GateUnreachableReason = z.infer<typeof GateUnreachableReasonSchema>;

export const ReachabilityWireSchema = z
  .object({
    status: GateReachabilityStatusSchema,
    reason: GateUnreachableReasonSchema.optional(),
  })
  .strict();
export type ReachabilityWire = z.infer<typeof ReachabilityWireSchema>;

/** `find_operations`' result item: the Operation Object plus, for an entry-agent caller, how that
 *  agent can reach it (absent for a Worker caller, whose own Handle is what counts there). */
export const FindOperationItemWireSchema = ObjectWireSchema.extend({
  reachability: ReachabilityWireSchema.optional(),
}).strict();
export type FindOperationItemWire = z.infer<typeof FindOperationItemWireSchema>;

export const ExecutionReadinessMissingWireSchema = z
  .object({
    code: ExecutionReadinessMissingCodeSchema,
    gateId: z.string().optional(),
    workerDefinitionId: z.string().optional(),
  })
  .strict();
export type ExecutionReadinessMissingWire = z.infer<typeof ExecutionReadinessMissingWireSchema>;

export const ExecutionReadinessGateWireSchema = z
  .object({
    gateId: z.string(),
    name: z.string(),
    /** Whether `principalId` holds an active CapabilityGrant covering this Gatekeeper
     *  (`resourceType:'gatekeeper'`, this id or a wildcard) — the same predicate
     *  `listActiveGrantResourceScopes` computes for the real entry-Handle gate scope
     *  (`application/host-bridge/agent-host-runtime.ts`'s `ensureEntryHandle`). */
    granted: z.boolean(),
    publishedOperationCount: z.number().int().nonnegative(),
    // Console redesign M2 (docs/console-redesign-plan-2026-09-25.md §3): per-gate reachability for
    // this principal's entry agent — `application/gateway/capability-reachability.ts`, the same
    // computation `find_operations` annotates its results with.
    observeOperationCount: z.number().int().nonnegative(),
    executeOperationCount: z.number().int().nonnegative(),
    /** Published Operation names on this gate the platform's connector deny list currently refuses
     *  (production incident 2026-09-26) — a subset of the counts above; non-empty even when `status`
     *  is not `disabled_by_platform` (some, not all, published Operations disabled). */
    disabledOperations: z.array(z.string()),
    /** Granted, but the workspace AgentPolicy's gate cap leaves it out. */
    excludedByPolicy: z.boolean(),
    /** Granted, but the member's own AgentProfile excludes it. */
    excludedByProfile: z.boolean(),
    /** In the entry Handle's gate scope — its observe Operations are callable directly. */
    inEntryScope: z.boolean(),
    /** Delegable Workers (not excluded by the profile) whose child scope carries this gate. */
    workerDefinitionIds: z.array(z.string()),
    /** `direct`: the entry agent calls it itself; `via_worker`: only by delegating;
     *  `unreachable`: `reason` names the first missing condition. */
    status: GateReachabilityStatusSchema,
    reason: GateUnreachableReasonSchema.optional(),
  })
  .strict();
export type ExecutionReadinessGateWire = z.infer<typeof ExecutionReadinessGateWireSchema>;

export const ExecutionReadinessWorkerWireSchema = z
  .object({
    definitionId: z.string(),
    version: z.number().int().positive(),
    name: z.string().optional(),
    /** Whether `invoke_worker` against this exact (definitionId, version) would currently succeed
     *  for `principalId`'s entry agent — computed by the same dry run `find_workers` already uses
     *  (`application/task/handle-mint.ts`'s `computeChildHandleScope`), never a separate guess. */
    delegable: z.boolean(),
    /** How many Gatekeepers the child Handle `invoke_worker` would mint right now actually carries
     *  (`computeChildHandleScope`'s own `resources.gatekeeper`) — declared gates this principal
     *  holds no grant for are dropped there, not refused, for a Worker with no execute-class need.
     *  `ready` requires some Worker that is both `delegable` and reaches at least one gate. */
    reachableGateCount: z.number().int().nonnegative(),
    /** Populated only when `delegable` is `false` — which of this WorkerDefinition's own declared
     *  gates block it (a set difference against the principal's granted gates, presentational —
     *  the accept/reject decision itself is `computeChildHandleScope`'s, not re-derived here). */
    blockedBy: z.array(ExecutionReadinessMissingWireSchema),
  })
  .strict();
export type ExecutionReadinessWorkerWire = z.infer<typeof ExecutionReadinessWorkerWireSchema>;

export const ExecutionReadinessWireSchema = z
  .object({
    principalId: z.string(),
    ready: z.boolean(),
    missing: z.array(ExecutionReadinessMissingWireSchema),
    gates: z.array(ExecutionReadinessGateWireSchema),
    workers: z.array(ExecutionReadinessWorkerWireSchema),
  })
  .strict();
export type ExecutionReadinessWire = z.infer<typeof ExecutionReadinessWireSchema>;

/**
 * wire/readiness (continued): `resolve_refs`'s result item (S8 W1-C, leftover 48 "无批量 Object
 * 读"; ui-audit S10/J8) — mirrors `application/gateway/resolve-refs-handler.ts`'s own projection.
 * Kept in this file alongside `ExecutionReadinessWire` rather than `wire/graph.ts`: both are S8
 * W1-C read-model additions with no pre-existing home, and `resolve_refs` spans more than the
 * graph group's own resources (Principal, WorkerDefinition, ActionRequest too).
 *
 * S8 W1-A6 (audit S10, kit `RefChip`'s own follow-up): `operation`/`task`/`chat`/`workspace` added
 * alongside the original five kinds — see `resolve-refs-handler.ts`'s own module doc comment for
 * each new kind's visibility rule.
 */
export const ResolvedRefKindSchema = z.enum([
  'object',
  'principal',
  'gatekeeper',
  'workerDefinition',
  'actionRequest',
  'operation',
  'task',
  'chat',
  'workspace',
]);
export type ResolvedRefKind = z.infer<typeof ResolvedRefKindSchema>;

export const ResolvedRefWireSchema = z
  .object({
    id: z.string(),
    kind: ResolvedRefKindSchema,
    name: z.string().optional(),
    typeName: z.string().optional(),
  })
  .strict();
export type ResolvedRefWire = z.infer<typeof ResolvedRefWireSchema>;

/**
 * wire/readiness (continued): `graph_freshness`'s result shape (S8 W4-A, ui-audit-2026-09-23 G1;
 * STATUS leftover 70/62; convergence-plan-2026-09-25.md §6 W4 "G1 图谱新鲜度告警"). One row per
 * `sources` owned by a `kind:'service'` Principal (a collector, an external runtime) in this
 * workspace — the same population `substrate/audit/invariant-checks.ts`'s `ops.collector_silent`
 * scans, but workspace-scoped (RLS) rather than the cross-workspace admin sweep that check runs on
 * a timer. A human-channel read model closes the gap the 09-18 incident named: the graph itself
 * only ever coloured a *Fact* "陈旧 aging" days after its Source actually went silent (`lib/
 * graph-freshness.ts`) — nothing said "this workspace's whole graph stopped updating", so neither
 * the entry agent nor a person watching the console noticed for five days (STATUS leftover 70).
 */
export const GraphFreshnessSourceWireSchema = z
  .object({
    sourceId: z.string(),
    kind: z.string(),
    name: z.string().nullable(),
    /** `null` — registered but never observed (never counts as silent; see `silent` below). */
    lastObservedAt: z.string().nullable(),
    /** `lastObservedAt` is non-null and older than `staleThresholdMs` — mirrors
     *  `ops.collector_silent`'s own predicate exactly (a Source that never observed once is not
     *  silent, it never established a cadence to fall silent from). */
    silent: z.boolean(),
  })
  .strict();
export type GraphFreshnessSourceWire = z.infer<typeof GraphFreshnessSourceWireSchema>;

export const GraphFreshnessWireSchema = z
  .object({
    /** `ops.collector_silent`'s own default (`DEFAULT_COLLECTOR_SILENCE_THRESHOLD_MS`, 2 hours) —
     *  echoed back rather than hard-coded a second time on the client. */
    staleThresholdMs: z.number().int().positive(),
    /** The newest `lastObservedAt` across every Source below — `null` when the workspace has no
     *  service-owned Source that has ever observed anything (nothing to be stale relative to). */
    workspaceLastObservedAt: z.string().nullable(),
    sources: z.array(GraphFreshnessSourceWireSchema),
  })
  .strict();
export type GraphFreshnessWire = z.infer<typeof GraphFreshnessWireSchema>;
