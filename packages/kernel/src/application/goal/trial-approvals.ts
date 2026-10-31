import {
  GoalPlanSchema,
  type GoalRunStatus,
  type PlanStep,
  type Role,
  type StepTrialApprovalLapse,
  type StepTrialApprovalState,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { credentialReviewAudit } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import {
  type GoalStepAttempt,
  type StepTrialApprovalCandidate,
  type StepTrialDraft,
  type StepTrialDrafts,
  type TrialDraftRef,
  stepTrialDrafts,
  trialDraftsMatch,
  workerSpecDigest,
} from '../task/index.js';
import {
  type DraftViewer,
  assertMayPublishSkillDraft,
  classifySkillRefs,
  readSkillVersions,
} from '../worker/index.js';
import { getPlanRevision, listStepRuns } from './reads.js';
import { GoalRunNotFoundError, GoalRunStateError, lockGoalRun } from './service.js';
import type { GoalControlActor, GoalRunRow, StepRunRow } from './types.js';

/**
 * application/goal/trial-approvals (S11 GO8b; plan §3.1, I-G8; goal/0013): a person approving one
 * trial of a step whose WorkerSpec names Skills that are only drafts, and what the advancer and
 * the reads make of the approvals.
 *
 * What is approved: the step's trial as a read shows it (`step_skill_draft`'s `trial`) — its
 * WorkerSpec (`specDigest`, the digest a RunConfigSnapshot keeps) and every draft version it
 * mounts, each bound to its content (`draftDigest`). The drafts are the ones the requester's
 * admission would mount (`stepTrialDrafts`, with the requester as the viewer): the person approving
 * says yes to exactly what the step would run.
 *
 * Who: a person who could publish every one of those drafts now (`assertMayPublishSkillDraft`:
 * its proposer, or the workspace owner, under the family rule; the builder floor is the
 * capability's) and who can read the run — the requester or the workspace owner (`get_goal`'s
 * visibility, checked by the handler). The capability is a person's only (`actsForPerson`, human
 * channel, HUMAN_ONLY_CAPABILITY_NAMES) and the guard refuses an approval by anyone but a person.
 *
 * When: while the run is `proposed` (for a step of its proposal) or `paused` (for the live StepRun
 * of the step in the revision in force, before its first attempt) — never while it runs: the
 * advancer would be admitting the step meanwhile. One trial is one StepRun (goal/0013's guard): an
 * approval made on a paused run names its StepRun; one made on a proposal names the StepRun the
 * confirmation creates as that StepRun's first attempt starts with it ({@link nameTrialStepRun}).
 * Approving does not resume a paused run: the requester does (the system never resumes by itself).
 *
 * Errors: {@link GoalRunNotFoundError} (404), {@link GoalRunStateError} (409 — the run or the step
 * is not where an approval applies), {@link StepTrialChangedError} (409 `draft_changed` — the step's
 * WorkerSpec or drafts are not the ones read), `NotProposerError` (403 `not_proposer`) and
 * `CredentialReviewRequiredError` (400) from the publish rule. Nothing is written when one is
 * thrown.
 */

/** 409 `draft_changed`: the trial named is not the step's trial now — its WorkerSpec, or a draft
 *  it mounts (discarded, proposed again, published since, or another one named). Nothing was
 *  written; the caller reloads and looks again. */
export class StepTrialChangedError extends Error {
  readonly code = 'draft_changed' as const;
  constructor(stepKey: string, what: string) {
    super(
      `step "${stepKey}": ${what} — not the trial that was read. Nothing was approved; reload the goal and look again`,
    );
    this.name = 'StepTrialChangedError';
  }
}

export interface StepTrialApprovalRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly goalRunId: string;
  readonly stepKey: string;
  readonly planRevision: number;
  readonly stepRunId: string | null;
  readonly specDigest: string;
  readonly drafts: readonly StepTrialDraft[];
  readonly approvedBy: string;
  readonly approvedAt: Date;
}

interface StepTrialApprovalDbRow {
  workspace_id: string;
  id: string;
  goal_run_id: string;
  step_key: string;
  plan_revision: number;
  step_run_id: string | null;
  spec_digest: string;
  drafts: unknown;
  approved_by: string;
  approved_at: Date;
}

const COLUMNS = `workspace_id, id, goal_run_id, step_key, plan_revision, step_run_id, spec_digest,
  drafts, approved_by, approved_at`;

function draftsOf(value: unknown): readonly StepTrialDraft[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const draft = entry as Record<string, unknown>;
    return typeof draft.skillId === 'string' &&
      typeof draft.version === 'number' &&
      typeof draft.draftDigest === 'string' &&
      typeof draft.name === 'string' &&
      typeof draft.proposedBy === 'string'
      ? [
          {
            skillId: draft.skillId,
            version: draft.version,
            draftDigest: draft.draftDigest,
            name: draft.name,
            proposedBy: draft.proposedBy,
          },
        ]
      : [];
  });
}

function mapRow(row: StepTrialApprovalDbRow): StepTrialApprovalRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    goalRunId: row.goal_run_id,
    stepKey: row.step_key,
    planRevision: row.plan_revision,
    stepRunId: row.step_run_id,
    specDigest: row.spec_digest,
    drafts: draftsOf(row.drafts),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

/** Every approval of a trial of `goalRunId`'s steps, oldest first. */
export async function listStepTrialApprovals(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly StepTrialApprovalRow[]> {
  const result = await client.query<StepTrialApprovalDbRow>(
    `select ${COLUMNS} from goal_step_trial_approvals
      where workspace_id = $1 and goal_run_id = $2
      order by approved_at, id`,
    [workspaceId, goalRunId],
  );
  return result.rows.map(mapRow);
}

/**
 * Whether `approval` is for `step` — the StepRun it names, or, made on a proposal and naming none
 * yet, the StepRun of its key the proposal's confirmation created (`step` `null`: the run is still
 * proposed, and the approval is for the StepRun its confirmation will create). The one rule the
 * advancer, the hints and the reads apply; goal/0013's guard holds the same.
 */
export function trialApprovalAppliesTo(
  approval: StepTrialApprovalRow,
  goal: Pick<GoalRunRow, 'status'>,
  step: Pick<StepRunRow, 'id' | 'stepKey' | 'introducedInRevision'> | null,
): boolean {
  if (step !== null && approval.stepKey !== step.stepKey) return false;
  if (approval.stepRunId !== null) return step !== null && approval.stepRunId === step.id;
  if (approval.planRevision !== 1) return false;
  return step === null ? goal.status === 'proposed' : step.introducedInRevision === 1;
}

/**
 * The approvals among `approvals` (a run's, {@link listStepTrialApprovals}) a first attempt of the
 * step `stepKey` may start with — of its StepRun `step` (`null` while the run is proposed) and the
 * WorkerSpec its plan entry sets (`specDigest`), newest first. `createStepAttemptTask` takes the
 * first whose drafts are the step's trial now; the hints do the same (`precheck.ts`).
 */
export function trialApprovalsFor(
  approvals: readonly StepTrialApprovalRow[],
  goal: Pick<GoalRunRow, 'status'>,
  stepKey: string,
  step: StepRunRow | null,
  specDigest: string | null,
): readonly StepTrialApprovalCandidate[] {
  if (specDigest === null) return [];
  return approvals
    .filter(
      (approval) =>
        approval.stepKey === stepKey &&
        approval.specDigest === specDigest &&
        trialApprovalAppliesTo(approval, goal, step),
    )
    .reverse()
    .map((approval) => ({ approvalId: approval.id, drafts: approval.drafts }));
}

/** {@link trialApprovalsFor} the StepRun `step` of `goal`, read from the database. */
export async function trialApprovalCandidates(
  client: PoolClient,
  workspaceId: string,
  goal: GoalRunRow,
  step: StepRunRow,
  specDigest: string | null,
): Promise<readonly StepTrialApprovalCandidate[]> {
  if (specDigest === null) return [];
  return trialApprovalsFor(
    await listStepTrialApprovals(client, workspaceId, goal.id),
    goal,
    step.stepKey,
    step,
    specDigest,
  );
}

/** Names `stepRunId` on an approval made on a proposal, as that StepRun's first attempt starts with
 *  it (goal/0013's guard: once, the StepRun its confirmation created, before it has started). An
 *  approval that names it already is left as it is. */
export async function nameTrialStepRun(
  client: PoolClient,
  workspaceId: string,
  approvalId: string,
  stepRunId: string,
): Promise<void> {
  // Already this StepRun's (approved on the paused run) or named now; anything else is an approval
  // the attempt must not start with, and the transaction rolls back with it.
  const named = await client.query(
    `update goal_step_trial_approvals set step_run_id = $3
      where workspace_id = $1 and id = $2 and (step_run_id is null or step_run_id = $3)`,
    [workspaceId, approvalId, stepRunId],
  );
  if (named.rowCount !== 1) {
    throw new Error(
      `nameTrialStepRun: approval ${approvalId} is not this StepRun's (${stepRunId}) to start with`,
    );
  }
}

/** The requester as the Skill registry reads for them — the viewer their step's admission uses. */
async function requesterViewer(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
): Promise<DraftViewer | null> {
  const result = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, requesterId],
  );
  const role = result.rows[0]?.role;
  return role ? { principalId: requesterId, role } : null;
}

/** What one trial of `entry` would mount for the requester now: `null` when its WorkerSpec names no
 *  Skill that is only a draft for them. */
async function currentTrial(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftViewer,
  entry: PlanStep,
): Promise<StepTrialDrafts | null> {
  const refs = entry.spec?.skills ?? [];
  if (refs.length === 0) return null;
  const classified = await classifySkillRefs(client, workspaceId, viewer, refs);
  if (classified.drafts.length === 0) return null;
  return stepTrialDrafts(client, workspaceId, viewer, classified.drafts);
}

function planEntry(plan: unknown, stepKey: string): PlanStep | null {
  const parsed = GoalPlanSchema.safeParse(plan);
  return parsed.success ? (parsed.data.steps.find((step) => step.key === stepKey) ?? null) : null;
}

export interface ApproveStepTrialInput {
  readonly goalRunId: string;
  readonly stepKey: string;
  /** The step's WorkerSpec digest, as read. */
  readonly specDigest: string;
  /** The drafts the trial mounts, as read. */
  readonly drafts: readonly TrialDraftRef[];
  readonly credentialsReviewed?: boolean;
  /** The person approving — the authenticated caller, never a param. */
  readonly actor: GoalControlActor;
}

export interface ApprovedStepTrial {
  readonly status: GoalRunStatus;
  /** `false` when a pending approval of the same trial was there already. */
  readonly changed: boolean;
  readonly approvalId: string;
}

/** Approves one trial of a step — see the module comment. In the caller's transaction, GoalRun
 *  locked first. */
export async function approveStepTrial(
  client: PoolClient,
  workspaceId: string,
  input: ApproveStepTrialInput,
): Promise<ApprovedStepTrial> {
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  if (goal.status !== 'proposed' && goal.status !== 'paused') {
    throw new GoalRunStateError(
      `goal run ${goal.id} is ${goal.status}: a step's trial is approved while the run is proposed or paused`,
    );
  }
  const revision = goal.status === 'proposed' ? 1 : goal.currentRevision;
  const stored =
    revision === null ? null : await getPlanRevision(client, workspaceId, goal.id, revision);
  const entry = stored ? planEntry(stored.plan, input.stepKey) : null;
  if (!stored || !entry || revision === null) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: step "${input.stepKey}" is not in the plan ${goal.status === 'proposed' ? 'proposed' : 'in force'}`,
    );
  }
  let step: StepRunRow | null = null;
  if (goal.status === 'paused') {
    step =
      (await listStepRuns(client, workspaceId, goal.id)).find(
        (row) => row.stepKey === input.stepKey && row.supersededInRevision === null,
      ) ?? null;
    if (!step || step.attemptCount > 0 || (step.status !== 'pending' && step.status !== 'ready')) {
      throw new GoalRunStateError(
        `goal run ${goal.id}: step "${input.stepKey}" has ${step ? 'started' : 'no StepRun'} — a trial is approved before its first attempt`,
      );
    }
  }

  const specDigest = workerSpecDigest(entry.spec ?? null);
  if (specDigest === null) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: step "${input.stepKey}" sets no WorkerSpec, so it names no draft Skill to try`,
    );
  }
  if (specDigest !== input.specDigest) {
    throw new StepTrialChangedError(input.stepKey, 'its WorkerSpec is another one now');
  }
  const viewer = await requesterViewer(client, workspaceId, goal.onBehalfOf);
  const trial = viewer ? await currentTrial(client, workspaceId, viewer, entry) : null;
  if (trial === null) {
    throw new StepTrialChangedError(input.stepKey, 'it names no Skill that is only a draft now');
  }
  if (trial.kind === 'none') {
    throw new GoalRunStateError(
      `goal run ${goal.id}: step "${input.stepKey}" has no single trial to approve — ${trial.detail}`,
    );
  }
  if (!trialDraftsMatch(input.drafts, trial.drafts)) {
    throw new StepTrialChangedError(
      input.stepKey,
      'the draft Skills it mounts are not the ones named (one was changed, discarded or published since, or another is named)',
    );
  }

  // Whoever approves could publish every draft now — the rule `publish_skill` applies.
  const rows = await readSkillVersions(
    client,
    workspaceId,
    trial.drafts.map((draft) => ({ skillId: draft.skillId, version: draft.version })),
  );
  let suspectedSecretValues = 0;
  for (const row of rows) {
    suspectedSecretValues += await assertMayPublishSkillDraft(
      client,
      workspaceId,
      'approve_step_trial',
      { ...input.actor, ...(input.credentialsReviewed ? { credentialsReviewed: true } : {}) },
      row,
    );
  }

  for (const approval of await listStepTrialApprovals(client, workspaceId, goal.id)) {
    if (
      approval.stepKey === input.stepKey &&
      approval.specDigest === specDigest &&
      trialApprovalAppliesTo(approval, goal, step) &&
      trialDraftsMatch(approval.drafts, trial.drafts)
    ) {
      return { status: goal.status, changed: false, approvalId: approval.id };
    }
  }

  const inserted = await client.query<{ id: string }>(
    `insert into goal_step_trial_approvals
       (workspace_id, goal_run_id, step_key, plan_revision, step_run_id, spec_digest, drafts,
        approved_by)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     returning id`,
    [
      workspaceId,
      goal.id,
      input.stepKey,
      revision,
      step?.id ?? null,
      specDigest,
      JSON.stringify(trial.drafts),
      input.actor.principalId,
    ],
  );
  const approvalId = inserted.rows[0]?.id;
  if (!approvalId) throw new Error('approveStepTrial: INSERT ... RETURNING produced no row');
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.actor.principalId,
    action: 'step_trial.approve',
    resourceType: 'goal_run',
    resourceId: goal.id,
    payload: {
      approvalId,
      stepKey: input.stepKey,
      planRevision: revision,
      stepRunId: step?.id ?? null,
      specDigest,
      drafts: trial.drafts.map((draft) => ({
        skillId: draft.skillId,
        version: draft.version,
        draftDigest: draft.draftDigest,
      })),
      authority: goal.onBehalfOf === input.actor.principalId ? 'requester' : 'owner',
      ...credentialReviewAudit(suspectedSecretValues),
    },
  });
  return { status: goal.status, changed: true, approvalId };
}

/** An approval as a reader gets it — see `StepTrialApprovalWireSchema`. */
export interface StepTrialApprovalView extends StepTrialApprovalRow {
  readonly state: StepTrialApprovalState;
  readonly lapsedBecause: StepTrialApprovalLapse | null;
  readonly usedByTaskId: string | null;
}

const ENDED_RUN_STATUSES: ReadonlySet<GoalRunStatus> = new Set([
  'completed',
  'failed',
  'cancelling',
  'cancelled',
]);

/**
 * Every approval of `goal`'s steps with where it stands (oldest first): `used` by the first attempt
 * that ran with it; else `lapsed` — the run ended, the StepRun it is for is replaced or started
 * without it, the step's WorkerSpec is another one, or its drafts are not the step's trial now — or
 * `pending`. `attempts`: the run's step attempts (`listGoalRunStepAttempts`); `plan`: the plan in
 * force (revision 1 while proposed).
 */
export async function readStepTrialApprovals(
  client: PoolClient,
  workspaceId: string,
  goal: GoalRunRow,
  plan: unknown,
  steps: readonly StepRunRow[],
  attempts: readonly GoalStepAttempt[],
): Promise<readonly StepTrialApprovalView[]> {
  const approvals = await listStepTrialApprovals(client, workspaceId, goal.id);
  if (approvals.length === 0) return [];
  const viewer = await requesterViewer(client, workspaceId, goal.onBehalfOf);
  const trials = new Map<string, StepTrialDrafts | null>();
  const views: StepTrialApprovalView[] = [];
  for (const approval of approvals) {
    const used = attempts.find(
      (attempt) => attempt.attempt === 1 && attempt.trialApprovalId === approval.id,
    );
    if (used) {
      views.push({ ...approval, state: 'used', lapsedBecause: null, usedByTaskId: used.taskId });
      continue;
    }
    const lapsed = (because: StepTrialApprovalLapse): StepTrialApprovalView => ({
      ...approval,
      state: 'lapsed',
      lapsedBecause: because,
      usedByTaskId: null,
    });
    if (ENDED_RUN_STATUSES.has(goal.status)) {
      views.push(lapsed('run_ended'));
      continue;
    }
    const live = steps.find(
      (row) => row.stepKey === approval.stepKey && row.supersededInRevision === null,
    );
    const step = live ?? null;
    const entry = planEntry(plan, approval.stepKey);
    if (
      !entry ||
      (goal.status !== 'proposed' && !step) ||
      !trialApprovalAppliesTo(approval, goal, step) ||
      workerSpecDigest(entry.spec ?? null) !== approval.specDigest
    ) {
      views.push(lapsed('step_changed'));
      continue;
    }
    let trial = trials.get(approval.stepKey);
    if (trial === undefined) {
      trial = viewer ? await currentTrial(client, workspaceId, viewer, entry) : null;
      trials.set(approval.stepKey, trial);
    }
    // A draft changed is what made it lapse even once the step started without it (with a later
    // approval, say): a reader is told the first reason, not one that came after (UX P3-5 on #855).
    if (trial?.kind !== 'drafts' || !trialDraftsMatch(approval.drafts, trial.drafts)) {
      views.push(lapsed('draft_changed'));
      continue;
    }
    if (step !== null && step.attemptCount > 0) {
      views.push(lapsed('step_changed'));
      continue;
    }
    views.push({ ...approval, state: 'pending', lapsedBecause: null, usedByTaskId: null });
  }
  return views;
}
