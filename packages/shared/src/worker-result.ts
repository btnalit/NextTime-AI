import { z } from 'zod';
import { OperationSchema } from './action-description.js';

/**
 * worker-result: the Zod shape of the S2.9 result contract (design doc §7.3 "结果契约: Worker
 * 结束时返回结构化结果 {summary, findings, facts_to_assert[], evidence[], artifacts[],
 * proposed_skill?, proposed_operations?}"; docs/development-tasks.md S2.9). Field names follow
 * this package's established camelCase convention (`report_turn`'s own doc comment in
 * capabilities.ts), not the design doc's snake_case prose.
 *
 * Two schemas share this one base:
 *   - {@link WorkerResultContractSchema} — what the pi `report_result` tool exposes to the model
 *     (`packages/platform-extension/src/modes/worker.ts`).
 *   - the `report_task_result` capability's registered `paramsSchema` (capabilities.ts) —
 *     `WorkerResultContractSchema.extend({ sessionJsonlPath })`: a strict superset the *extension*
 *     fills in itself after the model's tool call resolves (never LLM-supplied — the model never
 *     sees or controls its own session file's path).
 */

const id = z.string().uuid();
const jsonRecord = z.record(z.string(), z.unknown());

/**
 * A Fact's endpoint: either a reference to an existing Object (`objectId`), or a request to
 * upsert-by-identity a new/existing one (`objectType`/`identity`/`properties?` — the same
 * `{objectType, identity, properties}` candidate shape `application/gateway/observed-facts.ts`'s
 * `writeObservedFacts` already established for "a gate result names an Object the Worker has not
 * necessarily seen a graph id for yet"). A bare `objectId` is validated to actually exist (and to
 * not be a protected meta-ontology type, I16) by the kernel handler before any write — see
 * `application/task/result.ts`.
 */
export const WorkerResultObjectRefSchema = z.union([
  z.object({ objectId: id }).strict(),
  z
    .object({
      objectType: z.string().min(1),
      identity: jsonRecord,
      properties: jsonRecord.optional(),
    })
    .strict(),
]);
export type WorkerResultObjectRef = z.infer<typeof WorkerResultObjectRefSchema>;

/** One `facts_to_assert[]` entry — a Link between two Object refs, written as an `inferred` Fact
 *  (I3, §5.6: agent-authored) under the contract's shared `worker_result` Activity. */
export const WorkerResultFactSchema = z
  .object({
    linkType: z.string().min(1),
    source: WorkerResultObjectRefSchema,
    target: WorkerResultObjectRefSchema,
    properties: jsonRecord.optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type WorkerResultFact = z.infer<typeof WorkerResultFactSchema>;

/** One `evidence[]` entry — supporting material for the contract's Facts (`evidence` table,
 *  `link_id` FK). `factIndex` names one `facts_to_assert[]` entry by position; omitted attaches
 *  this evidence to *every* Fact the same contract writes (the common case: one contract, one
 *  batch of mutually-supporting facts). The full array is always additionally carried in the
 *  `worker_result` Activity's own `metadata.evidence` (design doc §7.3 "把证据挂到 Activity") —
 *  see `application/task/result.ts`'s module doc comment for why the `evidence` table alone
 *  cannot represent an Activity-level attachment. */
export const WorkerResultEvidenceSchema = z
  .object({
    kind: z.string().min(1),
    content: jsonRecord,
    factIndex: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkerResultEvidence = z.infer<typeof WorkerResultEvidenceSchema>;

/** One `artifacts[]` entry — a path under the Task's workspace directory (`/workspace` inside the
 *  Worker container; `${NEXTTIME_DATA}/workspaces/tasks/<task_id>/` on the host, S2.8). Recorded
 *  verbatim on the Task's stored result — the kernel never touches the filesystem itself. */
export const WorkerResultArtifactSchema = z
  .object({
    path: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();
export type WorkerResultArtifact = z.infer<typeof WorkerResultArtifactSchema>;

/** One `proposed_operations[]` entry — forwarded verbatim to the existing
 *  `governance/gatekeepers/manifest.ts` `proposeOperation` service (S2.4), draft-only (I16). */
export const WorkerResultProposedOperationSchema = z
  .object({
    gatekeeperId: id,
    operation: OperationSchema,
  })
  .strict();
export type WorkerResultProposedOperation = z.infer<typeof WorkerResultProposedOperationSchema>;

/**
 * The model-facing contract (`report_result` pi tool params). `proposedSkill` is deliberately an
 * opaque `jsonRecord` — there is no Skill draft service yet (S2.14, downstream of S2.9); the
 * kernel stores it verbatim on `tasks.result` and does not project it into the graph (see
 * `application/task/result.ts`'s own doc comment — this is a documented seam for S2.14, not an
 * oversight).
 */
export const WorkerResultContractSchema = z
  .object({
    summary: z.string(),
    findings: z.array(z.string()).optional(),
    factsToAssert: z.array(WorkerResultFactSchema).optional(),
    evidence: z.array(WorkerResultEvidenceSchema).optional(),
    artifacts: z.array(WorkerResultArtifactSchema).optional(),
    proposedSkill: jsonRecord.optional(),
    proposedOperations: z.array(WorkerResultProposedOperationSchema).optional(),
  })
  .strict();
export type WorkerResultContract = z.infer<typeof WorkerResultContractSchema>;

/** The `report_task_result` capability's full wire shape — the model-facing contract plus the
 *  extension-computed session pointer (never LLM-supplied, see this module's own doc comment). */
export const WorkerResultCapabilityParamsSchema = WorkerResultContractSchema.extend({
  /** Absolute path to the Worker's own pi session JSONL inside its workspace mount
   *  (`ctx.sessionManager.getSessionFile()`), when known — the session-JSONL-as-Source path
   *  (design doc §7.3 "会话 JSONL 回流为私有 Source"). A relative/relative-looking value is stored
   *  verbatim as `sources.uri`; the kernel never reads the file itself (I9-adjacent: no kernel
   *  process ever needs filesystem access to a Worker's workspace). */
  sessionJsonlPath: z.string().min(1).optional(),
}).strict();
export type WorkerResultCapabilityParams = z.infer<typeof WorkerResultCapabilityParamsSchema>;
