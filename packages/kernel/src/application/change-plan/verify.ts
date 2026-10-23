import { randomUUID } from 'node:crypto';
import {
  CHANGE_VERIFICATION_COOLDOWN_SECONDS,
  type ChangeItemKind,
  ChangeItemKindSchema,
  type ChangeItemState,
  ChangeItemStateSchema,
  type ChangeVerificationTrigger,
  ChangeVerificationTriggerSchema,
  type PackRequirementState,
  PackRequirementStateSchema,
  type PrincipalKind,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { writeAudit } from '../../substrate/audit/index.js';
import type { ChangeSource } from './engine.js';
import { ChangeSegmentRolledBackError } from './errors.js';
import { inspectChangeSegment } from './inspect.js';
import {
  type ChangePrincipalRef,
  ChangeSegmentNotFoundError,
  type ChangeSegmentRecord,
  loadChangeSegment,
} from './segments.js';

/**
 * application/change-plan/verify: verifying an applied segment (S11 P1-E; plan §3.1 the segment
 * status machine `applied → verified / verification_failed`; S10 plan §3.3 I-P3). A run answers two
 * questions and records the answer on the segment:
 *
 *   1. Is what the segment wrote still in effect? Each item's target now (`inspect.ts`: the version
 *      it published is still the head — `in_effect` — or was `replaced` / is `not_installed`).
 *   2. Are the systems its source needs in place? The caller says which those are and how each
 *      stands (`CheckSourceRequirements`: for a pack, its version's `requires.connectors`, where
 *      each stands in the workspace, and the health of its gates — the gateway probes them through
 *      the gate's own health endpoint, the path `get_gatekeeper` already uses). A requirement is met
 *      when it is `connected` with at least one gate `ok`.
 *
 * It passes when every item is in effect, every requirement is met, and the source version is
 * still in this deployment (without it the systems it needs are unknown, so the run cannot pass).
 * The segment's status follows the latest run — `verified` or `verification_failed` — and the run is
 * stored in `change_segments.verification` (its `verified_at` stamped by the database) with one
 * `change_segment.verify` audit row naming who ran it and how (`trigger`: `manual` — a person asked;
 * `system` — the platform ran it right after an install, as the person who installed).
 *
 * Only the latest segment of a source that is not rolled back is verified: an earlier one is
 * superseded (409 `change_segment_superseded`, naming the later one), a rolled back one is final
 * (409 `change_segment_rolled_back`). A run probes gates, so a segment is not verified again within
 * `CHANGE_VERIFICATION_COOLDOWN_SECONDS` of its last run (429 `change_verification_cooldown`) —
 * checked before anything is probed, under the segment's row lock, so two clicks cannot both probe.
 */

export interface RequirementGateCheck {
  readonly id: string;
  readonly name: string;
  readonly health: 'ok' | 'unreachable' | 'unauthorized';
}

/** One system the source needs, as the caller found it. */
export interface RequirementCheck {
  readonly connector: string;
  readonly state: PackRequirementState;
  readonly gates: readonly RequirementGateCheck[];
}

export interface SourceRequirements {
  /** The source version is in this deployment. */
  readonly sourceFound: boolean;
  readonly requirements: readonly RequirementCheck[];
}

/** Says which systems `source` needs and how each stands now — probing gates as it goes. */
export type CheckSourceRequirements = (source: ChangeSource) => Promise<SourceRequirements>;

const RequirementGateCheckSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    health: z.enum(['ok', 'unreachable', 'unauthorized']),
  })
  .strict();

const StoredVerificationSchema = z
  .object({
    /** Each run's own, so a run with the same result as the last still records (and stamps
     *  `verified_at`) as a run of its own. */
    runId: z.string(),
    trigger: ChangeVerificationTriggerSchema,
    verifiedBy: z.string(),
    passed: z.boolean(),
    sourceFound: z.boolean(),
    items: z.array(
      z
        .object({
          ordinal: z.number().int().positive(),
          kind: ChangeItemKindSchema,
          state: ChangeItemStateSchema,
        })
        .strict(),
    ),
    requirements: z.array(
      z
        .object({
          connector: z.string(),
          state: PackRequirementStateSchema,
          gates: z.array(RequirementGateCheckSchema),
          met: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

type StoredVerification = z.infer<typeof StoredVerificationSchema>;

/** A segment's latest run, as recorded. */
export interface ChangeVerification {
  readonly trigger: ChangeVerificationTrigger;
  readonly verifiedBy: ChangePrincipalRef;
  readonly verifiedAt: Date;
  readonly passed: boolean;
  readonly sourceFound: boolean;
  readonly items: readonly {
    readonly ordinal: number;
    readonly kind: ChangeItemKind;
    readonly state: ChangeItemState;
  }[];
  readonly requirements: readonly (RequirementCheck & { readonly met: boolean })[];
}

/** 409 `change_segment_superseded`: a later segment of the same source, not rolled back, is the
 *  one in effect — verify that one. Nothing was probed or written. */
export class ChangeSegmentSupersededError extends Error {
  readonly code = 'change_segment_superseded' as const;
  readonly details: { readonly supersededBy: string };
  constructor(segmentId: string, supersededBy: string) {
    super(
      `change segment ${segmentId} is superseded by segment ${supersededBy} of the same source — verify that one; nothing was checked`,
    );
    this.name = 'ChangeSegmentSupersededError';
    this.details = { supersededBy };
  }
}

/** 429 `change_verification_cooldown`: the segment was verified less than
 *  `CHANGE_VERIFICATION_COOLDOWN_SECONDS` ago. Nothing was probed or written. */
export class ChangeVerificationCooldownError extends Error {
  readonly code = 'change_verification_cooldown' as const;
  readonly details: { readonly retryAfterSeconds: number };
  constructor(segmentId: string, retryAfterSeconds: number) {
    super(
      `change segment ${segmentId} was verified less than ${CHANGE_VERIFICATION_COOLDOWN_SECONDS} seconds ago — try again in ${retryAfterSeconds} s; nothing was checked`,
    );
    this.name = 'ChangeVerificationCooldownError';
    this.details = { retryAfterSeconds };
  }
}

/** The latest segment of `source` that is not rolled back and was applied after `segment`, or
 *  `null`. */
async function findSupersedingSegment(
  client: PoolClient,
  workspaceId: string,
  segment: ChangeSegmentRecord,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `select later.id
       from change_segments later
       join change_segments this on this.workspace_id = later.workspace_id and this.id = $2
      where later.workspace_id = $1
        and later.source_kind = this.source_kind and later.source_name = this.source_name
        and later.status <> 'rolled_back'
        and (later.applied_at, later.id) > (this.applied_at, this.id)
      order by later.applied_at desc, later.id desc
      limit 1`,
    [workspaceId, segment.id],
  );
  return result.rows[0]?.id ?? null;
}

/** Seconds left of the segment's cooldown, by the database's clock; 0 when none. */
async function cooldownLeft(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
): Promise<number> {
  const result = await client.query<{ left: number | null }>(
    `select ceil(extract(epoch from (verified_at + make_interval(secs => $3) - now())))::int
              as left
       from change_segments
      where workspace_id = $1 and id = $2 and verified_at is not null`,
    [workspaceId, segmentId, CHANGE_VERIFICATION_COOLDOWN_SECONDS],
  );
  return Math.max(result.rows[0]?.left ?? 0, 0);
}

export interface VerifyChangeSegmentInput {
  readonly segmentId: string;
  /** Who the run is: the person asking, or (`system`) the person who just installed. */
  readonly verifiedBy: string;
  readonly trigger: ChangeVerificationTrigger;
  readonly checkRequirements: CheckSourceRequirements;
}

export interface VerifiedChangeSegment {
  readonly segment: ChangeSegmentRecord;
  readonly verification: ChangeVerification;
}

/** Runs and records one verification of a segment, in the caller's transaction (see this module's
 *  comment). `ChangeSegmentNotFoundError` when `workspaceId` has no such segment. */
export async function verifyChangeSegment(
  client: PoolClient,
  workspaceId: string,
  input: VerifyChangeSegmentInput,
): Promise<VerifiedChangeSegment> {
  // Locked first: two runs of one segment take turns, and the second sees the first's time.
  const segment = await loadChangeSegment(client, workspaceId, input.segmentId, {
    forUpdate: true,
  });
  if (!segment) throw new ChangeSegmentNotFoundError(input.segmentId);
  if (segment.status === 'rolled_back') throw new ChangeSegmentRolledBackError(segment.id);
  const supersededBy = await findSupersedingSegment(client, workspaceId, segment);
  if (supersededBy) throw new ChangeSegmentSupersededError(segment.id, supersededBy);
  const left = await cooldownLeft(client, workspaceId, segment.id);
  if (left > 0) throw new ChangeVerificationCooldownError(segment.id, left);

  const inspected = await inspectChangeSegment(client, workspaceId, segment.id);
  const items = inspected.items.map((item) => ({
    ordinal: item.record.ordinal,
    kind: item.record.kind,
    state: item.state,
  }));
  const found = await input.checkRequirements(segment.source);
  const requirements = found.requirements.map((requirement) => ({
    connector: requirement.connector,
    state: requirement.state,
    gates: requirement.gates.map((gate) => ({ id: gate.id, name: gate.name, health: gate.health })),
    met:
      requirement.state === 'connected' && requirement.gates.some((gate) => gate.health === 'ok'),
  }));
  const passed =
    found.sourceFound &&
    items.every((item) => item.state === 'in_effect') &&
    requirements.every((requirement) => requirement.met);
  const stored: StoredVerification = {
    runId: randomUUID(),
    trigger: input.trigger,
    verifiedBy: input.verifiedBy,
    passed,
    sourceFound: found.sourceFound,
    items,
    requirements,
  };
  await client.query(
    `update change_segments set status = $3, verification = $4::jsonb
      where workspace_id = $1 and id = $2`,
    [workspaceId, segment.id, passed ? 'verified' : 'verification_failed', JSON.stringify(stored)],
  );
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.verifiedBy,
    action: 'change_segment.verify',
    resourceType: 'change_segment',
    resourceId: segment.id,
    payload: {
      trigger: input.trigger,
      planId: segment.planId,
      source: segment.source,
      statusBefore: segment.status,
      passed,
      sourceFound: found.sourceFound,
      items,
      requirements,
    },
  });

  const after = await loadChangeSegment(client, workspaceId, segment.id);
  const verification = await loadChangeVerification(client, workspaceId, segment.id);
  if (!after || !verification) throw new Error('change-plan: the verified segment is gone');
  return { segment: after, verification };
}

/** A segment's latest run, or `null` when it was never verified. */
export async function loadChangeVerification(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
): Promise<ChangeVerification | null> {
  const result = await client.query<{
    verification: unknown;
    verified_at: Date | null;
    verified_kind: PrincipalKind | null;
    verified_name: string | null;
  }>(
    `select s.verification, s.verified_at, p.kind as verified_kind,
            p.display_name as verified_name
       from change_segments s
       left join principals p
         on p.workspace_id = s.workspace_id and p.id::text = s.verification ->> 'verifiedBy'
      where s.workspace_id = $1 and s.id = $2`,
    [workspaceId, segmentId],
  );
  const row = result.rows[0];
  if (!row || row.verification === null || row.verified_at === null) return null;
  const stored = StoredVerificationSchema.parse(row.verification);
  if (row.verified_kind === null) {
    throw new Error(
      `change-plan: segment ${segmentId}'s verification names principal ${stored.verifiedBy}, not in this workspace`,
    );
  }
  return {
    trigger: stored.trigger,
    verifiedBy: { id: stored.verifiedBy, kind: row.verified_kind, displayName: row.verified_name },
    verifiedAt: row.verified_at,
    passed: stored.passed,
    sourceFound: stored.sourceFound,
    items: stored.items,
    requirements: stored.requirements,
  };
}
