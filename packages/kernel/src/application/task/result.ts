import type { WorkerResultCapabilityParams, WorkerResultObjectRef } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { proposeOperation } from '../../governance/gatekeepers/index.js';
import {
  attachEvidence,
  endActivity,
  recordSourceObservation,
  registerPrivateSource,
  registerSource,
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
 * `postWorkerResult` is ever called; this module trusts its `taskId`/`workerRunId`/
 * `actorPrincipalId`/`agentPrincipalId` inputs are already correct (same split
 * `application/gateway/request-action-handler.ts` and `governance/approval` already establish:
 * gateway resolves identity and authorizes, the service it calls just writes).
 *
 * **Agent-principal attribution (design decision replacing PR #84's `CallerPrincipal.viaAgent`
 * downgrade flag)**: every contract Fact is `asserted_by` `agentPrincipalId` — the (workspace,
 * WorkerDefinition) agent principal `spawn.ts`'s `ensureWorkerAgentPrincipal` resolved when this
 * WorkerRun was created (migrations/core/0014_worker_agent_principals.sql,
 * migrations/task/0004_worker_run_agent_principal.sql) — and the `worker_result` Activity's own
 * `started_by` is that same agent principal, not `actorPrincipalId`. `deriveEpistemicStatus`
 * (substrate/graph/store.ts) then derives `inferred` from the real `kind='agent'` row, the same way
 * every other caller kind already works — no downgrade flag needed. `actorPrincipalId` (the Task's
 * `on_behalf_of` human) is not dropped: it is recorded as **provenance, not assertion** —
 * `activity.metadata.onBehalfOf` — so `explain()` can show both "which agent wrote this" and "on
 * behalf of which human" (`substrate/epistemic/explain.ts`'s `ExplainActivityRef`).
 *
 * **Asymmetry, deliberate**: proposals (`proposedOperations` → `proposeOperation`, `proposedSkill`
 * → `proposeSkill`) stay owned by `actorPrincipalId`, the human — *not* re-pointed at the agent
 * principal like Facts/Activity above. I16 ("平台元本体对象只能经 human 通道发布；Handle 通道只能写对
 * 提议者私有的草稿") requires a private draft to remain visible/publishable by the human who is
 * ultimately accountable for it; an agent-owned draft would be invisible to `listSkills`/
 * `list_pending`-style reads scoped to the calling human (see this file's own
 * `proposedSkill`-ownership test in worker-result.integration.test.ts). In short: **the agent
 * asserts Facts; the human owns drafts.**
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
 * `on_behalf_of` principal — resolved by the gateway handler from the calling Handle's `claims.obo`;
 * see the "Asymmetry, deliberate" paragraph above and `PostWorkerResultInput.actorPrincipalId`'s own
 * doc comment for why this stays human-owned unlike the Facts this function writes). This is *in
 * addition to*, not instead of, the verbatim copy already retained on
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
  /** The Task's `on_behalf_of` human principal — recorded as **provenance** on the `worker_result`
   *  Activity (`metadata.onBehalfOf`), and still the owner of every proposed Operation/Skill draft
   *  (I16 — see this module's own doc comment on the asymmetry). No longer the Fact `asserted_by`
   *  or the Activity `started_by` — see `agentPrincipalId` below. Resolved by the caller (the
   *  gateway handler) from the calling Handle's own `claims.obo` — never re-derived here. */
  readonly actorPrincipalId: string;
  /** The (workspace, WorkerDefinition) agent principal (`spawn.ts`'s `ensureWorkerAgentPrincipal`,
   *  read off the WorkerRun row by the caller) — becomes the `worker_result` Activity's
   *  `started_by` and every written Fact's `asserted_by`, deriving `epistemic_status: 'inferred'`
   *  from its real `kind='agent'` row (§5.6). */
  readonly agentPrincipalId: string;
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
  const { actorPrincipalId, agentPrincipalId, contract } = input;

  const activityMetadata: Record<string, unknown> = {
    taskId: input.taskId,
    workerRunId: input.workerRunId,
    // Provenance, not assertion — see this module's own doc comment on the agent/human split.
    onBehalfOf: actorPrincipalId,
  };
  if (contract.evidence && contract.evidence.length > 0) {
    activityMetadata.evidence = contract.evidence;
  }

  const activity = await startActivity(client, workspaceId, {
    kind: 'worker_result',
    principalId: agentPrincipalId,
    metadata: activityMetadata,
  });

  try {
    // The session transcript (§7.3 "会话 JSONL 回流为私有 Source"), when the run shipped one, is a
    // *private* `worker_session` Source owned by the on_behalf_of human — and it is deliberately
    // observed on its own `worker_session` Activity below, never on the `worker_result` Activity
    // that carries the Facts. `link_visible_to_caller` (migrations/core/0013) hides every Fact of
    // an Activity that observes any private Source the caller does not own, so a transcript
    // Observation on the Fact Activity would make the run's results private to one person. The
    // kernel never reads the file itself — `uri` is a pointer.
    const transcriptSource = contract.sessionJsonlPath
      ? await registerPrivateSource(client, workspaceId, {
          kind: 'worker_session',
          ownerPrincipalId: actorPrincipalId,
          uri: contract.sessionJsonlPath,
          metadata: { taskId: input.taskId, workerRunId: input.workerRunId },
        })
      : null;

    // This WorkerRun as an epistemic Source, recorded on the Activity *before* any Fact is
    // asserted (W5.5, docs/code-review-2026-09-10.md §2.1 / STATUS leftover 16). Order is
    // load-bearing: `SqlGraphStore.assertFact` decides same-origin (supersede) vs different-origin
    // (Conflict) through `resolveFactOrigin`, which reads the Observations already on this
    // Activity — with nothing recorded yet it fell back to the asserting principal, and the agent
    // principal is one per (workspace, WorkerDefinition), so two runs of the same definition
    // contradicting each other were silently superseded instead of opening a Conflict. Same
    // pattern `application/gateway/ingest-handlers.ts`'s `submit_observations` already uses.
    //
    // Always `workspace`-visible (product decision 2026-09-10, STATUS W5.5 closeout): a Worker's
    // `factsToAssert` are workspace knowledge — "所有 agent 共享同一份图" — whether or not a
    // transcript exists. Before this, a run with a transcript had its Facts hidden from everyone
    // but the on_behalf_of human purely because the transcript Source sat on the same Activity.
    const runSource = await registerSource(client, workspaceId, {
      kind: 'worker_run',
      ownerPrincipalId: actorPrincipalId,
      visibility: 'workspace',
      metadata: {
        taskId: input.taskId,
        workerRunId: input.workerRunId,
        ...(transcriptSource ? { transcriptSourceId: transcriptSource.id } : {}),
      },
    });
    const runObservation = await recordSourceObservation(client, workspaceId, {
      sourceId: runSource.id,
      activityId: activity.id,
    });

    // The transcript's own Activity: keeps the private Source reachable through
    // `explain(activityId).observations[].source` for its owner without touching Fact visibility
    // (see above). Linked both ways through metadata so either side can be found from the other.
    if (transcriptSource) {
      const transcriptActivity = await startActivity(client, workspaceId, {
        kind: 'worker_session',
        principalId: agentPrincipalId,
        metadata: {
          taskId: input.taskId,
          workerRunId: input.workerRunId,
          onBehalfOf: actorPrincipalId,
          resultActivityId: activity.id,
          sourceId: transcriptSource.id,
        },
      });
      await recordSourceObservation(client, workspaceId, {
        sourceId: transcriptSource.id,
        activityId: transcriptActivity.id,
      });
      await endActivity(client, workspaceId, transcriptActivity.id, 'completed');
    }

    // facts_to_assert -> Facts under this Activity (I3). epistemic_status: `inferred` (§5.6 — a
    // Worker is an agent), derived the ordinary way — `agentPrincipalId` is a real `kind='agent'`
    // principals row (`spawn.ts`'s `ensureWorkerAgentPrincipal`), so `SqlGraphStore.assertFact`'s
    // own `resolveCallerKind` finds `kind='agent'` and `deriveEpistemicStatus` does the rest. No
    // downgrade flag needed (replaces PR #84's `CallerPrincipal.viaAgent`, see this module's own
    // doc comment). `observationId` (migrations/core/0018) points every Fact at this run's
    // Observation so `explain(factId)` narrows to it.
    const writtenFacts: Fact[] = [];
    for (const factInput of contract.factsToAssert ?? []) {
      const sourceObjectId = await resolveObjectRef(client, workspaceId, factInput.source);
      const targetObjectId = await resolveObjectRef(client, workspaceId, factInput.target);
      const fact = await graphStore.assertFact(
        client,
        workspaceId,
        { id: agentPrincipalId },
        {
          linkType: factInput.linkType,
          sourceObjectId,
          targetObjectId,
          activityId: activity.id,
          properties: factInput.properties,
          confidence: factInput.confidence,
          observationId: runObservation.id,
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
