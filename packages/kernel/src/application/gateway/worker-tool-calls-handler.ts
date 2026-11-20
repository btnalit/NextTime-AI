import {
  type ReportToolCallsParams,
  type ToolCallMessageContent,
  storableValue,
} from '@nexttime/shared';
import { buildToolCallRecord } from '../chat/tool-call-record.js';
import { findWorkerRunBySessionId, storeWorkerToolCalls } from '../task/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/worker-tool-calls-handler (legacy 155): `report_tool_calls` — worker mode
 * reports the tool calls its run made (packages/shared/src/worker-tool-calls.ts).
 *
 * **Whose run.** The WorkerRun is the calling Handle's own session's (`claims.sid` →
 * `findWorkerRunBySessionId`), as for `report_task_result`; the body names no run, so a Worker can
 * only ever write its own records. A session that is no WorkerRun's (an entry or admin agent's,
 * whose ceilings hold the name only so the Workers they start keep it) is refused with the same
 * 403 whatever the reason. The run's Handle is revoked when the run ends (its result accepted, the
 * Task cancelled, the run reaped), and a run that has ended is refused here too (403): nothing is
 * added to a run that has ended.
 *
 * **What is kept.** Each call becomes the record a chat Turn's tool call becomes
 * (`buildToolCallRecord`, application/chat/tool-call-record.ts — the same reading bound, the same
 * redaction: a secret-named key, the values the arguments hid wherever the result repeats them,
 * anything that looks like a secret), U+0000 and half surrogate pairs stored visibly
 * (`storableValue`, legacy 320 / 837 — this capability is in `HANDLERS_SETTLING_UNSTORABLE_TEXT`:
 * the calls are already made, refusing would only lose them). A `not_finished` call keeps no
 * result. The run's records are numbered in the order reported, the first record of an id kept
 * (`storeWorkerToolCalls`).
 *
 * **What it is.** The Worker runtime's account of its own run. The model's shell holds the same
 * Handle, so a record is as trustworthy as the run's answer and no more; what the run did at a gate
 * is in the audit trail (its `observe_operation` / `request_action` rows), which this neither
 * replaces nor changes. The call's own audit row keeps the counts and the run, not the calls
 * (`auditWithheldParamKeys`: the records are their own table's, and the audit trail does not hold a
 * second copy of a run's tool output).
 */
export const reportToolCallsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const sessionId = ctx?.claims?.sid;
  if (!sessionId) {
    throw new ForbiddenError(
      'report_tool_calls: the calling Handle is not bound to any WorkerRun session',
    );
  }
  const workerRun = await findWorkerRunBySessionId(client, workspaceId, sessionId);
  if (!workerRun) {
    throw new ForbiddenError(
      'report_tool_calls: the calling Handle’s session is not a WorkerRun — no run to record tool calls for',
    );
  }
  // The run's Handle is revoked when it ends; this holds the same here, not only at the door.
  if (workerRun.status === 'terminated') {
    throw new ForbiddenError(
      'report_tool_calls: the calling Handle’s WorkerRun has ended — nothing is added to an ended run',
    );
  }

  const { calls } = params as ReportToolCallsParams;
  let redactedValues = 0;
  let unstorableEscaped = 0;
  const records: ToolCallMessageContent[] = calls.map((call) => {
    const finished = call.outcome !== 'not_finished';
    const record = buildToolCallRecord({
      toolCallId: call.toolCallId,
      name: call.name,
      outcome: call.outcome,
      args: call.args,
      hasArgs: call.args !== undefined,
      result: finished ? call.result : undefined,
      hasResult: finished && call.result !== undefined,
      startedAt: call.startedAt === null ? null : new Date(call.startedAt),
      endedAt: call.endedAt === null ? null : new Date(call.endedAt),
    });
    redactedValues += record.redactedValues;
    const storable = storableValue(record);
    unstorableEscaped += storable.escaped;
    return storable.value;
  });

  const counts = await storeWorkerToolCalls(client, workspaceId, workerRun.id, records);
  return {
    result: { workerRunId: workerRun.id, ...counts },
    resourceType: 'task',
    resourceId: workerRun.taskId,
    auditPayload: {
      workerRunId: workerRun.id,
      callCount: calls.length,
      ...counts,
      // Named apart from dispatch's own `redactedValues` / `unstorableEscaped` (the audit copy of
      // the params): these count what the records hold.
      ...(redactedValues > 0 ? { recordRedactedValues: redactedValues } : {}),
      ...(unstorableEscaped > 0 ? { recordUnstorableEscaped: unstorableEscaped } : {}),
    },
  };
};
