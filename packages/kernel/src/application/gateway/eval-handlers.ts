import {
  type EvalSuiteActor,
  addEvalFixtureGate,
  createEvalSuite,
  getEvalSuite,
  listEvalSuites,
  removeEvalFixtureGate,
  repinEvalSuite,
  syncEvalFixtureGate,
} from '../eval/index.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';

/**
 * application/gateway/eval-handlers: the `evaluation` capabilities (S10 E3-1a) — an evaluation
 * suite's reads and the changes that make its versions (`application/eval`, which holds every
 * rule). The only gateway file allowed to import `application/eval` (`.dependency-cruiser.cjs`):
 * every capability here is human-channel and made for a person (I-E4), so the registry and dispatch
 * have already refused a Handle, an agent and a service Principal before a handler runs. dispatch's
 * per-call AuditRecord carries the params (a reason redacted like every audited param); the suite's
 * own history is `eval_suite_changes`.
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
