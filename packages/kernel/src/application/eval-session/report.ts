import { type WorkerResultCapabilityParams, storableValue } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { redactSecrets } from '../../governance/redaction/index.js';
import { completeTaskWithResult } from '../task/index.js';
import type { EvaluationSession } from './session.js';

/** What an evaluation Task's `report_task_result` returns — the shape the real one returns. */
export interface EvaluationReportOutcome {
  readonly result: {
    readonly id: string;
    readonly status: string;
    readonly activityId: string;
    readonly factIds: readonly string[];
  };
  /** Values replaced as secrets in the stored report, and U+0000 escaped. */
  readonly redactedValues: number;
  readonly unstorableEscaped: number;
}

/**
 * `report_task_result` for an evaluation Task's Worker: the report is the trial's result — stored
 * on the Task as reported, scrubbed of secrets (the rule a real report's text is stored by), and
 * the Task completed. None of what a real report writes: no Fact, no Source, no Activity, no
 * proposed Skill or Operation — an evaluation leaves nothing in the workspace's knowledge or
 * drafts. `factsToAssert` and the proposals stay in the stored report, where the case's
 * assertions can judge them (eval-case.ts: `result` is the report as reported). The session
 * pointer is the extension's, not the Worker's, and is dropped.
 *
 * `activityId` is the WorkerRun's own Activity — a real report's is the `worker_result` Activity
 * it starts, which an evaluation does not.
 */
export async function reportEvaluationResult(
  client: PoolClient,
  workspaceId: string,
  session: EvaluationSession,
  actorPrincipalId: string,
  report: WorkerResultCapabilityParams,
): Promise<EvaluationReportOutcome> {
  const { sessionJsonlPath: _pointer, ...contract } = report;
  const storable = storableValue(contract);
  // Unbounded walk: the contract already passed its schema, and the scrubbed copy is stored.
  const scrubbed = redactSecrets(storable.value, { maxNodes: Number.POSITIVE_INFINITY });
  if (session.workerRunActivityId === null) {
    throw new Error(
      `evaluation report: WorkerRun ${session.workerRunId} has no Activity — cannot report for it`,
    );
  }
  const task = await completeTaskWithResult(
    client,
    workspaceId,
    actorPrincipalId,
    session.taskId,
    session.workerRunId,
    scrubbed.value,
  );
  return {
    result: {
      id: task.id,
      status: task.status,
      activityId: session.workerRunActivityId,
      factIds: [],
    },
    redactedValues: scrubbed.redactedValues,
    unstorableEscaped: storable.escaped,
  };
}
