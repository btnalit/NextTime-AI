import type { EvalCaseContent, EvalCaseKind } from '@nexttime/shared';
import {
  type EvalSuiteActor,
  addEvalCase,
  addEvalFixtureGate,
  createEvalSuite,
  editEvalCase,
  evalBudgetWire,
  getEvalCase,
  getEvalRun,
  getEvalSuite,
  listEvalRuns,
  listEvalSuites,
  readEvalBudget,
  removeEvalFixtureGate,
  repinEvalSuite,
  retireEvalCase,
  startCaseTrial,
  startCaseTrialTask,
  syncEvalFixtureGate,
} from '../eval/index.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';

/**
 * application/gateway/eval-handlers: the `evaluation` capabilities (S10 E3-1a, cases E3-1b) — an
 * evaluation suite's reads and the changes that make its versions (`application/eval`, which holds
 * every rule). The only gateway file allowed to import `application/eval` (`.dependency-cruiser.cjs`):
 * every capability here is human-channel and made for a person (I-E4), so the registry and dispatch
 * have already refused a Handle, an agent and a service Principal before a handler runs. dispatch's
 * per-call AuditRecord carries the params (a reason redacted like every audited param) but for a
 * case's content, which it withholds (`auditWithheldParamKeys`: a case is read through
 * `get_eval_case` only); the suite's own history is `eval_suite_changes`. E3-2a: a run is started
 * here (`start_eval_case_trial`, its Task started after the commit) and read here; its trials are
 * scored by `application/eval`'s runner, which the composition root ticks.
 */

function personOf(capability: string, ctx: CapabilityHandlerContext | undefined): EvalSuiteActor {
  if (ctx?.channel !== 'human' || ctx.principal?.kind !== 'human') {
    // The registry makes every evaluation capability human-channel and `actsForPerson`; reaching
    // here without a person is a wiring bug, not a caller to serve.
    throw new Error(
      `${capability}: no person in context (an evaluation capability is for people only)`,
    );
  }
  return { principalId: ctx.principal.id };
}

function suiteResult(suite: { readonly id: string }, result: unknown) {
  return { result, resourceType: 'eval_suite', resourceId: suite.id };
}

export const listEvalSuitesHandler: CapabilityHandler = async (
  client,
  workspaceId,
  _params,
  ctx,
) => {
  personOf('list_eval_suites', ctx);
  return { result: { items: await listEvalSuites(client, workspaceId) } };
};

export const getEvalSuiteHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  personOf('get_eval_suite', ctx);
  const { suiteId } = params as { suiteId: string };
  const suite = await getEvalSuite(client, workspaceId, suiteId);
  return suiteResult(suite, suite);
};

export const createEvalSuiteHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const input = params as {
    name: string;
    description?: string;
    workerDefinitionId: string;
    workerDefinitionVersion: number;
  };
  const suite = await createEvalSuite(
    client,
    workspaceId,
    personOf('create_eval_suite', ctx),
    input,
  );
  return suiteResult(suite, suite);
};

export const repinEvalSuiteHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const target = params as {
    suiteId: string;
    suiteVersion: number;
    workerDefinitionVersion: number;
    reason?: string;
  };
  const suite = await repinEvalSuite(
    client,
    workspaceId,
    personOf('repin_eval_suite', ctx),
    target,
  );
  return suiteResult(suite, suite);
};

export const addEvalFixtureGateHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const target = params as { suiteId: string; suiteVersion: number; gatekeeperId: string };
  const suite = await addEvalFixtureGate(
    client,
    workspaceId,
    personOf('add_eval_fixture_gate', ctx),
    target,
  );
  return suiteResult(suite, suite);
};

export const syncEvalFixtureGateHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const target = params as { suiteId: string; suiteVersion: number; gatekeeperId: string };
  const suite = await syncEvalFixtureGate(
    client,
    workspaceId,
    personOf('sync_eval_fixture_gate', ctx),
    target,
  );
  return suiteResult(suite, suite);
};

export const removeEvalFixtureGateHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const target = params as {
    suiteId: string;
    suiteVersion: number;
    gatekeeperId: string;
    reason: string;
  };
  const suite = await removeEvalFixtureGate(
    client,
    workspaceId,
    personOf('remove_eval_fixture_gate', ctx),
    target,
  );
  return suiteResult(suite, suite);
};

export const getEvalCaseHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  personOf('get_eval_case', ctx);
  const { suiteId, caseId } = params as { suiteId: string; caseId: string };
  const evalCase = await getEvalCase(client, workspaceId, suiteId, caseId);
  return { result: evalCase, resourceType: 'eval_case', resourceId: evalCase.id };
};

export const addEvalCaseHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const target = params as { suiteId: string; suiteVersion: number } & EvalCaseKind &
    EvalCaseContent;
  const suite = await addEvalCase(client, workspaceId, personOf('add_eval_case', ctx), target);
  return suiteResult(suite, suite);
};

export const editEvalCaseHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const target = params as {
    suiteId: string;
    suiteVersion: number;
    caseId: string;
    reason: string;
  } & EvalCaseContent;
  const suite = await editEvalCase(client, workspaceId, personOf('edit_eval_case', ctx), target);
  return suiteResult(suite, suite);
};

export const retireEvalCaseHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const target = params as {
    suiteId: string;
    suiteVersion: number;
    caseId: string;
    reason: string;
  };
  const suite = await retireEvalCase(
    client,
    workspaceId,
    personOf('retire_eval_case', ctx),
    target,
  );
  return suiteResult(suite, suite);
};

// ----- runs (E3-2a) ----------------------------------------------------------------------------

/** Starts the run in this call's transaction; its Task is started once that commits, and the run
 *  as it is then is the result. */
export const startEvalCaseTrialHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const actor = personOf('start_eval_case_trial', ctx);
  const target = params as { suiteId: string; suiteVersion: number; caseId: string };
  const started = await startCaseTrial(client, workspaceId, actor, target);
  return {
    result: started.run,
    resourceType: 'eval_run',
    resourceId: started.run.id,
    auditPayload: { taskId: started.task.task.id },
    afterCommit: (pool) => startCaseTrialTask(pool, workspaceId, actor, started),
  };
};

export const getEvalRunHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  personOf('get_eval_run', ctx);
  const { runId } = params as { runId: string };
  const run = await getEvalRun(client, workspaceId, runId);
  // The suite, so the console's audit row links to it.
  return {
    result: run,
    resourceType: 'eval_run',
    resourceId: run.id,
    auditPayload: { suiteId: run.suiteId },
  };
};

export const listEvalRunsHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  personOf('list_eval_runs', ctx);
  const filter = params as { suiteId: string; caseId?: string };
  return {
    result: { items: await listEvalRuns(client, workspaceId, filter) },
    resourceType: 'eval_suite',
    resourceId: filter.suiteId,
  };
};

export const getEvalBudgetHandler: CapabilityHandler = async (
  client,
  workspaceId,
  _params,
  ctx,
) => {
  personOf('get_eval_budget', ctx);
  return { result: evalBudgetWire(await readEvalBudget(client, workspaceId)) };
};
