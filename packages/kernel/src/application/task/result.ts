import type { WorkerResultCapabilityParams, WorkerResultObjectRef } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { proposeOperation } from '../../governance/gatekeepers/index.js';
import {
  attachEvidence,
  endActivity,
  recordSourceObservation,
  registerPrivateSource,
  startActivity,
} from '../../substrate/epistemic/index.js';
import type { Fact } from '../../substrate/graph/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { proposeSkill } from '../worker/index.js';
import { completeTaskWithResult } from './lifecycle.js';
import type { TaskRow } from './types.js';

/**
 * application/task/result: the S2.9 result-contract write path (design doc §7.3 "Worker 结束时
 * 返回结构化结果 ... 内核把 facts_to_assert 以 inferred 状态写入、把证据挂到 Activity...";
 * docs/development-tasks.md S2.9 deliverable C). This is the pure write half — authorization
 * (matching the calling Handle's `claims.sid` to the addressed Task's own WorkerRun, I16 on every
 * referenced Object) is `application/gateway/worker-result-handler.ts`'s job, run *before*
 * `postWorkerResult` is ever called; this module trusts its `taskId`/`workerRunId`/`actorPrincipalId`
 * inputs are already correct (same split `application/gateway/request-action-handler.ts` and
 * `governance/approval` already establish: gateway resolves identity and authorizes, the service it
 * calls just writes).
 *
 * **Why `evidence[]` lands in the Activity's `metadata`, not only the `evidence` table**: the
 * `evidence` table (`substrate/epistemic/evidence.ts`) has `link_id not null` — it is Fact-scoped
 * by schema, not Activity-scoped, even though the design doc's own prose says "证据挂到 Activity".
 * `postWorkerResult` satisfies the literal Activity-level requirement by always writing the full
 * `evidence[]` array into the `worker_result` Activity's `metadata.evidence` (surfaced by `explain`
 * via `substrate/epistemic/explain.ts`'s `ExplainActivityRef.metadata`, S2.9 addition) — including
 * when `factsToAssert` is empty, so evidence is never silently dropped just because there was
 * nothing to attach a `evidence` table row to. It *additionally* writes a real `evidence` row per
 * Fact (via `attachEvidence`) when there is at least one Fact to attach to — `evidence[].factIndex`
 * names one `facts_to_assert[]` entry by position; omitted attaches to every Fact this same
 * contract wrote (never an N×M cross product beyond that).
 *
 * **`proposedSkill` (S2.14) becomes a real draft Skill**: `postWorkerResult` forwards it verbatim
 * to `application/worker/skills.ts`'s `proposeSkill`, owned by `actorPrincipalId` (the Task's
 * `on_behalf_of` principal — resolved by the gateway handler from the calling Handle's `claims.obo`,
 * same as every other Fact this function writes, see `PostWorkerResultInput.actorPrincipalId`'s own
 * doc comment). This is *in addition to*, not instead of, the verbatim copy already retained on
 * `tasks.result` (via `completeTaskWithResult` below) — a human reading the Task's raw result and
 * `list_skills` finding the new draft are two independent, both-true outcomes of the same field.
 * `proposedSkill` failing to propose (a defensive-only path — its shape is already Zod-validated at
 * the capability boundary, `packages/shared/src/worker-result.ts`'s `WorkerResultContractSchema`)
 * is treated the same as every other write this function performs: it is not caught here, so it
 * propagates and rolls back the whole contract — a Worker's result is either written completely or
 * not at all, never partially.
 */

const graphStore = new SqlGraphStore();

export interface PostWorkerResultInput {
  /** The `on_behalf_of` principal — becomes the Activity's `started_by`, every written Fact's
   *  `asserted_by` (as `kind: 'agent'`, deriving `epistemic_status: 'inferred'`, §5.6), and every
   *  proposed Operation's `proposed_by`. Resolved by the caller (the gateway handler) from the
   *  calling Handle's own `claims.obo` — never re-derived here. */
  readonly actorPrincipalId: string;
  readonly taskId: string;
  readonly workerRunId: string;
  readonly contract: WorkerResultCapabilityParams;
}

export interface PostWorkerResultOutcome {
  readonly task: TaskRow;
  readonly activityId: string;
  readonly factIds: readonly string[];
}

/** Resolves one `WorkerResultObjectRef` to a concrete Object id — upserting a new/existing Object
 *  by identity for the `{objectType, identity, properties?}` form (mirrors `application/gateway/
 *  observed-facts.ts`'s `writeObservedFacts` candidate handling), or using the given id verbatim
 *  for the `{objectId}` form (already confirmed to exist and to not name a protected meta-ontology
 *  type by the gateway handler's own validation pass — see this module's doc comment). */
async function resolveObjectRef(
  client: PoolClient,
  workspaceId: string,
  ref: WorkerResultObjectRef,
): Promise<string> {
  if ('objectId' in ref) return ref.objectId;
  const object = await graphStore.upsertObject(client, workspaceId, {
    objectType: ref.objectType,
    identity: ref.identity,
    properties: ref.properties ?? {},
  });
  return object.id;
}

/**
 * Writes one S2.9 result contract into the graph and completes the Task (`lifecycle.ts`'s
 * `completeTaskWithResult` seam). Everything below runs on the caller's own already-open
 * transaction (`client`) — same convention as every other capability-handler-adjacent service in
 * this codebase.
 */
export async function postWorkerResult(
  client: PoolClient,
  workspaceId: string,
  input: PostWorkerResultInput,
): Promise<PostWorkerResultOutcome> {
  const { actorPrincipalId, contract } = input;

  const activityMetadata: Record<string, unknown> = {
    taskId: input.taskId,
    workerRunId: input.workerRunId,
  };
  if (contract.evidence && contract.evidence.length > 0) {
    activityMetadata.evidence = contract.evidence;
  }

  const activity = await startActivity(client, workspaceId, {
    kind: 'worker_result',
    principalId: actorPrincipalId,
    metadata: activityMetadata,
  });

  try {
    // facts_to_assert -> inferred Facts under this Activity (I3, §5.6 agent -> inferred).
    const writtenFacts: Fact[] = [];
    for (const factInput of contract.factsToAssert ?? []) {
      const sourceObjectId = await resolveObjectRef(client, workspaceId, factInput.source);
      const targetObjectId = await resolveObjectRef(client, workspaceId, factInput.target);
      const fact = await graphStore.assertFact(
        client,
        workspaceId,
        { id: actorPrincipalId, kind: 'agent' },
        {
          linkType: factInput.linkType,
          sourceObjectId,
          targetObjectId,
          activityId: activity.id,
          properties: factInput.properties,
          confidence: factInput.confidence,
        },
      );
      writtenFacts.push(fact);
    }

    // evidence[] -> a real `evidence` row per targeted Fact (already carried on the Activity's own
    // metadata above regardless of whether there is any Fact to attach to).
    for (const evidenceInput of contract.evidence ?? []) {
      const targets =
        evidenceInput.factIndex !== undefined
          ? [writtenFacts[evidenceInput.factIndex]].filter(
              (fact): fact is Fact => fact !== undefined,
            )
          : writtenFacts;
      for (const fact of targets) {
        await attachEvidence(client, workspaceId, {
          linkId: fact.id,
          kind: evidenceInput.kind,
          content: evidenceInput.content,
          createdBy: actorPrincipalId,
        });
      }
    }

    // session JSONL -> a private Source, observed by this Activity (§7.3 "会话 JSONL 回流为私有
    // Source"). The kernel never reads the file itself — `uri` is a pointer.
    if (contract.sessionJsonlPath) {
      const source = await registerPrivateSource(client, workspaceId, {
        kind: 'worker_session',
        ownerPrincipalId: actorPrincipalId,
        uri: contract.sessionJsonlPath,
        metadata: { taskId: input.taskId, workerRunId: input.workerRunId },
      });
      await recordSourceObservation(client, workspaceId, {
        sourceId: source.id,
        activityId: activity.id,
      });
    }

    // proposed_operations -> the existing propose_operation service (S2.4), draft-only (I16).
    for (const proposal of contract.proposedOperations ?? []) {
      const proposalActivity = await startActivity(client, workspaceId, {
        kind: 'operation_proposal',
        principalId: actorPrincipalId,
        metadata: { gatekeeperId: proposal.gatekeeperId, operation: proposal.operation.name },
      });
      await proposeOperation(client, workspaceId, {
        gatekeeperId: proposal.gatekeeperId,
        operation: proposal.operation,
        proposedBy: { id: actorPrincipalId, kind: 'agent' },
        activityId: proposalActivity.id,
      });
      await endActivity(client, workspaceId, proposalActivity.id, 'completed');
    }

    // proposed_skill -> a real draft Skill (S2.14), owned by the Task's on_behalf_of principal —
    // see this module's doc comment. Drafts are private to their proposer by construction
    // (`skills.ts`'s own I16 read-privacy note), so nothing further is needed here to keep it
    // private to `actorPrincipalId` alone.
    const proposedSkillRecord = contract.proposedSkill
      ? await proposeSkill(client, workspaceId, actorPrincipalId, contract.proposedSkill)
      : undefined;

    await endActivity(client, workspaceId, activity.id, 'completed');

    const storedResult = {
      summary: contract.summary,
      findings: contract.findings ?? [],
      factIds: writtenFacts.map((fact) => fact.id),
      artifacts: contract.artifacts ?? [],
      proposedSkill: contract.proposedSkill,
      proposedSkillId: proposedSkillRecord?.id,
      proposedOperations: contract.proposedOperations ?? [],
      activityId: activity.id,
    };

    const task = await completeTaskWithResult(
      client,
      workspaceId,
      actorPrincipalId,
      input.taskId,
      input.workerRunId,
      storedResult,
    );

    return { task, activityId: activity.id, factIds: writtenFacts.map((fact) => fact.id) };
  } catch (err) {
    await endActivity(client, workspaceId, activity.id, 'failed').catch(() => {
      // Best-effort — the outer error is the one that matters; a failed endActivity here must
      // never mask it (same convention `request-action-handler.ts`'s runObserve uses).
    });
    throw err;
  }
}
