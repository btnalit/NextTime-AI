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
  listGatekeepers,
  listPublishedOperationsForGatekeepers,
} from '../../governance/gatekeepers/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import {
  narrowScopeToExecutableGates,
  observeRefusal,
  operationPlatformStatus,
  readExecuteAccess,
  readGateLinkPoliciesForWorkspace,
  readObserveExclusions,
} from '../gates/index.js';
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

/** `list_allowed_operations` (S2.9 deliverable B seam): the Operations the calling Handle may act
 *  on, one entry per `<gate>.<op>` — a pure description, never a grant of its own (see
 *  `packages/shared/src/capabilities.ts`'s registry entry doc comment). Two halves:
 *
 *   - **observe-class**: every published observe Operation of every Gatekeeper in this workspace
 *     that `observeRefusal` (application/gates/observe-access.ts — the predicate
 *     `observe_operation` / `request_action` enforce) accepts for the Handle's member: no Grant
 *     needed (decision D4 revoked 2026-09-27, "只读调用不需要授权"), but a gate the AgentPolicy cap
 *     or the member's own AgentProfile excludes, or an Operation on the platform deny list, is not
 *     listed. This is what makes an ungranted system visible to the entry agent, a Worker and an
 *     MCP client alike — without it enforcement would allow a call no tool exists for.
 *   - **execute-class**: the published execute Operations of the Gatekeepers in the Handle's own
 *     `resources.gatekeeper` (Grant-derived, attenuated per Worker) that the member can still act
 *     on now — narrowed to their current `effective.enabledGatekeepers` exactly as `request_action`
 *     narrows it (R-37 / D-20, application/gates/execute-access.ts) — minus the platform deny list
 *     (`operationPlatformStatus`).
 *
 *  Human callers (no Handle, `ctx?.scope` undefined) get an empty list — this describes a Handle.
 *
 * Production incident 2026-09-26: this is the tool list the pi extension projects at session
 * start, so an Operation the platform's connector deny list would refuse on the very next call must
 * not appear here either — it used to, offering a tool whose every call failed with
 * `operation_disabled`. One batched workspace-wide deny-list read, not one query per Operation. */
export const listAllowedOperationsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  _params,
  ctx,
) => {
  const principalId = ctx?.principalId;
  if (!ctx?.scope || !principalId) return { result: { items: [] } };

  const executeScope = narrowScopeToExecutableGates(
    ctx.scope,
    await readExecuteAccess(client, workspaceId, principalId),
  );
  const executeGatekeepers = new Set(executeScope.resources.gatekeeper ?? []);
  const gates = await listGatekeepers(client, workspaceId);
  const records = await listPublishedOperationsForGatekeepers(
    client,
    workspaceId,
    gates.map((gate) => gate.gatekeeperId),
  );
  const gateLinks = await readGateLinkPoliciesForWorkspace(client, workspaceId);
  const exclusions = await readObserveExclusions(client, workspaceId, principalId);

  // One `getGatekeeper` per gate (not per Operation): its display name, and — the same lookup
  // `observe_operation` 404s on — whether the gate counts as enabled for `observeRefusal`.
  const gateRecords = new Map<string, GatekeeperRecord | null>();
  const operations = [];
  for (const record of records) {
    let gatekeeper = gateRecords.get(record.gatekeeperId);
    if (gatekeeper === undefined) {
      gatekeeper = await getGatekeeper(client, workspaceId, record.gatekeeperId);
      gateRecords.set(record.gatekeeperId, gatekeeper);
    }
    const gateLink = gateLinks.get(record.gatekeeperId);
    const mode = (record.operation as { mode?: string }).mode;
    const listed =
      mode === 'execute'
        ? executeGatekeepers.has(record.gatekeeperId) &&
          !operationPlatformStatus(gateLink, record.name).disabled
        : observeRefusal(exclusions, {
            gatekeeperId: record.gatekeeperId,
            gateEnabled: gatekeeper !== null,
            operationName: record.name,
            publishedMode: mode,
            gateLink,
          }) === undefined;
    if (!listed) continue;
    operations.push(toWireOperation(record, gatekeeper?.name ?? record.gatekeeperId));
  }

  return { result: { items: operations } };
};
