import {
  EVAL_SEAL_HIT_PLACE_VALUES,
  EVAL_SEAL_HOLD_PLACE_KEY,
  EVAL_SEAL_HOLD_THRESHOLD,
  EVAL_SEAL_HOLD_WINDOW_HOURS,
  type EvalSealHitPlace,
  type EvalSealHoldPlaces,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { EvaluationProbeHoldError, type ProbeHoldSubject, type SealPlace } from './errors.js';

/**
 * The seal's pauses (S10 E3-2c, legacy 514; migrations/worker/0011). Every refusal tells whoever
 * provoked it one bit — this text carries something held out, that one does not — so an agent that
 * keeps varying a candidate text can read a held-out case back. The seal counts the refusals an
 * agent could have provoked, per Principal they acted for, and at `EVAL_SEAL_HOLD_THRESHOLD` within
 * `EVAL_SEAL_HOLD_WINDOW_HOURS` (since the Principal's last release) pauses every agent acting for
 * it: each path an agent works through checks the pause first (`assertNoSealHold`) and refuses
 * with `EvaluationProbeHoldError`, whichever path and whichever refusals opened it. Only the
 * workspace owner releases one (`release_eval_seal_hold`, application/eval); the count then starts
 * afresh. A refusal because of a pause is audited (`recordProbeHoldRefusal`) and not counted.
 */

/** The audit action of a pause the seal opened. */
export const SEAL_HOLD_OPENED_ACTION = 'evaluation.seal_hold_opened';
/** The audit action of something refused because its Principal is paused. */
export const SEAL_HOLD_REFUSED_ACTION = 'evaluation.seal_hold_refused';

const COUNTED_PLACES: ReadonlySet<string> = new Set<string>(EVAL_SEAL_HIT_PLACE_VALUES);

/** Whether a refusal at `where` counts towards a pause: only where an agent could have put the
 *  content itself (a call's result or error, a Worker's Task input) — not a person's chat message
 *  or what the entry agent starts a Turn with, which only people write. */
export function isCountedSealPlace(where: SealPlace): where is EvalSealHitPlace {
  return COUNTED_PLACES.has(where);
}

export interface OpenedSealHold {
  readonly id: string;
  readonly hits: number;
  readonly places: Readonly<EvalSealHoldPlaces>;
}

/**
 * Counts one refusal at `place` for `principalId` in the caller's transaction, and opens the
 * Principal's pause when the count reaches the threshold — with its audit row. Returns the pause it
 * opened, or null. Serialized per Principal (a transaction-scoped advisory lock taken before the
 * hit is written), so refusals at the same time are counted one after the other and the one that
 * reaches the threshold sees the others.
 */
export async function countSealHit(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  place: EvalSealHitPlace,
): Promise<OpenedSealHold | null> {
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `eval-seal-hits:${workspaceId}:${principalId}`,
  ]);
  await client.query(
    'insert into eval_seal_hits (workspace_id, principal_id, place) values ($1, $2, $3)',
    [workspaceId, principalId, place],
  );
  const counted = await client.query<{ place: EvalSealHitPlace; n: number }>(
    `select place, count(*)::int as n
       from eval_seal_hits
      where workspace_id = $1 and principal_id = $2
        and at > greatest(
          now() - make_interval(hours => $3),
          coalesce(
            (select max(released_at) from eval_seal_holds
              where workspace_id = $1 and principal_id = $2),
            '-infinity'::timestamptz))
      group by place`,
    [workspaceId, principalId, EVAL_SEAL_HOLD_WINDOW_HOURS],
  );
  const places: EvalSealHoldPlaces = { capabilityResult: 0, capabilityError: 0, workerStart: 0 };
  let hits = 0;
  for (const row of counted.rows) {
    places[EVAL_SEAL_HOLD_PLACE_KEY[row.place]] = row.n;
    hits += row.n;
  }
  if (hits < EVAL_SEAL_HOLD_THRESHOLD) return null;
  const opened = await client.query<{ id: string }>(
    `insert into eval_seal_holds (workspace_id, principal_id, hits, places)
     values ($1, $2, $3, $4::jsonb)
     on conflict (workspace_id, principal_id) where status = 'active' do nothing
     returning id`,
    [workspaceId, principalId, hits, JSON.stringify(places)],
  );
  const id = opened.rows[0]?.id;
  if (id === undefined) return null;
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: principalId,
    action: SEAL_HOLD_OPENED_ACTION,
    resourceType: 'eval_seal_hold',
    resourceId: id,
    payload: {
      onBehalfOf: principalId,
      hits,
      places,
      threshold: EVAL_SEAL_HOLD_THRESHOLD,
      windowHours: EVAL_SEAL_HOLD_WINDOW_HOURS,
      outcome: 'paused',
    },
  });
  return { id, hits, places };
}

/** Whether `principalId` has an active pause. */
export async function hasActiveSealHold(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const result = await client.query(
    `select 1 from eval_seal_holds
      where workspace_id = $1 and principal_id = $2 and status = 'active'`,
    [workspaceId, principalId],
  );
  return result.rows.length > 0;
}

/** Refuses with `EvaluationProbeHoldError` when `principalId` has an active pause. */
export async function assertNoSealHold(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  subject: ProbeHoldSubject = 'agents',
): Promise<void> {
  if (await hasActiveSealHold(client, workspaceId, principalId)) {
    throw new EvaluationProbeHoldError(principalId, subject);
  }
}

/** The way an agent works that a pause refused. */
export type ProbeHoldPath =
  /** A Handle's capability call, or a person's call that would start the paused agents' work. */
  | 'capability_call'
  /** A Worker start (an `invoke_worker`, a goal step, a retry, an evaluation trial). */
  | 'worker_start'
  /** An entry agent's Turn. */
  | 'entry_start';

export interface ProbeHoldRefusal {
  readonly workspaceId: string;
  /** Who the refused call, start or Turn was for. */
  readonly principalId: string;
  /** The paused Principal, when not `principalId` (a person starting an evaluation). */
  readonly heldPrincipalId?: string;
  readonly channel?: string;
  readonly path: ProbeHoldPath;
  readonly capability?: string;
  readonly taskId?: string;
}

/**
 * The audit row of a refusal because of a pause (`SEAL_HOLD_REFUSED_ACTION`), in the caller's
 * transaction — for a refusal that commits what it decided instead (a goal step's attempt: the
 * goal pauses). Says what was refused and for whom, not the call's params. Not counted towards a
 * pause.
 */
export async function writeProbeHoldRefusal(
  client: PoolClient,
  refusal: ProbeHoldRefusal,
): Promise<void> {
  await writeAudit(client, {
    workspaceId: refusal.workspaceId,
    actorPrincipalId: refusal.principalId,
    action: SEAL_HOLD_REFUSED_ACTION,
    resourceType: refusal.taskId !== undefined ? 'task' : undefined,
    resourceId: refusal.taskId,
    payload: {
      ...(refusal.channel !== undefined ? { channel: refusal.channel } : {}),
      onBehalfOf: refusal.principalId,
      ...(refusal.heldPrincipalId !== undefined
        ? { heldPrincipalId: refusal.heldPrincipalId }
        : {}),
      path: refusal.path,
      ...(refusal.capability !== undefined ? { capability: refusal.capability } : {}),
      outcome: 'refused',
    },
  });
}

/**
 * {@link writeProbeHoldRefusal} in its own transaction — the refused one is rolled back. Best
 * effort: a failure to write it is logged and never replaces the refusal.
 */
export async function recordProbeHoldRefusal(
  pool: PoolLike,
  refusal: ProbeHoldRefusal,
): Promise<void> {
  try {
    await withWorkspace(
      pool,
      { workspaceId: refusal.workspaceId, principalId: refusal.principalId },
      (client) => writeProbeHoldRefusal(client, refusal),
    );
  } catch (auditErr) {
    const detail = auditErr instanceof Error ? auditErr.message : String(auditErr);
    console.error(
      `[kernel] audit of a refusal under an evaluation seal pause failed (path=${refusal.path}): ${detail}`.replace(
        /\n|\r/g,
        '',
      ),
    );
  }
}
