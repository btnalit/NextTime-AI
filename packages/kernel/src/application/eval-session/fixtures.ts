import { randomUUID } from 'node:crypto';
import {
  type EvalCallAnswer,
  type EvalFixtureRule,
  type Operation,
  operationAbsentAnswers,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { redactSuspectedSecrets } from '../../governance/redaction/index.js';
import { evaluatePredicate } from '../../substrate/epistemic/index.js';
import { shownObjectProperties } from '../../substrate/graph/index.js';
import type { EvaluationSession } from './session.js';

/** One Operation of a fixture gate, as frozen into the suite (`eval_fixture_gates.snapshot`). */
interface FixtureOperation {
  readonly gatekeeperId: string;
  readonly gateName: string;
  readonly name: string;
  /** The published Operation's definition, as stored. */
  readonly operation: Record<string, unknown>;
}

interface FixtureGateRow {
  gatekeeper_id: string;
  snapshot: {
    readonly gateName: string;
    readonly operations: readonly {
      readonly name: string;
      readonly operation: Record<string, unknown>;
    }[];
  };
}

/** The fixture gates of the trial's suite at the version the run pinned, every Operation. */
async function readFixtureOperations(
  client: PoolClient,
  workspaceId: string,
  session: EvaluationSession,
): Promise<readonly FixtureOperation[]> {
  const rows = await client.query<FixtureGateRow>(
    `select gatekeeper_id, snapshot
       from eval_fixture_gates
      where workspace_id = $1 and suite_id = $2 and added_in_version <= $3
        and (retired_in_version is null or retired_in_version > $3)
      order by gatekeeper_id`,
    [workspaceId, session.suiteId, session.suiteVersion],
  );
  return rows.rows.flatMap((row) =>
    row.snapshot.operations.map((op) => ({
      gatekeeperId: row.gatekeeper_id,
      gateName: row.snapshot.gateName,
      name: op.name,
      operation: op.operation,
    })),
  );
}

/**
 * `list_allowed_operations` for an evaluation Task's Worker: every Operation of the suite's
 * fixture gates, as frozen, in the shape the real list has (`worker-result-handler.ts`'s
 * `toWireOperation`: the gate's name, the Operation as every read shows one) — the tools the
 * Worker's gate calls are answered for. Nothing of a real gate's present state.
 */
export async function listFixtureOperations(
  client: PoolClient,
  workspaceId: string,
  session: EvaluationSession,
): Promise<{ readonly items: readonly unknown[] }> {
  const operations = await readFixtureOperations(client, workspaceId, session);
  return {
    items: operations.map((op) => ({
      gatekeeperId: op.gatekeeperId,
      gateName: op.gateName,
      name: op.name,
      operation: shownObjectProperties('Operation', op.operation),
    })),
  };
}

/** A Worker's gate call, as it made it. */
export interface FixtureCall {
  readonly capability: 'observe_operation' | 'request_action';
  readonly gatekeeperId: string;
  readonly operation: string;
  readonly params: Record<string, unknown>;
}

/** Why a fixture call is refused before it is answered — each refused as the real call would be
 *  (the gateway raises the production error for it), and nothing recorded. */
export type FixtureCallRefusal =
  /** The gate is none of the suite's fixture gates: outside the Task's observation scope. */
  | { readonly reason: 'outside_scope' }
  /** The fixture gate has no Operation by that name. */
  | { readonly reason: 'no_operation' }
  /** `observe_operation` naming an Operation that is not observe-class. */
  | { readonly reason: 'not_observe_class'; readonly mode: string }
  /** The trial has already ended (its Task ended; a straggling call). */
  | { readonly reason: 'trial_ended' };

/** What a fixture call is answered with — the transports' view of a gate failure is raised by
 *  the gateway after the call record commits (`gateFailure`). */
export type FixtureCallOutcome =
  | { readonly kind: 'refused'; readonly refusal: FixtureCallRefusal }
  | {
      readonly kind: 'answered';
      readonly seq: number;
      readonly mode: 'observe' | 'execute';
      readonly answer: EvalCallAnswer;
      readonly ruleIndex: number | null;
      /** What the call returns, when it returns. */
      readonly result: unknown;
      /** For an observe-class call answered with an error (or no answer): the message of the
       *  gate failure the call fails with, as a gate whose target failed reports one. */
      readonly gateFailure?: string;
      /** Values in the recorded params replaced as suspected secrets. */
      readonly redactedValues: number;
    };

/** What a call no rule matches is answered with (eval-case.ts). */
export const FIXTURE_UNANSWERED_MESSAGE = 'the fixture has no answer for this call';

/** The code a gate reports when its target failed (`gatekeeper-base` `TransportInvokeError`) — what
 *  a fixture's error answer looks like to the Worker, as a real target's failure would. */
export const FIXTURE_FAILURE_CODE = 'transport_error';

/** `mode` as a fixture call records it: an Operation that is not execute-class is read. */
function modeOf(operation: Record<string, unknown>): 'observe' | 'execute' {
  return operation.mode === 'execute' ? 'execute' : 'observe';
}

/**
 * Whether `rule` answers the call: the same gate and Operation, its `when` (if any) satisfied by
 * the call's params, and its answer one the Operation can give now — an `absent` answer only for
 * an observe-class Operation that declares such answers. The case was checked against the suite's
 * fixture gates when it was written; a later sync of a gate can leave a rule that no longer fits
 * (the console lists it under the case's problems), and such a rule answers nothing.
 */
function ruleAnswers(rule: EvalFixtureRule, call: FixtureCall, op: FixtureOperation): boolean {
  if (rule.gatekeeperId !== call.gatekeeperId || rule.operation !== call.operation) return false;
  if (
    rule.answer.kind === 'absent' &&
    operationAbsentAnswers(op.operation as unknown as Operation) === undefined
  ) {
    return false;
  }
  return (
    rule.when === undefined || evaluatePredicate(rule.when, call.params).outcome === 'satisfied'
  );
}

/**
 * Answers one gate call of an evaluation Task's Worker from its case's fixtures (eval-case.ts: the
 * first rule that matches answers; none matching is `unanswered`) and records it on the trial
 * (`eval_trial_calls`, numbered in order). Nothing reaches a gate; nothing is written to the graph.
 *
 * The answer takes the shape the real call's would:
 *   - an observe-class Operation (by `observe_operation`, or `request_action` naming one): `data`
 *     is `{status: 'ok', data, observedFactCount: 0}`; `absent` is the gate's "not there" answer,
 *     `{status: 'ok', data: null, observedFactCount: 0, absent}` with the first status or exit code
 *     the Operation declares; an error, or no answer, is a gate failure (`gateFailure`);
 *   - an execute-class Operation: `data` is the outcome of an executed request,
 *     `{id, status: 'executed', data}`; an error, or no answer, is a failed one,
 *     `{id, status: 'failed', failureKind: 'refused', reason}` — what a target's failure during
 *     apply leaves. Nothing is executed; `id` names no ActionRequest.
 *
 * The recorded params are the call's with suspected secrets replaced (the audit rule): a person
 * reads them in the console, and a Worker can be talked into passing its own Handle.
 */
export async function answerFixtureCall(
  client: PoolClient,
  workspaceId: string,
  session: EvaluationSession,
  call: FixtureCall,
): Promise<FixtureCallOutcome> {
  const operations = await readFixtureOperations(client, workspaceId, session);
  const gateOperations = operations.filter((op) => op.gatekeeperId === call.gatekeeperId);
  if (gateOperations.length === 0) {
    return { kind: 'refused', refusal: { reason: 'outside_scope' } };
  }
  const op = gateOperations.find((candidate) => candidate.name === call.operation);
  if (!op) return { kind: 'refused', refusal: { reason: 'no_operation' } };
  const mode = modeOf(op.operation);
  if (call.capability === 'observe_operation' && op.operation.mode !== 'observe') {
    return {
      kind: 'refused',
      refusal: { reason: 'not_observe_class', mode: String(op.operation.mode) },
    };
  }

  // Calls are numbered in the order they are recorded: the trial row is held while the next
  // number is taken (the table's guard checks it again).
  const trial = await client.query<{ status: string }>(
    'select status from eval_trials where workspace_id = $1 and id = $2 for update',
    [workspaceId, session.trialId],
  );
  if (trial.rows[0]?.status !== 'running') {
    return { kind: 'refused', refusal: { reason: 'trial_ended' } };
  }
  const caseRow = await client.query<{ fixtures: readonly EvalFixtureRule[] }>(
    'select fixtures from eval_cases where workspace_id = $1 and id = $2',
    [workspaceId, session.caseId],
  );
  const rules = caseRow.rows[0]?.fixtures ?? [];
  const index = rules.findIndex((rule) => ruleAnswers(rule, call, op));
  const rule = index >= 0 ? rules[index] : undefined;
  const answer: EvalCallAnswer = rule ? rule.answer.kind : 'unanswered';

  const recorded = redactSuspectedSecrets(call.params, { secretFields: true });
  const next = await client.query<{ seq: number }>(
    `insert into eval_trial_calls
       (workspace_id, trial_id, seq, gatekeeper_id, gate_name, operation, mode, params, rule_index, answer)
     select $1, $2, coalesce(max(seq), 0) + 1, $3, $4, $5, $6, $7::jsonb, $8, $9
       from eval_trial_calls
      where workspace_id = $1 and trial_id = $2
     returning seq`,
    [
      workspaceId,
      session.trialId,
      call.gatekeeperId,
      op.gateName,
      op.name,
      mode,
      JSON.stringify(recorded.value),
      rule ? index : null,
      answer,
    ],
  );
  const seq = next.rows[0]?.seq;
  if (seq === undefined) throw new Error('answerFixtureCall: INSERT ... RETURNING produced no row');

  const failureMessage =
    rule?.answer.kind === 'error'
      ? rule.answer.message
      : rule === undefined
        ? FIXTURE_UNANSWERED_MESSAGE
        : undefined;
  const answered = { kind: 'answered' as const, seq, mode, answer, ruleIndex: rule ? index : null };
  const redactedValues = recorded.count;

  if (mode === 'execute') {
    const id = randomUUID();
    return {
      ...answered,
      redactedValues,
      result:
        rule?.answer.kind === 'data'
          ? { id, status: 'executed', data: rule.answer.data }
          : {
              id,
              status: 'failed',
              failureKind: 'refused',
              reason: `${FIXTURE_FAILURE_CODE}: ${failureMessage ?? FIXTURE_UNANSWERED_MESSAGE}`,
            },
    };
  }
  if (rule?.answer.kind === 'data') {
    return {
      ...answered,
      redactedValues,
      result: { status: 'ok', data: rule.answer.data, observedFactCount: 0 },
    };
  }
  if (rule?.answer.kind === 'absent') {
    const declared = operationAbsentAnswers(op.operation as unknown as Operation);
    const absent =
      declared && 'statuses' in declared
        ? { status: declared.statuses[0] }
        : { exitCode: declared?.exitCodes[0] };
    return {
      ...answered,
      redactedValues,
      result: { status: 'ok', data: null, observedFactCount: 0, absent },
    };
  }
  return {
    ...answered,
    redactedValues,
    result: { status: 'failed' },
    gateFailure: failureMessage ?? FIXTURE_UNANSWERED_MESSAGE,
  };
}
