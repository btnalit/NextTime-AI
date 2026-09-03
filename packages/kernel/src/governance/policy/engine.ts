import type { BlastRadius, CapabilityScope, PolicyDecision } from '@nexttime/shared';

/**
 * governance/policy/engine: the Policy evaluator (design doc §5.1.4 Policy, §5.4 I8/I14, §5.8;
 * docs/development-tasks.md S2.2). Pure, no IO — every input the engine needs (the workspace's
 * `policies` row, the invoked Operation's own declared `auto_approvable`/`blast_radius`, and the
 * requester's Handle scope) is resolved by the caller (governance/approval/service.ts) and passed
 * in explicitly, so this module never queries a table or the graph itself — per this task's own
 * scope note, S2 passes Operation metadata in explicitly rather than depending on S2.6's
 * platform-meta-ontology lookup, and per §7.10 governance may not depend on application/adapters
 * either way.
 *
 * `evaluate()` decides one of three outcomes (`packages/shared` `PolicyDecision` —
 * `POLICY_DECISION_VALUES`, this module's own gap-fill export, see that file's doc comment):
 *
 *   - `deny`   — the requester's Handle scope does not cover the target Gatekeeper (see
 *                `hasGatekeeperScope`'s doc comment for the exact coverage rule this module
 *                implements — the "document the exact rule you implement" instruction in this
 *                task's brief). Checked first: an out-of-scope caller is refused before any
 *                blast-radius/auto-approval reasoning even runs.
 *   - `allow`  — I8's double signal: the Operation itself declares `auto_approvable` **and** the
 *                effective workspace rule enables auto-approval for this `action_kind`. `high`
 *                blast radius can never resolve to `allow`, regardless of either signal (§5.4 I8
 *                "工作区不能关闭"; the DB CHECK on `policies.auto_approve` — migrations/governance/
 *                0002_policy.sql — already forbids the *workspace rule* from doing this; this
 *                function is the second, independent place that refuses it, per this task's own
 *                acceptance note that both layers must reject it).
 *   - `require_approval` — every other case: `medium`/`high`/an unclassified action_kind (no
 *                workspace policy row and blast radius is not `low`), or a `low`-blast-radius
 *                Operation that does not itself declare `auto_approvable`, or one a workspace row
 *                has explicitly opted back out of (`auto_approve: false`).
 *
 * `requesterCanApprove` (§5.4 I8, §5.8 "blast_radius=high 默认 requester_can_approve=false，工作区
 * 可覆盖"): defaults to `true` for every blast radius except `high` (defaults to `false`), and is
 * overridden by `workspacePolicy.requesterCanApprove` when the workspace has set one explicitly
 * (`policies.requester_can_approve`, nullable — `undefined`/`null` means "use the default").
 */

// -------------------------------------------------------------------------------------------
// Inputs
// -------------------------------------------------------------------------------------------

/**
 * The workspace's `policies` row for one `action_kind` (migrations/governance/0002_policy.sql),
 * or `undefined` when no row exists ("no row for a given action_kind means use the compiled-in
 * default" — that migration's own header comment).
 */
export interface WorkspacePolicyInput {
  /** `policies.auto_approve` (signal 2 of I8's double signal). */
  readonly autoApprove: boolean;
  /** `policies.requester_can_approve` — `undefined`/`null` means "use the blast-radius default". */
  readonly requesterCanApprove?: boolean | null;
}

export interface PolicyEvaluationInput {
  /** The Gatekeeper this ActionRequest targets — `action_requests.gatekeeper_id` (an `objects`
   *  row, no dedicated `gatekeepers` table per S2.1's own deviation note). */
  readonly gatekeeperId: string;
  /** `action_requests.blast_radius` — a snapshot of the invoked Operation's own declared value at
   *  request time (never re-read from the graph later). */
  readonly blastRadius: BlastRadius;
  /** The invoked Operation's own declared `auto_approvable` (signal 1 of I8's double signal;
   *  `OperationSchema.auto_approvable`, packages/shared/src/action-description.ts). An unclassified
   *  action_kind (§5.1.4/I17 "未在接口清单中分类的操作一律 require_approval") is represented by the
   *  caller passing `false` here — this module does not distinguish "declared not auto-approvable"
   *  from "no declaration exists at all", both must resolve to `require_approval` identically. */
  readonly operationAutoApprovable: boolean;
  /** The workspace's policy row for this `action_kind`, or `undefined` if none exists. */
  readonly workspacePolicy?: WorkspacePolicyInput | undefined;
  /** The requesting Handle's scope (design doc §5.1.4 CapabilityHandle; `@nexttime/shared`
   *  `CapabilityScope` — `{capabilities, resources}`). Used only for the coverage/`deny` check
   *  below; `evaluate()` does not otherwise care which capabilities the scope lists (that is
   *  `authorize.ts`'s job, already run before `request_action`'s handler is ever reached). */
  readonly requesterScope: CapabilityScope;
}

export interface PolicyEvaluationResult {
  readonly decision: PolicyDecision;
  /** A short, stable, machine-checkable reason code (this module's own vocabulary — see
   *  `PolicyEvaluationReason` below) — never a free-text sentence, so callers/tests can assert on
   *  it without string-matching. */
  readonly reason: PolicyEvaluationReason;
  readonly requesterCanApprove: boolean;
}

/**
 * The resource-scope key `evaluate()` looks up in `requesterScope.resources` to decide Gatekeeper
 * coverage (`handle-token.ts`'s own doc comment: "the exact key vocabulary is defined by each
 * capability's own semantics, not fixed here"). `request_action`'s semantics — defined here, since
 * this is the one module whose job is to interpret that capability's scope — are: a Worker Handle
 * covers a Gatekeeper `gk` iff `gk` appears in `resources['gatekeeper']`. A single, capability-wide
 * key (not one key per Gatekeeper) keeps the convention simple until S2.4/S2.7 build the real
 * attenuation path that populates it when a Worker Handle is issued; those tasks should populate
 * `resources.gatekeeper` with exactly the Gatekeeper ids a Worker's decayed Handle may act on
 * (design doc §5.1.4 "子 Handle 是自身 Handle 的衰减").
 */
export const GATEKEEPER_RESOURCE_SCOPE_KEY = 'gatekeeper';

export type PolicyEvaluationReason =
  | 'requester_scope_does_not_cover_gatekeeper'
  | 'auto_approved_by_operation_and_workspace_policy'
  | 'auto_approved_by_operation_and_low_blast_radius_default'
  | 'blast_radius_high_requires_approval'
  | 'operation_not_auto_approvable'
  | 'workspace_policy_disables_auto_approve'
  | 'no_workspace_policy_and_not_low_blast_radius';

/** The exact coverage rule this module implements (see `GATEKEEPER_RESOURCE_SCOPE_KEY`'s doc
 *  comment for the resource-key convention it reads). */
function hasGatekeeperScope(scope: CapabilityScope, gatekeeperId: string): boolean {
  return (scope.resources[GATEKEEPER_RESOURCE_SCOPE_KEY] ?? []).includes(gatekeeperId);
}

/**
 * Whether the workspace's effective auto-approval rule is "on" for this action_kind (I8 signal 2):
 * an explicit `policies` row wins outright; absent one, the compiled-in default is "on" only for
 * `low` blast radius (S2.3's own default-policy-table note: "low 自动批准、medium / high 与未分类要人
 * 批").
 */
function effectiveWorkspaceAutoApprove(
  blastRadius: BlastRadius,
  workspacePolicy: WorkspacePolicyInput | undefined,
): boolean {
  if (workspacePolicy) return workspacePolicy.autoApprove;
  return blastRadius === 'low';
}

/** I8/§5.8: `requester_can_approve` defaults `false` for `high`, `true` otherwise; a workspace row
 *  overrides the default in either direction when explicitly set (non-null/non-undefined). */
function resolveRequesterCanApprove(
  blastRadius: BlastRadius,
  workspacePolicy: WorkspacePolicyInput | undefined,
): boolean {
  const override = workspacePolicy?.requesterCanApprove;
  if (override !== undefined && override !== null) return override;
  return blastRadius !== 'high';
}

/**
 * Evaluates one ActionRequest's Policy decision. Never throws — every input already carries
 * enough information to reach a decision (an "unclassified" or unknown Operation is represented by
 * `operationAutoApprovable: false`, not by an error).
 */
export function evaluate(input: PolicyEvaluationInput): PolicyEvaluationResult {
  const requesterCanApprove = resolveRequesterCanApprove(input.blastRadius, input.workspacePolicy);

  if (!hasGatekeeperScope(input.requesterScope, input.gatekeeperId)) {
    return {
      decision: 'deny',
      reason: 'requester_scope_does_not_cover_gatekeeper',
      requesterCanApprove,
    };
  }

  // I8/§5.4 "工作区不能关闭": high can never resolve to `allow`, independent of either signal —
  // checked before the double-signal test below so a `high` Operation that happens to declare
  // `auto_approvable: true` with an (illegally-written, but defense-in-depth-checked) workspace
  // override still cannot slip through.
  if (input.blastRadius === 'high') {
    return {
      decision: 'require_approval',
      reason: 'blast_radius_high_requires_approval',
      requesterCanApprove,
    };
  }

  if (!input.operationAutoApprovable) {
    return {
      decision: 'require_approval',
      reason: 'operation_not_auto_approvable',
      requesterCanApprove,
    };
  }

  const workspaceAutoApprove = effectiveWorkspaceAutoApprove(
    input.blastRadius,
    input.workspacePolicy,
  );
  if (!workspaceAutoApprove) {
    const reason: PolicyEvaluationReason = input.workspacePolicy
      ? 'workspace_policy_disables_auto_approve'
      : 'no_workspace_policy_and_not_low_blast_radius';
    return { decision: 'require_approval', reason, requesterCanApprove };
  }

  const reason: PolicyEvaluationReason = input.workspacePolicy
    ? 'auto_approved_by_operation_and_workspace_policy'
    : 'auto_approved_by_operation_and_low_blast_radius_default';
  return { decision: 'allow', reason, requesterCanApprove };
}

// -------------------------------------------------------------------------------------------
// Workspace-policy write-side guard (S2.2 acceptance: "试图为 high 开自动批准被拒" applies to
// `set_policy`/`set_auto_approved_action_kind` — reject with 400/409 *before* touching the DB, not
// only relying on the migration's own CHECK). Pure — governance/approval/service.ts and the
// gateway handlers call this before writing a `policies` row.
// -------------------------------------------------------------------------------------------

export class HighBlastRadiusAutoApproveError extends Error {
  constructor(actionKind: string) {
    super(
      `policy for action_kind "${actionKind}" cannot set auto_approve=true at blast_radius="high" (I8)`,
    );
    this.name = 'HighBlastRadiusAutoApproveError';
  }
}

/**
 * Throws {@link HighBlastRadiusAutoApproveError} if `blastRadius === 'high'` and `autoApprove` is
 * `true` — the write-side half of I8's "工作区不能关闭"; the DB CHECK on `policies.auto_approve`
 * (migrations/governance/0002_policy.sql) is the second, independent enforcement of the same rule,
 * not a substitute for this one (this function runs first, so a rejected write never reaches SQL).
 */
export function assertPolicyWriteAllowed(input: {
  readonly actionKind: string;
  readonly blastRadius: BlastRadius | undefined;
  readonly autoApprove: boolean;
}): void {
  if (input.blastRadius === 'high' && input.autoApprove) {
    throw new HighBlastRadiusAutoApproveError(input.actionKind);
  }
}
