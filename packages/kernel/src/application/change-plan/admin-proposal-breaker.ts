import type { PoolClient } from 'pg';

/**
 * application/change-plan/admin-proposal-breaker (S11 AA5a-2; docs/goal-orchestration-and-admin-
 * agent-plan-2026-10-16.md §5.7 "刷屏、反复提同一个被拒的提议"; the AA5 plan's F6(a), legacy 595): the
 * second half of keeping an admin agent from flooding the people it proposes to. F11 caps how many
 * proposals an administrator makes a day; this stops their admin agent proposing again to a target
 * workspace whose owners keep saying no.
 *
 * **The rule.** When a target workspace has rejected {@link AdminProposalRejectionBreaker.limit} of
 * one administrator's workspace segments within the last
 * {@link AdminProposalRejectionBreaker.windowDays} days, a proposal of that administrator's with a
 * segment for that target is refused (429 `admin_proposal_target_rejected_repeatedly`) and nothing
 * is written. It opens again by itself once enough of those rejections have left the window — the
 * oldest, when there are exactly `limit` — and nobody resets it by hand (F6(b) not done).
 *
 * **What counts.** A workspace segment its target rejected (`status = 'rejected'`, `decided_at`),
 * of a proposal the same platform user made, through any of their trial workspaces (governance 0038
 * `admin_proposal_rejections_since`). Not a withdrawal, not an applied segment rolled back later, not
 * a platform segment (a platform administrator decides that, not the target). Counted from the
 * database under F11's per-administrator lock, never from memory.
 *
 * **Who reads why.** The agent's refusal names the segment, the limit, the window and when it may
 * propose there again — never what the owners wrote. The refusal is audited in its own transaction
 * (the call's rolled back) with the rejected segments it counted, so a platform administrator sees
 * which ones, and reads their reasons on the platform's admin proposals page.
 *
 * **Configuration** (coordinator 2026-11-02): `ADMIN_PROPOSAL_REJECTION_LIMIT` (default 3) and
 * `ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS` (default 7), whole numbers of at least 1. Read on each
 * proposal; parsed once at start (`index.ts`) so a mistyped value stops the kernel instead of being
 * ignored.
 */

export const ADMIN_PROPOSAL_REJECTION_LIMIT_VAR = 'ADMIN_PROPOSAL_REJECTION_LIMIT';
export const ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR = 'ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS';
export const DEFAULT_ADMIN_PROPOSAL_REJECTION_LIMIT = 3;
export const DEFAULT_ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many rejections, within how many days, close a target to an administrator's agent. */
export interface AdminProposalRejectionBreaker {
  readonly limit: number;
  readonly windowDays: number;
}

function wholeAtLeastOne(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${name}="${raw}" is not a whole number of at least 1 — unset it to use the default ${fallback}`,
    );
  }
  return parsed;
}

/** The breaker as configured; throws on a value that is not a whole number of at least 1. */
export function adminProposalRejectionBreaker(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdminProposalRejectionBreaker {
  return {
    limit: wholeAtLeastOne(
      ADMIN_PROPOSAL_REJECTION_LIMIT_VAR,
      env[ADMIN_PROPOSAL_REJECTION_LIMIT_VAR],
      DEFAULT_ADMIN_PROPOSAL_REJECTION_LIMIT,
    ),
    windowDays: wholeAtLeastOne(
      ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR,
      env[ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR],
      DEFAULT_ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS,
    ),
  };
}

/** One of the administrator's workspace segments a target rejected. */
export interface AdminProposalTargetRejection {
  readonly targetWorkspaceId: string;
  readonly proposalId: string;
  readonly segmentId: string;
  readonly decidedAt: Date;
}

/** A target closed to the administrator's agent: the rejections within the window that close it,
 *  oldest first, and when it opens again. */
export interface AdminProposalTrippedTarget {
  readonly targetWorkspaceId: string;
  readonly rejections: readonly AdminProposalTargetRejection[];
  readonly reopensAt: Date;
}

/** The start of the window that ends at `now`. */
export function rejectionWindowStart(breaker: AdminProposalRejectionBreaker, now: Date): Date {
  return new Date(now.getTime() - breaker.windowDays * DAY_MS);
}

/**
 * Whether `targetWorkspaceId` is closed at `now`, from the administrator's rejections (any order,
 * any target): closed while at least `limit` of its rejections fall within the window (decided
 * after its start). It opens when the `limit`-th newest of them leaves the window — with exactly
 * `limit`, the oldest — so `reopensAt`, that rejection's time plus the window, is the first moment
 * it is open again.
 */
export function trippedTargetOf(
  targetWorkspaceId: string,
  rejections: readonly AdminProposalTargetRejection[],
  breaker: AdminProposalRejectionBreaker,
  now: Date,
): AdminProposalTrippedTarget | undefined {
  const since = rejectionWindowStart(breaker, now).getTime();
  const inWindow = rejections
    .filter(
      // No upper bound: a rejection the database stamped a moment after the kernel's clock still
      // counts.
      (rejection) =>
        rejection.targetWorkspaceId === targetWorkspaceId && rejection.decidedAt.getTime() > since,
    )
    .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
  if (inWindow.length < breaker.limit) return undefined;
  const opener = inWindow[inWindow.length - breaker.limit];
  if (opener === undefined) return undefined;
  return {
    targetWorkspaceId,
    rejections: inWindow,
    reopensAt: new Date(opener.decidedAt.getTime() + breaker.windowDays * DAY_MS),
  };
}

/** The administrator's (the transaction's own platform user's) rejected workspace segments decided
 *  after `since` (governance 0038). */
export async function readAdminProposalRejectionsSince(
  client: PoolClient,
  since: Date,
): Promise<AdminProposalTargetRejection[]> {
  const result = await client.query<{
    target_workspace_id: string;
    proposal_id: string;
    segment_id: string;
    decided_at: Date;
  }>(
    'select target_workspace_id, proposal_id, segment_id, decided_at from admin_proposal_rejections_since($1)',
    [since],
  );
  return result.rows.map((row) => ({
    targetWorkspaceId: row.target_workspace_id,
    proposalId: row.proposal_id,
    segmentId: row.segment_id,
    decidedAt: row.decided_at,
  }));
}

/**
 * F6: a segment's target has rejected the administrator's proposals too often lately. Mapped to 429
 * `admin_proposal_target_rejected_repeatedly` with `details: { segment, rejectionLimit, windowDays,
 * reopensAt }` — what the agent may know: which segment, the rule, and when it may propose there
 * again; never what the owners wrote, nor which proposals. Nothing was written. `tripped` is for
 * the refusal's audit row only (application/gateway/dispatch.ts), never sent.
 */
export class AdminProposalTargetRejectedRepeatedlyError extends Error {
  readonly code = 'admin_proposal_target_rejected_repeatedly' as const;
  readonly details: {
    readonly segment: number;
    readonly rejectionLimit: number;
    readonly windowDays: number;
    readonly reopensAt: string;
  };
  readonly tripped: AdminProposalTrippedTarget;
  constructor(
    segment: number,
    breaker: AdminProposalRejectionBreaker,
    tripped: AdminProposalTrippedTarget,
  ) {
    const reopensAt = tripped.reopensAt.toISOString();
    super(
      `segments[${segment}].targetWorkspaceId: that workspace has rejected ${breaker.limit} or more of your administrator's proposals in the last ${breaker.windowDays} day(s) — nothing was proposed. Do not propose to it again before ${reopensAt}; the other segments may go in a proposal of their own. Ask your administrator if you need to know why.`,
    );
    this.name = 'AdminProposalTargetRejectedRepeatedlyError';
    this.details = {
      segment,
      rejectionLimit: breaker.limit,
      windowDays: breaker.windowDays,
      reopensAt,
    };
    this.tripped = tripped;
  }
}

/**
 * Refuses ({@link AdminProposalTargetRejectedRepeatedlyError}) the first of `targetWorkspaceIds`
 * (a proposal's workspace segments, in order) closed at `now`. The caller holds F11's
 * per-administrator lock and runs in the trial workspace's transaction as the administrator's
 * Principal, whose user the read answers for.
 */
export async function assertTargetsNotRejectedRepeatedly(
  client: PoolClient,
  targetWorkspaceIds: readonly string[],
  breaker: AdminProposalRejectionBreaker = adminProposalRejectionBreaker(),
  now: Date = new Date(),
): Promise<void> {
  if (targetWorkspaceIds.length === 0) return;
  const rejections = await readAdminProposalRejectionsSince(
    client,
    rejectionWindowStart(breaker, now),
  );
  if (rejections.length < breaker.limit) return;
  for (const [index, targetWorkspaceId] of targetWorkspaceIds.entries()) {
    const tripped = trippedTargetOf(targetWorkspaceId, rejections, breaker, now);
    if (tripped !== undefined) {
      throw new AdminProposalTargetRejectedRepeatedlyError(index, breaker, tripped);
    }
  }
}
