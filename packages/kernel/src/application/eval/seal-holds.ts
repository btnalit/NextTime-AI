import type { EvalSealHoldPlaces, EvalSealHoldStatus, EvalSealHoldWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { redactedForAudit } from '../../governance/redaction/index.js';
import { EvalSealHoldNotFoundError, EvalSealHoldReleasedError } from './errors.js';
import { EVALUATION_PRINCIPAL_DISPLAY_NAME } from './principal.js';

/**
 * The evaluation seal's pauses as people read and release them (S10 E3-2c, legacy 514;
 * migrations/worker/0011). `application/eval-seal` opens a pause when the refusals of what agents
 * acting for one Principal were about to receive or start with reach its threshold, and checks it
 * on every path those agents work through; this is the human side — the list
 * (`list_eval_seal_holds`, the owner and auditors) and the release (`release_eval_seal_hold`, the
 * owner, with a reason). A release is the one way a pause ends: the system never lifts one.
 */

/** How many pauses the list returns, newest first. */
const LIST_LIMIT = 50;

interface HoldRow {
  id: string;
  principal_id: string;
  principal_kind: EvalSealHoldWire['principal']['kind'];
  principal_display_name: string | null;
  status: EvalSealHoldStatus;
  hits: number;
  places: Partial<EvalSealHoldPlaces>;
  opened_at: Date;
  released_at: Date | null;
  released_by: string | null;
  release_reason: string | null;
}

const HOLD_SELECT = `select h.id, h.principal_id, p.kind as principal_kind,
       p.display_name as principal_display_name, h.status, h.hits, h.places, h.opened_at,
       h.released_at, h.released_by, h.release_reason
  from eval_seal_holds h
  join principals p on p.workspace_id = h.workspace_id and p.id = h.principal_id`;

function holdWire(row: HoldRow): EvalSealHoldWire {
  const evaluation =
    row.principal_kind === 'service' &&
    row.principal_display_name === EVALUATION_PRINCIPAL_DISPLAY_NAME;
  return {
    id: row.id,
    principal: {
      id: row.principal_id,
      kind: row.principal_kind,
      // The evaluation Principal's name is internal: the console names it by `evaluation`.
      displayName: evaluation ? null : row.principal_display_name,
      evaluation,
    },
    status: row.status,
    hits: row.hits,
    places: {
      capabilityResult: row.places.capabilityResult ?? 0,
      capabilityError: row.places.capabilityError ?? 0,
      workerStart: row.places.workerStart ?? 0,
    },
    openedAt: row.opened_at.toISOString(),
    releasedAt: row.released_at?.toISOString() ?? null,
    releasedBy: row.released_by,
    releaseReason: row.release_reason,
  };
}

/** The workspace's pauses, newest first (the last `LIST_LIMIT`), optionally of one status. */
export async function listSealHolds(
  client: PoolClient,
  workspaceId: string,
  filter: { readonly status?: EvalSealHoldStatus },
): Promise<EvalSealHoldWire[]> {
  const result = await client.query<HoldRow>(
    `${HOLD_SELECT}
      where h.workspace_id = $1 and ($2::text is null or h.status = $2)
      order by h.opened_at desc, h.id
      limit ${LIST_LIMIT}`,
    [workspaceId, filter.status ?? null],
  );
  return result.rows.map(holdWire);
}

/**
 * Releases an active pause: who released it, when and why (the reason as the audit record keeps
 * it, credential-looking values masked). The paused Principal's agents run again at once, and the
 * seal counts its refusals afresh from now (eval-seal `countSealHit`). Refused with nothing
 * written: no such pause (404), or one released already (409).
 */
export async function releaseSealHold(
  client: PoolClient,
  workspaceId: string,
  actor: { readonly principalId: string },
  target: { readonly holdId: string; readonly reason: string },
): Promise<EvalSealHoldWire> {
  const reason = String(redactedForAudit({ reason: target.reason }).reason);
  const updated = await client.query(
    `update eval_seal_holds
        set status = 'released', released_at = now(), released_by = $3, release_reason = $4
      where workspace_id = $1 and id = $2 and status = 'active'
      returning id`,
    [workspaceId, target.holdId, actor.principalId, reason],
  );
  const found = await client.query<HoldRow>(
    `${HOLD_SELECT} where h.workspace_id = $1 and h.id = $2`,
    [workspaceId, target.holdId],
  );
  const row = found.rows[0];
  if (!row) throw new EvalSealHoldNotFoundError(target.holdId);
  if (updated.rows.length === 0) throw new EvalSealHoldReleasedError(target.holdId);
  return holdWire(row);
}
