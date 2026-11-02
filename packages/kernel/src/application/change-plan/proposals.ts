import {
  CHANGE_PLAN_DAILY_LIMIT,
  CHANGE_PLAN_LIST_LIMIT,
  type ChangePlanItemIntentWire,
  type ChangePlanSegmentProposalWire,
  type ChangePlanSegmentStatus,
  type ChangePlanSegmentWire,
  type ChangePlanStatus,
  type ChangePlanSummaryWire,
  type ChangePlanWire,
  type ListEnvelope,
  changePlanStatusOf,
  workerDefinitionContentSchemaFor,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { ADVISORY_LOCK_NAMESPACES } from '../../adapters/db/advisory-lock-namespaces.js';
import {
  RedactedTextSubmittedError,
  findCredentialValues,
  redactedPathsIn,
} from '../../governance/redaction/index.js';
import { validateSkillContent } from '../worker/index.js';
import { contentDigest } from './digest.js';

/**
 * application/change-plan/proposals: what a platform administrator's admin agent proposes from its
 * trial workspace for people to apply elsewhere — a ChangePlan and its segments (S11 AA3b-1;
 * docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1–§3.3, §5.4, I-A4–I-A8; the AA3
 * default plan F4 / F5 / F9–F12). Owns migrations/governance/0032_change_plans.sql, whose header
 * has the model: where the rows live, who reads them, the lifecycle and the guards.
 *
 * What this cut does: propose (in the trial workspace, through the agent's Handle only), read back
 * and withdraw — by the agent for its own administrator's plans (F12), and by a platform
 * administrator on the platform plane for any plan. Previewing, applying and rejecting a segment in
 * its target workspace are AA3b-2's (`decided_by`, `applied_segment_id` stay null until then).
 *
 * A proposal writes nothing, and says why, when:
 *  - something in it is almost certainly a credential (`findCredentialValues`: F9 — the error says
 *    where, never the value; what only looks like one is counted when a segment is applied, which
 *    then needs the owner's confirmation);
 *  - it holds the `[redacted]` mark a read put where a suspected credential stood;
 *  - it names one target twice, or one item target twice in a segment, or content that would not
 *    publish (a Skill's rules, a Worker's definition — never its `gates` or `model`, the target
 *    workspace's own), or a source name a shipped pack has;
 *  - its administrator already proposed {@link CHANGE_PLAN_DAILY_LIMIT} plans today (F11, UTC,
 *    across every trial workspace, withdrawn ones included);
 *  - a target cannot take a plan: unknown, disabled, or a trial workspace — all three refused alike
 *    (F10, coordinator 2026-11-02: one code and one text, so the agent cannot learn from the
 *    refusal whether a workspace it was not told about exists, or its state).
 */

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** F10 / §3.2: a segment's target cannot take a plan — unknown, disabled, or a trial workspace
 *  (proposing to one would be self-reference). One code and one message for the three, so the
 *  refusal says nothing about which: `segment` is the index into the call's own `segments`, the
 *  only thing it adds. Mapped to 400 `change_plan_target_unavailable`; nothing was written. */
export class ChangePlanTargetUnavailableError extends Error {
  readonly code = 'change_plan_target_unavailable' as const;
  readonly details: { readonly segment: number };
  constructor(segment: number) {
    super(
      `segments[${segment}].targetWorkspaceId: that workspace cannot take a change plan. Ask your administrator for the id of an active workspace that is not a trial workspace — nothing was proposed.`,
    );
    this.name = 'ChangePlanTargetUnavailableError';
    this.details = { segment };
  }
}

/** F9: a value in the proposal that is almost certainly a credential (`findCredentialValues`).
 *  Mapped to 400 `change_plan_credential` with `details: { suspectedSecretValues,
 *  suspectedSecretPaths }` — where (field names and indices, at most 20), never a fragment of the
 *  value; nothing was written. */
export class ChangePlanCredentialError extends Error {
  readonly code = 'change_plan_credential' as const;
  readonly details: {
    readonly suspectedSecretValues: number;
    readonly suspectedSecretPaths: readonly string[];
  };
  constructor(count: number, paths: readonly string[]) {
    super(
      `the change plan carries ${count} value(s) that are almost certainly credentials, at ${paths.join(', ')} — nothing was proposed. A plan never carries a credential: a gate authenticates with what is configured on it. Leave the value out.`,
    );
    this.name = 'ChangePlanCredentialError';
    this.details = { suspectedSecretValues: count, suspectedSecretPaths: paths };
  }
}

/** F11: the administrator already proposed {@link CHANGE_PLAN_DAILY_LIMIT} plans since 00:00 UTC,
 *  across every trial workspace (withdrawn ones count). Mapped to 429
 *  `change_plan_quota_exceeded` with `details: { dailyLimit, resetsAt }`; nothing was written. */
export class ChangePlanQuotaExceededError extends Error {
  readonly code = 'change_plan_quota_exceeded' as const;
  readonly details: { readonly dailyLimit: number; readonly resetsAt: string };
  constructor(resetsAt: string) {
    super(
      `your administrator has proposed ${CHANGE_PLAN_DAILY_LIMIT} change plans today (UTC), the daily limit — nothing was proposed. The count starts again at ${resetsAt}.`,
    );
    this.name = 'ChangePlanQuotaExceededError';
    this.details = { dailyLimit: CHANGE_PLAN_DAILY_LIMIT, resetsAt };
  }
}

/** A problem with what a proposal holds, by where in it (`segments[1].items[0].skill.name`). */
export interface ChangePlanProposalProblem {
  readonly path: string;
  readonly message: string;
}

/** A proposal that would not apply as written: a target named twice, an item target named twice
 *  in a segment, content that would not publish, a source name a shipped pack has. Mapped to 400
 *  `invalid_params` with `details.problems` (each a path and why — never a value from the content);
 *  nothing was written. */
export class ChangePlanProposalInvalidError extends Error {
  readonly problems: readonly ChangePlanProposalProblem[];
  constructor(problems: readonly ChangePlanProposalProblem[]) {
    super(
      `the change plan cannot be proposed as written — ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}. Nothing was proposed.`,
    );
    this.name = 'ChangePlanProposalInvalidError';
    this.problems = problems;
  }
}

/** No plan by that id the caller may read: on the agent's side, any plan but one its own
 *  administrator proposed in this trial workspace (F12). Mapped to 404 `change_plan_not_found`. */
export class ChangePlanNotFoundError extends Error {
  readonly code = 'change_plan_not_found' as const;
  constructor(planId: string) {
    super(`change plan ${planId} not found`);
    this.name = 'ChangePlanNotFoundError';
  }
}

/** Withdrawing a plan with no segment still proposed. Mapped to 409 `change_plan_not_open`;
 *  nothing was written. */
export class ChangePlanNotOpenError extends Error {
  readonly code = 'change_plan_not_open' as const;
  constructor(planId: string) {
    super(
      `change plan ${planId} has no segment still proposed — each was applied, rejected or withdrawn already, or its workspace is gone; nothing was withdrawn`,
    );
    this.name = 'ChangePlanNotOpenError';
  }
}

// -------------------------------------------------------------------------------------------
// Checking a proposal (pure)
// -------------------------------------------------------------------------------------------

export interface ChangePlanProposalInput {
  readonly title: string;
  readonly description?: string;
  readonly sourceName: string;
  readonly segments: readonly ChangePlanSegmentProposalWire[];
}

/** The target an item changes in a workspace, as a key (two items for one target in a segment are
 *  refused: the second would overwrite what the first proposes). */
function itemTargetKey(item: ChangePlanItemIntentWire): string | null {
  switch (item.kind) {
    case 'skill_version':
      return `skill:${item.skill.name}`;
    case 'worker_definition_version': {
      const name = item.definition.name;
      return typeof name === 'string' ? `worker:${name}` : null;
    }
    case 'ontology_version':
      return `ontology:${item.family}`;
    case 'operation_version':
      return `operation:${item.gateId}\n${item.name}`;
  }
}

/** The fields of a Worker that are its workspace's own: a plan never sets them, as a pack never
 *  ships them (application/packs `WORKSPACE_OWNED_WORKER_FIELDS`; not imported — packs installs
 *  through this module). */
const WORKSPACE_OWNED_WORKER_FIELDS = ['gates', 'model'] as const;

/** One item's content as publishing it would check it, and the item as stored (a Worker's
 *  definition parsed, so normalized like a pack's). */
function checkItem(
  item: ChangePlanItemIntentWire,
  at: string,
  problems: ChangePlanProposalProblem[],
): ChangePlanItemIntentWire {
  if (item.kind === 'skill_version') {
    try {
      validateSkillContent(item.skill);
    } catch (err) {
      problems.push({ path: `${at}.skill`, message: (err as Error).message });
    }
    return item;
  }
  if (item.kind === 'worker_definition_version') {
    const owned = WORKSPACE_OWNED_WORKER_FIELDS.filter((field) => field in item.definition);
    for (const field of owned) {
      problems.push({
        path: `${at}.definition.${field}`,
        message: `a plan never sets a Worker's ${field}: the workspace that applies it keeps its own`,
      });
    }
    if (typeof item.definition.name !== 'string' || item.definition.name.length === 0) {
      problems.push({
        path: `${at}.definition.name`,
        message:
          'a Worker in a plan is named: its name is how each workspace finds its own version',
      });
    }
    const parsed = workerDefinitionContentSchemaFor('worker').safeParse(item.definition);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const where = issue.path.map(String).join('.');
        problems.push({
          path: where === '' ? `${at}.definition` : `${at}.definition.${where}`,
          message: issue.message,
        });
      }
      return item;
    }
    return { kind: item.kind, definition: parsed.data as Record<string, unknown> };
  }
  return item;
}

/**
 * Everything about a proposal that needs no database: credentials and the redaction mark first
 * (their errors name places only), then the plan's shape. Returns the segments as they will be
 * stored. `shippedPackNames`: the packs this deployment ships (the gateway reads the registry), a
 * name the plan's own Skills and Workers must not be derived under.
 */
export function checkChangePlanProposal(
  input: ChangePlanProposalInput,
  shippedPackNames: ReadonlySet<string>,
): readonly ChangePlanSegmentProposalWire[] {
  const credentials = findCredentialValues(input);
  if (credentials.count > 0) {
    throw new ChangePlanCredentialError(credentials.count, credentials.paths);
  }
  // Spelled from the document's name, as a goal plan's are (`RedactedTextSubmittedError` names
  // the document by the first segment of `field`).
  const redacted = redactedPathsIn(input).map((path) => `plan.${path}`);
  if (redacted.length > 0) throw new RedactedTextSubmittedError(redacted[0] as string, redacted);

  const problems: ChangePlanProposalProblem[] = [];
  if (shippedPackNames.has(input.sourceName)) {
    problems.push({
      path: 'sourceName',
      message:
        'is the name of a pack this deployment ships: a plan names its Skills and Workers under a name of its own',
    });
  }
  const targets = new Map<string, number>();
  const segments = input.segments.map((segment, s) => {
    const first = targets.get(segment.targetWorkspaceId);
    if (first !== undefined) {
      problems.push({
        path: `segments[${s}].targetWorkspaceId`,
        message: `names the workspace segments[${first}] does: one segment per workspace`,
      });
    } else {
      targets.set(segment.targetWorkspaceId, s);
    }
    const itemTargets = new Map<string, number>();
    const items = segment.items.map((item, i) => {
      const at = `segments[${s}].items[${i}]`;
      const key = itemTargetKey(item);
      const earlier = key === null ? undefined : itemTargets.get(key);
      if (key !== null && earlier !== undefined) {
        problems.push({
          path: at,
          message: `changes what items[${earlier}] of the same segment changes: one item per target`,
        });
      } else if (key !== null) {
        itemTargets.set(key, i);
      }
      return checkItem(item, at, problems);
    });
    return { targetWorkspaceId: segment.targetWorkspaceId, items };
  });
  if (problems.length > 0) throw new ChangePlanProposalInvalidError(problems);
  return segments;
}

/** `sha256:` of what a segment proposes: its target and its items. */
export function changePlanSegmentDigest(segment: ChangePlanSegmentProposalWire): string {
  return contentDigest({ targetWorkspaceId: segment.targetWorkspaceId, items: segment.items });
}

/** `sha256:` of what a plan proposes: its title, description, source name and each segment's
 *  digest, in order. */
export function changePlanDigest(input: {
  readonly title: string;
  readonly description: string;
  readonly sourceName: string;
  readonly segmentDigests: readonly string[];
}): string {
  return contentDigest({
    title: input.title,
    description: input.description,
    sourceName: input.sourceName,
    segments: input.segmentDigests,
  });
}

/** The next 00:00 UTC after `now`, when F11's count starts again. */
export function changePlanQuotaResetsAt(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

// -------------------------------------------------------------------------------------------
// Propose (the trial workspace, an admin agent's call)
// -------------------------------------------------------------------------------------------

/** Who proposes: the admin agent's session, and its administrator — their Principal in the trial
 *  workspace (the Handle's `obo`) and their platform user. */
export interface ChangePlanProposer {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly sessionId: string;
}

/** F10: the first segment whose target cannot take a plan, or none. One read of each, the same
 *  answer for unknown, disabled and trial (`workspaces` is readable by every transaction, core
 *  0001). */
async function firstUnavailableTarget(
  client: PoolClient,
  segments: readonly ChangePlanSegmentProposalWire[],
): Promise<number | undefined> {
  const ids = segments.map((segment) => segment.targetWorkspaceId);
  const result = await client.query<{ id: string }>(
    `select id from workspaces
      where id = any($1::uuid[]) and status = 'active' and purpose <> 'admin_trial'`,
    [ids],
  );
  const available = new Set(result.rows.map((row) => row.id));
  const index = ids.findIndex((id) => !available.has(id));
  return index === -1 ? undefined : index;
}

/**
 * Proposes a plan in the trial workspace `proposer.workspaceId`, in the caller's transaction (the
 * dispatcher's, which then writes the call's audit row). `segments` are
 * {@link checkChangePlanProposal}'s. The order of the database checks: F11's count under the
 * administrator's lock, then the targets — so a refused proposal never counts, and two at the
 * limit cannot both pass.
 */
export async function proposeChangePlan(
  client: PoolClient,
  proposer: ChangePlanProposer,
  input: ChangePlanProposalInput,
  segments: readonly ChangePlanSegmentProposalWire[],
): Promise<ChangePlanWire> {
  await client.query('select pg_advisory_xact_lock($1, hashtext($2::text))', [
    ADVISORY_LOCK_NAMESPACES.changePlanQuota,
    proposer.userId,
  ]);
  const today = await client.query<{ count: number }>(
    'select change_plans_proposed_today() as count',
  );
  if ((today.rows[0]?.count ?? 0) >= CHANGE_PLAN_DAILY_LIMIT) {
    throw new ChangePlanQuotaExceededError(changePlanQuotaResetsAt(new Date()));
  }
  const unavailable = await firstUnavailableTarget(client, segments);
  if (unavailable !== undefined) throw new ChangePlanTargetUnavailableError(unavailable);

  const user = await client.query<{ display_name: string }>(
    'select display_name from users where id = $1',
    [proposer.userId],
  );
  const displayName = (user.rows[0]?.display_name ?? '').slice(0, 200) || proposer.userId;
  const description = input.description ?? '';
  const segmentDigests = segments.map(changePlanSegmentDigest);
  const digest = changePlanDigest({
    title: input.title,
    description,
    sourceName: input.sourceName,
    segmentDigests,
  });
  const plan = await client.query<{ id: string }>(
    `insert into change_plans
       (workspace_id, proposed_by, proposed_by_user, proposer_display_name, session_id, origin,
        title, description, source_name, content_digest)
     values ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9)
     returning id`,
    [
      proposer.workspaceId,
      proposer.principalId,
      proposer.userId,
      displayName,
      proposer.sessionId,
      input.title,
      description,
      input.sourceName,
      digest,
    ],
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('proposeChangePlan: the insert returned no row');
  for (const [index, segment] of segments.entries()) {
    await client.query(
      `insert into change_plan_segments
         (workspace_id, plan_id, ordinal, authority, target_workspace_id, items, content_digest)
       values ($1, $2, $3, 'workspace', $4, $5::jsonb, $6)`,
      [
        proposer.workspaceId,
        planId,
        index + 1,
        segment.targetWorkspaceId,
        JSON.stringify(segment.items),
        segmentDigests[index],
      ],
    );
  }
  const read = await readChangePlan(client, planId, { workspaceId: proposer.workspaceId });
  if (read === null) throw new Error(`proposeChangePlan: plan ${planId} not readable after insert`);
  return read;
}

// -------------------------------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------------------------------

/** Which plans a read sees. The agent: its administrator's (`proposedByUser`) in its trial
 *  workspace (F12) — RLS already keeps it to the workspace's own. The platform plane: any. */
export interface ChangePlanScope {
  readonly workspaceId?: string;
  readonly proposedByUser?: string;
}

interface PlanRow {
  id: string;
  title: string;
  description: string;
  source_name: string;
  origin: string;
  proposed_by_user: string;
  proposer_display_name: string;
  content_digest: string;
  created_at: Date;
  proposed: number;
  applied: number;
  rejected: number;
  withdrawn: number;
  rolled_back: number;
}

interface SegmentRow {
  id: string;
  ordinal: number;
  authority: string;
  target_workspace_id: string | null;
  items: ChangePlanItemIntentWire[];
  content_digest: string;
  status: ChangePlanSegmentStatus;
  decided_at: Date | null;
  withdrawn_origin: 'human' | 'agent' | null;
  reason: string | null;
  rolled_back_at: Date | null;
}

/** The plan status `changePlanStatusOf` derives, written in SQL over the counts below — for the
 *  list's `status` filter, which must narrow before the limit. The integration tests read each
 *  status back through the wire, which derives it with `changePlanStatusOf` itself. */
const PLAN_STATUS_SQL = `case
    when c.applied > 0 and c.applied = c.total then 'applied'
    when c.applied > 0 then 'partially_applied'
    when c.proposed > 0 then 'proposed'
    else 'closed'
  end`;

const PLAN_SELECT = `
  select p.id, p.title, p.description, p.source_name, p.origin, p.proposed_by_user,
         p.proposer_display_name, p.content_digest, p.created_at,
         c.proposed, c.applied, c.rejected, c.withdrawn, c.rolled_back
    from change_plans p
    cross join lateral (
      select count(s.id)::int as total,
             (count(*) filter (where s.status = 'proposed'))::int as proposed,
             (count(*) filter (where s.status = 'applied'))::int as applied,
             (count(*) filter (where s.status = 'rejected'))::int as rejected,
             (count(*) filter (where s.status = 'withdrawn'))::int as withdrawn,
             (count(*) filter (where s.status = 'rolled_back'))::int as rolled_back
        from change_plan_segments s
       where s.workspace_id = p.workspace_id and s.plan_id = p.id
    ) c`;

function scopeFilter(scope: ChangePlanScope, values: unknown[]): string {
  const where: string[] = [];
  if (scope.workspaceId !== undefined) {
    values.push(scope.workspaceId);
    where.push(`p.workspace_id = $${values.length}`);
  }
  if (scope.proposedByUser !== undefined) {
    values.push(scope.proposedByUser);
    where.push(`p.proposed_by_user = $${values.length}`);
  }
  return where.join(' and ');
}

function statusesOf(row: PlanRow): ChangePlanSegmentStatus[] {
  return [
    ...Array<ChangePlanSegmentStatus>(row.proposed).fill('proposed'),
    ...Array<ChangePlanSegmentStatus>(row.applied).fill('applied'),
    ...Array<ChangePlanSegmentStatus>(row.rejected).fill('rejected'),
    ...Array<ChangePlanSegmentStatus>(row.withdrawn).fill('withdrawn'),
    ...Array<ChangePlanSegmentStatus>(row.rolled_back).fill('rolled_back'),
  ];
}

function summaryOf(row: PlanRow): ChangePlanSummaryWire {
  return {
    id: row.id,
    title: row.title,
    sourceName: row.source_name,
    origin: row.origin as ChangePlanSummaryWire['origin'],
    proposedBy: { userId: row.proposed_by_user, displayName: row.proposer_display_name },
    proposedAt: row.created_at.toISOString(),
    status: changePlanStatusOf(statusesOf(row)),
    segmentCounts: {
      proposed: row.proposed,
      applied: row.applied,
      rejected: row.rejected,
      withdrawn: row.withdrawn,
      rolledBack: row.rolled_back,
    },
  };
}

function segmentOf(row: SegmentRow): ChangePlanSegmentWire {
  return {
    id: row.id,
    ordinal: row.ordinal,
    authority: row.authority as ChangePlanSegmentWire['authority'],
    targetWorkspaceId: row.target_workspace_id,
    items: row.items,
    contentDigest: row.content_digest,
    status: row.status,
    decidedAt: row.decided_at?.toISOString() ?? null,
    withdrawnOrigin: row.withdrawn_origin,
    reason: row.reason,
    rolledBackAt: row.rolled_back_at?.toISOString() ?? null,
  };
}

/** The plans `scope` sees, newest first, at most {@link CHANGE_PLAN_LIST_LIMIT} (`truncated` when
 *  there are more), narrowed to one derived `status` when given. */
export async function listChangePlans(
  client: PoolClient,
  scope: ChangePlanScope,
  status?: ChangePlanStatus,
): Promise<ListEnvelope<ChangePlanSummaryWire>> {
  const values: unknown[] = [];
  const conditions = [scopeFilter(scope, values)].filter((condition) => condition !== '');
  if (status !== undefined) {
    values.push(status);
    conditions.push(`${PLAN_STATUS_SQL} = $${values.length}`);
  }
  values.push(CHANGE_PLAN_LIST_LIMIT + 1);
  const result = await client.query<PlanRow>(
    `${PLAN_SELECT}
     ${conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''}
     order by p.created_at desc, p.id
     limit $${values.length}`,
    values,
  );
  const items = result.rows.slice(0, CHANGE_PLAN_LIST_LIMIT).map(summaryOf);
  return result.rows.length > CHANGE_PLAN_LIST_LIMIT ? { items, truncated: true } : { items };
}

/** One plan with its segments in order, or `null` when `scope` does not see it. */
export async function readChangePlan(
  client: PoolClient,
  planId: string,
  scope: ChangePlanScope,
): Promise<ChangePlanWire | null> {
  const values: unknown[] = [planId];
  const filter = scopeFilter(scope, values);
  const plan = await client.query<PlanRow>(
    `${PLAN_SELECT} where p.id = $1${filter === '' ? '' : ` and ${filter}`}`,
    values,
  );
  const row = plan.rows[0];
  if (row === undefined) return null;
  const segments = await client.query<SegmentRow>(
    `select id, ordinal, authority, target_workspace_id, items, content_digest, status,
            decided_at, withdrawn_origin, reason, rolled_back_at
       from change_plan_segments
      where plan_id = $1
      order by ordinal`,
    [planId],
  );
  return {
    ...summaryOf(row),
    description: row.description,
    contentDigest: row.content_digest,
    segments: segments.rows.map(segmentOf),
  };
}

/** {@link readChangePlan}, or {@link ChangePlanNotFoundError}. */
export async function getChangePlan(
  client: PoolClient,
  planId: string,
  scope: ChangePlanScope,
): Promise<ChangePlanWire> {
  const plan = await readChangePlan(client, planId, scope);
  if (plan === null) throw new ChangePlanNotFoundError(planId);
  return plan;
}

// -------------------------------------------------------------------------------------------
// Withdraw
// -------------------------------------------------------------------------------------------

/**
 * Withdraws every segment of `planId` still proposed, as `userId` — the administrator through their
 * agent (in the trial workspace, `scope` their own plans) or a platform administrator on the
 * platform plane. The guard derives the channel (`withdrawn_origin`) from where the transaction
 * runs and stamps the time. Segments already decided keep their status; with none left proposed,
 * {@link ChangePlanNotOpenError}. Returns the plan as it now reads.
 */
export async function withdrawChangePlan(
  client: PoolClient,
  planId: string,
  scope: ChangePlanScope,
  userId: string,
  reason: string | undefined,
): Promise<ChangePlanWire> {
  await getChangePlan(client, planId, scope);
  // Each open segment under its row lock, so a concurrent apply (AA3b-2) or withdrawal waits and
  // then sees the status this one leaves.
  const open = await client.query<{ id: string }>(
    `select id from change_plan_segments
      where plan_id = $1 and status = 'proposed'
      order by ordinal
      for update`,
    [planId],
  );
  if (open.rows.length === 0) throw new ChangePlanNotOpenError(planId);
  await client.query(
    `update change_plan_segments
        set status = 'withdrawn', withdrawn_by_user = $2, reason = $3
      where id = any($1::uuid[]) and status = 'proposed'`,
    [open.rows.map((row) => row.id), userId, reason ?? null],
  );
  return getChangePlan(client, planId, scope);
}
