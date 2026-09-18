import type { WorkerResultCapabilityParams, WorkerResultObjectRef } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type {
  ContractPreRejections,
  RejectedResultFact,
  RejectedResultProposal,
} from '../../application/task/index.js';
import { findWorkerRunBySessionId, postWorkerResult } from '../../application/task/index.js';
import {
  getGatekeeper,
  listPublishedOperationsForGatekeepers,
} from '../../governance/gatekeepers/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import {
  MetaOntologyWriteForbiddenError,
  assertMetaOntologyHandleWriteAllowed,
} from './meta-ontology-guard.js';

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
 * **I16 on every referenced Object, checked *before* any write** (`validateContract` below): a
 * `{objectId}` ref must already exist (else the FK-violation 500 a raw `assertFact` call would
 * otherwise surface — `application/task/result.ts`'s own doc comment); either ref form naming a
 * protected meta-ontology ObjectType (`WorkerDefinition`/`Gatekeeper`/`Operation`/`Capability`/
 * `Skill`/`Procedure`) is refused by the same `assertMetaOntologyHandleWriteAllowed` guard
 * `assertFactHandler` (handlers.ts) already uses — this is the one place besides that handler where
 * a Handle-channel caller can name an arbitrary Object via `objectId`/`objectType`, so it gets the
 * identical check. Since 2026-09-18 a refused entry is *recorded and skipped* rather than failing
 * the whole call (`postWorkerResult`'s `preRejected`): the entry is never written, so I16 holds
 * exactly as before, and the Task keeps its result — a real-model Worker inventing a `Gatekeeper`
 * ref or a `gatekeeperId` must not turn an executed action into `failed / no_result`.
 */

const graphStore = new SqlGraphStore();

export class WorkerResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerResultValidationError';
  }
}

/** Resolves one ref's ObjectType for the I16 guard (and, for a `{objectId}` ref, confirms the
 *  Object actually exists) — never writes anything. Returns the refusal instead of throwing: a
 *  refused ref makes *its* fact a recorded per-entry rejection, never a lost contract (see
 *  application/task/result.ts's module doc comment, "per-entry refusals"; the 2026-09-18
 *  real-model round lost whole results to a single model-invented `Gatekeeper`/`Task` ref). */
async function checkObjectRef(
  client: PoolClient,
  workspaceId: string,
  ref: WorkerResultObjectRef,
): Promise<{ reason: 'object_not_found' | 'meta_ontology_type'; detail: string } | undefined> {
  let objectType: string;
  if ('objectId' in ref) {
    const object = await graphStore.getObject(client, workspaceId, ref.objectId);
    if (!object) {
      return { reason: 'object_not_found', detail: `objectId "${ref.objectId}" does not exist` };
    }
    objectType = object.objectType;
  } else {
    objectType = ref.objectType;
  }
  try {
    assertMetaOntologyHandleWriteAllowed('handle', objectType);
  } catch (err) {
    if (err instanceof MetaOntologyWriteForbiddenError) {
      return {
        reason: 'meta_ontology_type',
        detail: `ObjectType "${objectType}" is platform meta-ontology (I16)`,
      };
    }
    throw err;
  }
  return undefined;
}

/** Checks every `factsToAssert[]`/`evidence[]`/`proposedOperations[]` entry's cross-references
 *  before any write runs (§ module doc comment) and returns the per-entry refusals for
 *  `postWorkerResult` to skip and record — a model-generated entry that names a meta-ontology
 *  type (I16), a missing `objectId`, a `gatekeeperId` that is no Gatekeeper, or an
 *  `evidence[].factIndex` out of range costs that entry, not the Task's result. Nothing here
 *  throws for a per-entry problem; contract-level shape errors are already the capability
 *  boundary's Zod validation. */
async function validateContract(
  client: PoolClient,
  workspaceId: string,
  contract: WorkerResultCapabilityParams,
): Promise<ContractPreRejections> {
  const contractFacts = contract.factsToAssert ?? [];
  const facts: RejectedResultFact[] = [];
  for (const [index, fact] of contractFacts.entries()) {
    const refusal =
      (await checkObjectRef(client, workspaceId, fact.source)) ??
      (await checkObjectRef(client, workspaceId, fact.target));
    if (refusal) {
      facts.push({
        index,
        linkType: fact.linkType,
        reason: refusal.reason,
        detail: refusal.detail,
      });
    }
  }

  const evidenceDropped: number[] = [];
  for (const [index, evidenceItem] of (contract.evidence ?? []).entries()) {
    if (evidenceItem.factIndex !== undefined && evidenceItem.factIndex >= contractFacts.length) {
      evidenceDropped.push(index);
    }
  }

  const proposals: RejectedResultProposal[] = [];
  for (const [index, proposal] of (contract.proposedOperations ?? []).entries()) {
    const gatekeeper = await getGatekeeper(client, workspaceId, proposal.gatekeeperId);
    if (!gatekeeper) {
      proposals.push({
        index,
        gatekeeperId: proposal.gatekeeperId,
        reason: 'gatekeeper_not_found',
      });
    }
  }

  return { facts, proposals, evidenceDropped };
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
  const preRejected = await validateContract(client, workspaceId, contract);

  const onBehalfOf = ctx?.principalId;
  if (!onBehalfOf) {
    throw new Error('report_task_result: caller context is required (dispatch.ts must supply it)');
  }
  // `agentPrincipalId` is resolved once, at spawn time (`spawn.ts`'s `ensureWorkerAgentPrincipal`),
  // and stamped on the WorkerRun row itself — `findWorkerRunBySessionId` above already read it, so
  // this handler passes it straight through rather than making `postWorkerResult` re-derive it.
  // Missing only if a WorkerRun somehow predates migrations/task/0004 (should not happen on a
  // freshly migrated database) — fail loudly rather than silently falling back to the human, which
  // is exactly the bug this design replaces (docs/development-tasks.md S2.9 note).
  if (!workerRun.agentPrincipalId) {
    throw new Error(
      `report_task_result: WorkerRun ${workerRun.id} has no agent_principal_id — cannot attribute this result contract`,
    );
  }
  const outcome = await postWorkerResult(client, workspaceId, {
    actorPrincipalId: onBehalfOf,
    agentPrincipalId: workerRun.agentPrincipalId,
    taskId: workerRun.taskId,
    workerRunId: workerRun.id,
    contract,
    preRejected,
  });

  return {
    result: {
      id: outcome.task.id,
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

  return { result: { items: operations } };
};
