import type { WorkerResultCapabilityParams } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { GatekeeperClientError } from '../../adapters/gatekeeper-client/index.js';
import { OperationNotFoundError } from '../../governance/gatekeepers/index.js';
import { quotedName } from '../../governance/redaction/index.js';
import {
  EVALUATION_SESSION_CAPABILITIES,
  type EvaluationSession,
  FIXTURE_CALL_AUDIT_ACTION,
  FIXTURE_CALL_CAPABILITIES,
  FIXTURE_FAILURE_CODE,
  type FixtureCall,
  type FixtureCallRefusal,
  answerFixtureCall,
  listFixtureOperations,
  readEvaluationSession,
  reportEvaluationResult,
} from '../eval-session/index.js';
import { TaskNotFoundError } from '../task/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler, CapabilityHandlerResult } from './capability-handler.js';
import { UnknownOperationError } from './request-action-handler.js';

/**
 * application/gateway/evaluation-session: the gateway's second layer for an evaluation Task's
 * Worker (S10 E3-2a; `application/eval-session` says what that Worker reaches and why).
 * `dispatch.ts` asks `readEvaluationSession` for every Handle call; for an evaluation session it
 * runs the call here instead of through the capability's own handler:
 *
 *   - a capability outside the five is refused, 403 `evaluation_run_capability_refused`, whatever
 *     the Handle's scope says (it says the same five — this is the second wall);
 *   - `get_task` reads the session's own Task only — any other id is the 404 an unknown id gets;
 *   - `list_allowed_operations`, `observe_operation` and `request_action` are answered from the
 *     case's fixtures, a refused call raising the error the real call raises for the same reason,
 *     and a gate failure raised only after the call's record commits (`afterCommit`), as a real
 *     gate's would be raised after its call: 502 `gatekeeper_error`, `transport_error: …`;
 *   - `report_task_result` completes the Task with the report and writes nothing else.
 *
 * Fixture calls are audited under `evaluation.fixture_call` (`evaluationAuditAction`), with the
 * capability, the trial, the call's number and how it was answered.
 */

export { readEvaluationSession, type EvaluationSession };

/** The audit action `dispatch.ts` records a call of an evaluation session under. */
export function evaluationAuditAction(capability: string): string {
  return FIXTURE_CALL_CAPABILITIES.has(capability) ? FIXTURE_CALL_AUDIT_ACTION : capability;
}

function refusalError(
  refusal: FixtureCallRefusal,
  session: EvaluationSession,
  call: FixtureCall,
): Error {
  switch (refusal.reason) {
    case 'outside_scope':
      // The text a Task's observation scope refuses with (request-action-handler.ts) — the Task
      // names the suite's fixture gates and nothing else.
      return new ForbiddenError(
        `excluded_by_policy: gatekeeper ${call.gatekeeperId} is outside the observation scope of Task ${session.taskId}, which this Worker runs — the scope is fixed when the Task is created`,
      );
    case 'no_operation':
      return call.capability === 'observe_operation'
        ? new OperationNotFoundError(call.gatekeeperId, call.operation)
        : new UnknownOperationError(call.gatekeeperId, 'none');
    case 'not_observe_class':
      return new ForbiddenError(
        `observe_operation: ${quotedName(call.operation)} on gatekeeper ${call.gatekeeperId} is ${refusal.mode}-class — delegate it through invoke_worker (a Worker requests it via request_action)`,
      );
    case 'trial_ended':
      return new ForbiddenError(
        'evaluation_run_ended: the evaluation run this Worker belongs to has ended — nothing more is answered for it',
      );
  }
}

async function fixtureCall(
  client: PoolClient,
  workspaceId: string,
  session: EvaluationSession,
  capability: 'observe_operation' | 'request_action',
  params: unknown,
): Promise<CapabilityHandlerResult> {
  const sent = params as {
    gatekeeperId: string;
    operation: string;
    params?: Record<string, unknown>;
  };
  const call: FixtureCall = {
    capability,
    gatekeeperId: sent.gatekeeperId,
    operation: sent.operation,
    params: sent.params ?? {},
  };
  const outcome = await answerFixtureCall(client, workspaceId, session, call);
  if (outcome.kind === 'refused') throw refusalError(outcome.refusal, session, call);
  const gateFailure = outcome.gateFailure;
  return {
    result: outcome.result,
    resourceType: 'gatekeeper',
    resourceId: call.gatekeeperId,
    auditPayload: {
      capability,
      evaluation: {
        trialId: session.trialId,
        seq: outcome.seq,
        mode: outcome.mode,
        answer: outcome.answer,
        ruleIndex: outcome.ruleIndex,
        ...(outcome.redactedValues > 0 ? { redactedValues: outcome.redactedValues } : {}),
      },
    },
    ...(gateFailure !== undefined
      ? {
          afterCommit: async () => {
            throw new GatekeeperClientError(gateFailure, {
              code: FIXTURE_FAILURE_CODE,
              status: 502,
            });
          },
        }
      : {}),
  };
}

/**
 * Runs one call of an evaluation session. `ownHandler` is the capability's own handler, used for
 * `get_task` once the id is the session's own Task.
 */
export async function runEvaluationSessionCall(
  client: PoolClient,
  workspaceId: string,
  session: EvaluationSession,
  name: string,
  params: unknown,
  ctx: Parameters<CapabilityHandler>[3],
  ownHandler: CapabilityHandler,
): Promise<CapabilityHandlerResult> {
  if (!EVALUATION_SESSION_CAPABILITIES.has(name)) {
    throw new ForbiddenError(
      `evaluation_run_capability_refused: an evaluation run's Worker reads its own Task, its tools and its fixtures and reports its result — "${name}" is not one of those`,
    );
  }
  switch (name) {
    case 'get_task': {
      const { taskId } = params as { taskId: string };
      if (taskId !== session.taskId) throw new TaskNotFoundError(workspaceId, taskId);
      return ownHandler(client, workspaceId, params, ctx);
    }
    case 'list_allowed_operations':
      return { result: await listFixtureOperations(client, workspaceId, session) };
    case 'observe_operation':
    case 'request_action':
      return fixtureCall(client, workspaceId, session, name, params);
    case 'report_task_result': {
      const actor = ctx?.principalId;
      if (!actor) {
        throw new Error(
          'report_task_result: caller context is required (dispatch.ts must supply it)',
        );
      }
      const outcome = await reportEvaluationResult(
        client,
        workspaceId,
        session,
        actor,
        params as WorkerResultCapabilityParams,
      );
      return {
        result: outcome.result,
        resourceType: 'task',
        resourceId: session.taskId,
        auditPayload: {
          evaluation: { trialId: session.trialId },
          ...(outcome.redactedValues > 0 ? { redactedValues: outcome.redactedValues } : {}),
          ...(outcome.unstorableEscaped > 0
            ? { unstorableEscaped: outcome.unstorableEscaped }
            : {}),
        },
      };
    }
    default:
      // Unreachable: the set above holds exactly the cases here.
      throw new ForbiddenError(`evaluation_run_capability_refused: "${name}"`);
  }
}
