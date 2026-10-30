import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';
import type { SealPlace } from './errors.js';

/** The audit action of a seal refusal. */
export const EVALUATION_WITHHELD_ACTION = 'evaluation.content_withheld';

export interface EvaluationWithheldRecord {
  readonly workspaceId: string;
  /** Who the refused call or start acted for (a Handle's `on_behalf_of`, the person chatting). */
  readonly principalId: string;
  /** The channel of the refused call or message; none for a Worker start, which the kernel makes
   *  (for an `invoke_worker` call, a goal step, or a retry). */
  readonly channel?: string;
  readonly where: SealPlace;
  /** The capability whose call was refused, when one was. */
  readonly capability?: string;
  /** The Task whose Worker was not started (`worker_start`). */
  readonly taskId?: string;
  /** For a capability result: whether what the call wrote to the platform was rolled back with
   *  it (false: the call took effect). */
  readonly rolledBack?: boolean;
}

/**
 * Writes the audit row of a seal refusal (S10 E3-1c), in its own transaction — the refused call's
 * own is rolled back. It says where the content was stopped and for whom, and nothing about what
 * it was: no run of text, no case or suite, not whether a canary or a holdout case matched, and
 * none of the call's params (they may be the very content). Best effort: a failure to write it is
 * logged, without any of the call's content, and never replaces the refusal.
 */
export async function recordEvaluationWithheld(
  pool: PoolLike,
  record: EvaluationWithheldRecord,
): Promise<void> {
  try {
    await withWorkspace(
      pool,
      { workspaceId: record.workspaceId, principalId: record.principalId },
      (client) =>
        writeAudit(client, {
          workspaceId: record.workspaceId,
          actorPrincipalId: record.principalId,
          action: EVALUATION_WITHHELD_ACTION,
          resourceType: record.taskId !== undefined ? 'task' : undefined,
          resourceId: record.taskId,
          payload: {
            ...(record.channel !== undefined ? { channel: record.channel } : {}),
            onBehalfOf: record.principalId,
            where: record.where,
            ...(record.capability !== undefined ? { capability: record.capability } : {}),
            ...(record.rolledBack !== undefined ? { rolledBack: record.rolledBack } : {}),
            outcome: 'withheld',
          },
        }),
    );
  } catch (auditErr) {
    const detail = auditErr instanceof Error ? auditErr.message : String(auditErr);
    console.error(
      `[kernel] audit of an evaluation seal refusal failed (where=${record.where}): ${detail}`.replace(
        /\n|\r/g,
        '',
      ),
    );
  }
}
