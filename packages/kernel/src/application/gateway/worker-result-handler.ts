import type { WorkerResultCapabilityParams, WorkerResultObjectRef } from '@nexttime/shared';
import {
  MAX_OUTPUT_PROBLEMS,
  UNSTORABLE_CHAR,
  outputContractProblems,
  storableValue,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { plannerReportProblems } from '../../application/goal/index.js';
import type {
  ContractPreRejections,
  RejectedResultFact,
  RejectedResultProposal,
} from '../../application/task/index.js';
import {
  TaskOutputRejectedError,
  findWorkerRunBySessionId,
  postWorkerResult,
  readHandleObserveExclusions,
  readTaskOutputContract,
} from '../../application/task/index.js';
import {
  OperationIdentityConflictError,
  OperationNameInvalidError,
  getGatekeeper,
  listGatekeepers,
  listPublishedOperationsForGatekeepers,
  operationProposalRefusal,
} from '../../governance/gatekeepers/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';
import { boundedEcho, quotedName, redactSecrets } from '../../governance/redaction/index.js';
import { SqlGraphStore, shownObjectProperties } from '../../substrate/graph/index.js';
import {
  narrowScopeToExecutableGates,
  observeRefusal,
  operationPlatformStatus,
  readExecuteAccess,
  readGatekeeperPlatformPolicies,
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
 * One refusal leaves a record on purpose (S11 GO5d-1): a goal step's report whose `output` breaks
 * the step's output contract is refused before any write (`TaskOutputRejectedError`, 400), and
 * `dispatch.ts` records it on the Task in a transaction of its own once this one rolled back — what
 * the step's next attempt is told to fix.
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
        detail: `ObjectType ${quotedName(objectType)} is platform meta-ontology (I16)`,
      };
    }
    throw err;
  }
  return undefined;
}

/** Checks every `factsToAssert[]`/`evidence[]`/`proposedOperations[]` entry's cross-references
 *  before any write runs (§ module doc comment) and returns the per-entry refusals for
 *  `postWorkerResult` to skip and record — a model-generated entry that names a meta-ontology
 *  type (I16), a missing `objectId`, a `gatekeeperId` that is no Gatekeeper, a proposal
 *  `proposeOperation` would refuse (a new name breaking the name rule, an identity `proposerId`
 *  may not write over — review #493 on #593), or an `evidence[].factIndex` out of range costs
 *  that entry, not the Task's result. Nothing here throws for a per-entry problem;
 *  contract-level shape errors are already the capability boundary's Zod validation. */
async function validateContract(
  client: PoolClient,
  workspaceId: string,
  contract: WorkerResultCapabilityParams,
  proposerId: string,
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
      continue;
    }
    const { name } = proposal.operation;
    const refusal = await operationProposalRefusal(
      client,
      workspaceId,
      proposal.gatekeeperId,
      name,
      proposerId,
    );
    if (refusal?.reason === 'invalid_operation_name') {
      proposals.push({
        index,
        gatekeeperId: proposal.gatekeeperId,
        reason: refusal.reason,
        problem: refusal.problem,
        detail: boundedEcho(new OperationNameInvalidError(name, refusal.problem).message, 400),
      });
    } else if (refusal?.reason === 'operation_identity_conflict') {
      proposals.push({
        index,
        gatekeeperId: proposal.gatekeeperId,
        reason: refusal.reason,
        existingStatus: refusal.existingStatus,
        detail: boundedEcho(
          new OperationIdentityConflictError(proposal.gatekeeperId, name, refusal.existingStatus)
            .message,
          400,
        ),
      });
    }
  }

  return { facts, proposals, evidenceDropped };
}

/** Legacy 320: `proposedOperations[]` entries whose Operation name holds U+0000, by index, with
 *  the name as sent — the one field of the contract refused rather than escaped (see the handler). */
function unstorableProposalNames(
  contract: WorkerResultCapabilityParams,
): ReadonlyMap<number, { readonly gatekeeperId: string; readonly name: string }> {
  const found = new Map<number, { gatekeeperId: string; name: string }>();
  for (const [index, proposal] of (contract.proposedOperations ?? []).entries()) {
    if (proposal.operation.name.includes(UNSTORABLE_CHAR)) {
      found.set(index, { gatekeeperId: proposal.gatekeeperId, name: proposal.operation.name });
    }
  }
  return found;
}

/** `preRejected` plus an `invalid_operation_name` refusal for every proposal whose name held
 *  U+0000 and that `validateContract` did not already refuse for another reason — the same reason
 *  and problem the name rule gives any other control character (`operationNameProblem`). */
function withUnstorableNameRefusals(
  preRejected: ContractPreRejections,
  unstorableNames: ReadonlyMap<number, { readonly gatekeeperId: string; readonly name: string }>,
): ContractPreRejections {
  if (unstorableNames.size === 0) return preRejected;
  const refused = new Set(preRejected.proposals.map((rejection) => rejection.index));
  const added: RejectedResultProposal[] = [];
  for (const [index, { gatekeeperId, name }] of unstorableNames) {
    if (refused.has(index)) continue;
    const problem = 'invisible_or_control_characters' as const;
    added.push({
      index,
      gatekeeperId,
      reason: 'invalid_operation_name',
      problem,
      detail: boundedEcho(new OperationNameInvalidError(name, problem).message, 400),
    });
  }
  return {
    ...preRejected,
    proposals: [...preRejected.proposals, ...added].sort((a, b) => a.index - b.index),
  };
}

/**
 * The report half of a result contract — what the Worker says it did and found, written where
 * people read it (the Task's stored result and its chat card, Facts, evidence, artifacts, the
 * structured `output` the steps after a goal step read) — with
 * secret-looking values scrubbed (governance/redaction: a Worker can print its own Handle as
 * easily as an entry agent). The proposal half is passed on as sent: a proposed Operation or
 * Skill is what runs once a person approves it, so a replaced value would change what runs, and
 * both stay private drafts of the Task's on_behalf_of human until then. `sessionJsonlPath` is the
 * extension's own pointer, not model text.
 */
function scrubReport(contract: WorkerResultCapabilityParams): {
  readonly contract: WorkerResultCapabilityParams;
  readonly redactedValues: number;
} {
  const { proposedSkill, proposedOperations, sessionJsonlPath, ...report } = contract;
  // Unbounded walk: the contract already passed its schema, and the scrubbed copy is written.
  const scrubbed = redactSecrets(report, { maxNodes: Number.POSITIVE_INFINITY });
  return {
    contract: {
      ...(scrubbed.value as typeof report),
      ...(proposedSkill !== undefined ? { proposedSkill } : {}),
      ...(proposedOperations !== undefined ? { proposedOperations } : {}),
      ...(sessionJsonlPath !== undefined ? { sessionJsonlPath } : {}),
    },
    redactedValues: scrubbed.redactedValues,
  };
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

  const onBehalfOf = ctx?.principalId;
  if (!onBehalfOf) {
    throw new Error('report_task_result: caller context is required (dispatch.ts must supply it)');
  }

  const sent = params as WorkerResultCapabilityParams;
  // Legacy 320 (`HANDLERS_SETTLING_UNSTORABLE_TEXT`, dispatch.ts): the contract is the report of
  // work already done, so U+0000 in it — text Postgres cannot store — must not cost the whole
  // result (and leave the Task `running` until its run exits). It is stored as the visible `\u{0}`
  // and the count goes on the `worker_result` Activity. One exception, by field: a proposed
  // Operation *name* holding it is refused for that entry, as the name rule refuses any other
  // control character — an escaped name would be a different name than the one proposed.
  const unstorableNames = unstorableProposalNames(sent);
  const storable = storableValue(sent);
  const { contract, redactedValues } = scrubReport(storable.value);
  // S11 GO5d-1 (plan §4.5): a goal step's attempt is held to the step's output contract — the
  // output as it would be stored (scrubbed) must match the step's schema, and one is required when
  // the step declares one. Refused before anything is written (400, each place named, so the
  // Worker fixes it in its session); `dispatch.ts` then records the refused report on the Task. A
  // Task that has already ended is left to `completeTaskWithResult`'s own 409.
  const outputContract = await readTaskOutputContract(client, workspaceId, workerRun.taskId);
  if (
    outputContract &&
    outputContract.status !== 'completed' &&
    outputContract.status !== 'failed' &&
    outputContract.status !== 'cancelled'
  ) {
    const check = outputContractProblems(outputContract.outputSchema, contract.output);
    if (check.problemCount > 0) {
      throw new TaskOutputRejectedError({
        taskId: workerRun.taskId,
        output: contract.output ?? null,
        problems: check.problems,
        problemCount: check.problemCount,
        ...(outputContract.purpose === 'planning' ? { heldTo: 'planner' as const } : {}),
      });
    }
    // S11 GO9a: a goal planner's report is its proposal and nothing else, and the plan it
    // proposes passes a person's revision checks — refused the same way, each place named.
    const planner = await plannerReportProblems(client, workspaceId, workerRun.taskId, contract);
    if (planner.length > 0) {
      throw new TaskOutputRejectedError({
        taskId: workerRun.taskId,
        output: contract.output ?? null,
        problems: planner.slice(0, MAX_OUTPUT_PROBLEMS),
        problemCount: planner.length,
        heldTo: 'planner',
      });
    }
  }
  // Proposed Operations are owned by `onBehalfOf` (application/task/result.ts), so that is whose
  // own draft a proposal may revise.
  const preRejected = withUnstorableNameRefusals(
    await validateContract(client, workspaceId, contract, onBehalfOf),
    unstorableNames,
  );
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
    redactedValues,
    unstorableEscaped: storable.escaped,
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
    // Legacy 420: its `description` as every read shows an Operation's (`shownObjectProperties`,
    // the rule the graph reads apply to the Operation Object) — this list is what an agent's gate
    // tools are described from.
    operation:
      record.operation !== null && typeof record.operation === 'object'
        ? shownObjectProperties('Operation', record.operation as Record<string, unknown>)
        : record.operation,
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
 *     or the member's own AgentProfile excludes, a gate outside the observation scope of the Task
 *     a calling Worker runs (S11 GO11), or an Operation on the platform deny list, is not
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
  const platformPolicies = await readGatekeeperPlatformPolicies(client, workspaceId);
  // S11 GO11: a Worker of a scoped Task is listed only the observe tools of the gates its Task names.
  const exclusions = await readHandleObserveExclusions(client, workspaceId, {
    principalId,
    sessionId: ctx.claims?.sid,
  });

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
    const platformPolicy = platformPolicies.get(record.gatekeeperId);
    const mode = (record.operation as { mode?: string }).mode;
    const listed =
      mode === 'execute'
        ? executeGatekeepers.has(record.gatekeeperId) &&
          !operationPlatformStatus(platformPolicy, record.name).disabled
        : observeRefusal(exclusions, {
            gatekeeperId: record.gatekeeperId,
            gateEnabled: gatekeeper !== null,
            operationName: record.name,
            publishedMode: mode,
            platformPolicy,
          }) === undefined;
    if (!listed) continue;
    operations.push(toWireOperation(record, gatekeeper?.name ?? record.gatekeeperId));
  }

  return { result: { items: operations } };
};
