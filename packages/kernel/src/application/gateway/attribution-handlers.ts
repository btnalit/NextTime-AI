import type { ObjectiveOutcome } from '@nexttime/shared';
import { currentPrincipalId, requireChatAccess } from '../../application/chat/index.js';
import { findAttributableTurn } from '../../application/host-bridge/index.js';
import {
  type ObjectiveOutcomeRecord,
  type ProcedureClaimRecord,
  type SkillLoadRecord,
  TaskNotFoundError,
  type TurnAttributionRecord,
  listChatTurns,
  markTurnOutcome,
  recordProcedureFollowed,
  reportTaskOutcome,
} from '../../application/task/index.js';
import { ProcedureNotFoundError } from '../../application/worker/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { NoActiveTurnError, TurnNotFoundError } from './turn-errors.js';

/**
 * application/gateway/attribution-handlers: S10 E1 结果归因 capabilities
 * (docs/s10-evolution-plan-2026-10-04.md §5.3, `packages/shared/src/capabilities.ts`'s registry
 * entries) — one file for the family, the same split-file convention `discard-draft-handler.ts`
 * follows. The domain logic (who may give an outcome, the one-correction rule, published-only
 * Procedures) is `application/task/attribution.ts`; this file resolves the caller and shapes the
 * wire. The per-call AuditRecord (params included — the outcome given, a correction) is written by
 * `dispatch.ts`, as for every capability.
 */

// -------------------------------------------------------------------------------------------
// Wire projections (packages/shared/src/wire/attribution.ts) — also used by `toWireTask`.
// -------------------------------------------------------------------------------------------

export function toWireObjectiveOutcome(record: ObjectiveOutcomeRecord | null) {
  if (!record) return null;
  return {
    outcome: record.outcome,
    givenBy: record.givenBy,
    givenAt: record.givenAt.toISOString(),
    revision: record.revision,
    previousOutcome: record.previousOutcome,
  };
}

export function toWireSkillLoads(records: readonly SkillLoadRecord[] | null | undefined) {
  if (!records) return null;
  return records.map((record) => ({
    skillId: record.skillId,
    version: record.version,
    name: record.name,
  }));
}

export function toWireProcedureClaim(record: ProcedureClaimRecord) {
  return {
    procedureId: record.procedureId,
    version: record.version,
    name: record.name,
    basis: 'claimed' as const,
    claimedAt: record.claimedAt.toISOString(),
  };
}

export function toWireTurnAttribution(record: TurnAttributionRecord) {
  return {
    id: record.id,
    chatId: record.chatId,
    startedBy: record.startedBy,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    endedAt: record.endedAt ? record.endedAt.toISOString() : null,
    procedure: record.procedure ? toWireProcedureClaim(record.procedure) : null,
    outcome: toWireObjectiveOutcome(record.outcome),
  };
}

// -------------------------------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------------------------------

/** `list_chat_turns` (human): the Chat must be visible (`requireChatAccess`, 404 otherwise). */
export const listChatTurnsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { chatId, limit, cursor } = params as { chatId: string; limit?: number; cursor?: string };
  await requireChatAccess(client, workspaceId, chatId);
  const page = await listChatTurns(client, workspaceId, chatId, { limit, cursor });
  return {
    result: {
      items: page.items.map(toWireTurnAttribution),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    },
    resourceType: 'chat',
    resourceId: chatId,
  };
};

/** `mark_turn_outcome` (human): an unknown or invisible Turn is the same 404 (`TurnNotFoundError`)
 *  `report_turn` gives. */
export const markTurnOutcomeHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { turnId, outcome } = params as { turnId: string; outcome: ObjectiveOutcome };
  const principalId = await currentPrincipalId(client);
  const turn = await markTurnOutcome(client, workspaceId, principalId, turnId, outcome);
  if (!turn) throw new TurnNotFoundError(workspaceId, turnId);
  return { result: toWireTurnAttribution(turn), resourceType: 'activity', resourceId: turnId };
};

/** `record_procedure_followed` (entry Handle): attributed to the caller's currently-running Turn —
 *  the same rule and the same 409 `record_decision` uses. A Procedure version that is not
 *  published is a 404, never confirmation that a private draft exists. */
export const recordProcedureFollowedHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { procedureId, version } = params as { procedureId: string; version: number };
  const principalId = ctx?.principalId || (await currentPrincipalId(client));
  const turn = await findAttributableTurn(client, { workspaceId, principalId, at: new Date() });
  if (!turn?.wasRunning) throw new NoActiveTurnError('record_procedure_followed', 'a Procedure');
  const claim = await recordProcedureFollowed(client, workspaceId, principalId, turn.id, {
    procedureId,
    version,
  });
  if (claim === false) throw new ProcedureNotFoundError(workspaceId, `${procedureId}@${version}`);
  return { result: toWireProcedureClaim(claim), resourceType: 'activity', resourceId: turn.id };
};

/** `report_task_outcome` (entry Handle): only a Task acting for the caller's own principal; any
 *  other id is the same 404 `get_task` gives. */
export const reportTaskOutcomeHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { taskId, outcome } = params as { taskId: string; outcome: ObjectiveOutcome };
  const principalId = ctx?.principalId || (await currentPrincipalId(client));
  const record = await reportTaskOutcome(client, workspaceId, principalId, taskId, outcome);
  if (!record) throw new TaskNotFoundError(workspaceId, taskId);
  return { result: toWireObjectiveOutcome(record), resourceType: 'task', resourceId: taskId };
};
