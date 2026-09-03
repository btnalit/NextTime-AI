import type { WorkerResultCapabilityParams, WorkerResultObjectRef } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { findWorkerRunBySessionId, postWorkerResult } from '../../application/task/index.js';
import {
  getGatekeeper,
  listPublishedOperationsForGatekeepers,
} from '../../governance/gatekeepers/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { assertMetaOntologyHandleWriteAllowed } from './meta-ontology-guard.js';

/**
 * application/gateway/worker-result-handler: `report_task_result` and `list_allowed_operations`
 * (design doc §7.3/§7.4, S2.9 deliverable C). Both are the S2.9 "worker infrastructure"
 * capabilities (`governance/capability/handles.ts`'s `WORKER_INFRASTRUCTURE_CAPABILITY_NAMES`).
 *
 * `report_task_result` is deliberately **single-phase** (no `afterCommit`, unlike `request_action`/
 * `invoke_worker`): every write it performs (`application/task/result.ts`'s `postWorkerResult`) is
 * internal to this workspace's own tables, visible to nobody else's in-flight wait, and has no
 * external side effect a rolled-back transaction could leave dangling — the two-phase pattern
 * exists for effects that must survive past this call's own commit boundary (a gate `apply`, a
 * Handle another connection needs to see); a Task/Fact/Activity write has neither problem.
 *
 * **Identity, not the request body** (I13-style): the WorkerRun this call is reporting *for* is
 * resolved from the calling Handle's own `claims.sid` (`findWorkerRunBySessionId`), never from a
 * caller-supplied `taskId`/`workerRunId` field — the registered `paramsSchema`
 * (`WorkerResultCapabilityParamsSchema`, `packages/shared/src/worker-result.ts`) carries neither.
 * A `sid` with no matching WorkerRun (an entry session, a stray/expired Handle, a human caller with
 * no Handle at all) is rejected with the same generic `ForbiddenError` regardless of *why* it
 * doesn't match — the caller learns nothing about whether the session almost-matched.
 *
 * **I16 on every referenced Object, run *before* any write** (`validateFactRefs` below): a
 * `{objectId}` ref must already exist (else a 400, not the FK-violation 500 a raw `assertFact`
 * call would otherwise surface — `application/task/result.ts`'s own doc comment); either ref form
 * naming a protected meta-ontology ObjectType (`WorkerDefinition`/`Gatekeeper`/`Operation`/
 * `Capability`/`Skill`/`Procedure`) is rejected by the same `assertMetaOntologyHandleWriteAllowed`
 * guard `assertFactHandler` (handlers.ts) already uses — this is the one place besides that handler
 * where a Handle-channel caller can name an arbitrary Object via `objectId`/`objectType`, so it gets
 * the identical check.
 */

const graphStore = new SqlGraphStore();

export class WorkerResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerResultValidationError';
  }
}

/** Resolves one ref's ObjectType for the I16 guard (and, for a `{objectId}` ref, confirms the
 *  Object actually exists) — never writes anything. */
async function validateObjectRef(
  client: PoolClient,
  workspaceId: string,
  ref: WorkerResultObjectRef,
  label: string,
): Promise<void> {
  if ('objectId' in ref) {
    const object = await graphStore.getObject(client, workspaceId, ref.objectId);
    if (!object) {
      throw new WorkerResultValidationError(
        `report_task_result: ${label} objectId "${ref.objectId}" does not exist`,
      );
    }
    assertMetaOntologyHandleWriteAllowed('handle', object.objectType);
    return;
  }
  assertMetaOntologyHandleWriteAllowed('handle', ref.objectType);
}

/** Validates every `factsToAssert[]`/`evidence[]` entry's shape-level cross-references before any
 *  write runs (§ module doc comment). Throws `WorkerResultValidationError` (400) or
 *  `MetaOntologyWriteForbiddenError` (403, via `assertMetaOntologyHandleWriteAllowed`). */
async function validateContract(
  client: PoolClient,
  workspaceId: string,
  contract: WorkerResultCapabilityParams,
): Promise<void> {
  const facts = contract.factsToAssert ?? [];
  for (const [index, fact] of facts.entries()) {
    await validateObjectRef(client, workspaceId, fact.source, `factsToAssert[${index}].source`);
    await validateObjectRef(client, workspaceId, fact.target, `factsToAssert[${index}].target`);
  }

  for (const [index, evidenceItem] of (contract.evidence ?? []).entries()) {
    if (evidenceItem.factIndex !== undefined && evidenceItem.factIndex >= facts.length) {
      throw new WorkerResultValidationError(
        `report_task_result: evidence[${index}].factIndex (${evidenceItem.factIndex}) is out of ` +
          `range for factsToAssert (length ${facts.length})`,
      );
    }
  }

  for (const [index, proposal] of (contract.proposedOperations ?? []).entries()) {
    const gatekeeper = await getGatekeeper(client, workspaceId, proposal.gatekeeperId);
    if (!gatekeeper) {
      throw new WorkerResultValidationError(
        `report_task_result: proposedOperations[${index}].gatekeeperId "${proposal.gatekeeperId}" does not exist`,
      );
    }
  }
}

export const reportTaskResultHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const sessionId = ctx?.claims?.sid;
  if (!sessionId) {
    throw new ForbiddenError(
      'report_task_result: the calling Handle is not bound to any WorkerRun session',
    );
  }

  const workerRun = await findWorkerRunBySessionId(client, workspaceId, sessionId);
  if (!workerRun) {
    throw new ForbiddenError(
      'report_task_result: the calling Handle’s session is not a WorkerRun — nothing to report a result for',
    );
  }

  const contract = params as WorkerResultCapabilityParams;
  await validateContract(client, workspaceId, contract);

  const onBehalfOf = ctx?.principalId;
  if (!onBehalfOf) {
    throw new Error('report_task_result: caller context is required (dispatch.ts must supply it)');
  }
  const outcome = await postWorkerResult(client, workspaceId, {
    actorPrincipalId: onBehalfOf,
    taskId: workerRun.taskId,
    workerRunId: workerRun.id,
    contract,
  });

  return {
    result: {
      taskId: outcome.task.id,
      status: outcome.task.status,
      activityId: outcome.activityId,
      factIds: outcome.factIds,
    },
    resourceType: 'task',
    resourceId: outcome.task.id,
  };
};

function toWireOperation(
  record: {
    readonly gatekeeperId: string;
    readonly name: string;
    readonly operation: unknown;
  },
  gateName: string,
) {
  return {
    gatekeeperId: record.gatekeeperId,
    gateName,
    name: record.name,
    operation: record.operation,
  };
}

/** `list_allowed_operations` (S2.9 deliverable B seam): every published Operation of every
 *  Gatekeeper in the calling Handle's own `resources.gatekeeper` scope — a pure description of an
 *  already-granted scope, never a grant of its own (see `packages/shared/src/capabilities.ts`'s
 *  registry entry doc comment). Human callers (no Handle, `ctx?.scope` undefined) get an empty
 *  list — there is no `resources.gatekeeper` to describe outside a Handle's own scope. */
export const listAllowedOperationsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  _params,
  ctx,
) => {
  const gatekeeperIds = ctx?.scope?.resources.gatekeeper ?? [];
  const records = await listPublishedOperationsForGatekeepers(client, workspaceId, gatekeeperIds);

  const gateNames = new Map<string, string>();
  const operations = [];
  for (const record of records) {
    let gateName = gateNames.get(record.gatekeeperId);
    if (gateName === undefined) {
      const gatekeeper = await getGatekeeper(client, workspaceId, record.gatekeeperId);
      gateName = gatekeeper?.name ?? record.gatekeeperId;
      gateNames.set(record.gatekeeperId, gateName);
    }
    operations.push(toWireOperation(record, gateName));
  }

  return { result: { operations } };
};
