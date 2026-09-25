import { z } from 'zod';
import { OperationSchema } from './action-description.js';
import { ProposeSkillContentSchema } from './skill.js';

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

/** S8 W5-A (leftover 74): the container `report_result` runs inside exits with the WorkerRun, so
 *  `path` alone (the in-container location, `/workspace/*` — `${NEXTTIME_DATA}/workspaces/tasks/
 *  <task_id>/` on the host, S2.8) stops resolving to anything the moment the container is gone —
 *  the entry agent's later read and the task page both failed on exactly this. `content` is the
 *  fix: the Worker inlines the artifact's own text into the contract, the same way `evidence[]`
 *  already inlines command output — recorded verbatim on the Task's stored result (never the
 *  filesystem; the kernel still never touches a Worker's workspace mount, matching every other
 *  field of this contract). `ARTIFACT_CONTENT_MAX_CHARS` bounds one artifact, `MAX_ARTIFACTS_PER_
 *  CONTRACT` how many a single contract may carry — together they cap one Task row's worst case
 *  (a few hundred KB), not the whole-contract 16 000-char gate-tool-result truncation `platform-
 *  extension/src/modes/gate-tools.ts`'s `truncateToolResult` applies to what the *model* sees.
 *  `content` is optional (text only, per the ops-runner prompt) — an artifact the Worker could not
 *  or chose not to inline (binary, or larger than the cap) keeps `path` alone as a description of
 *  what was produced, honestly unopenable once the container is gone; the web task page renders
 *  that case as "not retrievable" rather than pretending `path` still resolves to anything.
 *
 *  Storing this on the Task's own row (design decision, not `sources`/a new epistemic Source) —
 *  weighed and rejected: `sources` models epistemic *inputs* a Fact's origin can be compared
 *  against (`resolveFactOrigin`, visibility/identity/observation-window machinery that assumes a
 *  Source stays semantically an input, e.g. the `worker_session` transcript precedent), not a
 *  Task's own output artifact — coercing "a report a Worker wrote" into that shape would be exactly
 *  the "database accidentally defines the domain" drift the platform avoids elsewhere. `tasks` has
 *  no per-row visibility rule (migrations/task/0001_tasks.sql: workspace-wide, unconditionally) —
 *  the same visibility every other contract field (`summary`/`findings`/Facts, W5.5) already has,
 *  so artifacts inherit it for free, with no new visibility flag to get wrong. A host-volume path +
 *  a kernel read capability (the other option this task weighed) was rejected outright: it would be
 *  the first kernel-process filesystem access into a Worker's workspace mount, which
 *  `substrate/epistemic/sources.ts`'s own doc comment calls out as a property no kernel process
 *  needs today — not a boundary worth opening for this. */
export const ARTIFACT_CONTENT_MAX_CHARS = 32_000;
export const MAX_ARTIFACTS_PER_CONTRACT = 8;

/** One `artifacts[]` entry — a path under the Task's workspace directory (`/workspace` inside the
 *  Worker container; `${NEXTTIME_DATA}/workspaces/tasks/<task_id>/` on the host, S2.8), plus its
 *  own inlined text content when the Worker chose to submit one (see this schema's own doc
 *  comment above). Recorded verbatim on the Task's stored result — the kernel never touches the
 *  filesystem itself. */
export const WorkerResultArtifactSchema = z
  .object({
    path: z.string().min(1),
    description: z.string().optional(),
    content: z.string().max(ARTIFACT_CONTENT_MAX_CHARS).optional(),
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
 * The model-facing contract (`report_result` pi tool params). `proposedSkill` (S2.14) is
 * {@link ProposeSkillContentSchema} — the same shape `propose_skill` itself takes — rather than an
 * opaque `jsonRecord`: S2.9 left it opaque because no Skill draft service existed yet ("inventing
 * one now would define S2.14's own ontology decisions... out from under it" — this file's prior
 * doc comment); S2.14 *is* that service, so the seam is now filled in with its real shape.
 * `application/task/result.ts`'s `postWorkerResult` forwards it verbatim to `proposeSkill`
 * (`application/worker/skills.ts`), owned by the Task's `on_behalf_of` principal.
 */
export const WorkerResultContractSchema = z
  .object({
    summary: z.string(),
    findings: z.array(z.string()).optional(),
    factsToAssert: z.array(WorkerResultFactSchema).optional(),
    evidence: z.array(WorkerResultEvidenceSchema).optional(),
    artifacts: z.array(WorkerResultArtifactSchema).max(MAX_ARTIFACTS_PER_CONTRACT).optional(),
    proposedSkill: ProposeSkillContentSchema.optional(),
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
