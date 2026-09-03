import { z } from 'zod';
import type { WorkerDefinitionKind } from './enums.js';

/**
 * worker-definition: the Zod shape of `worker_definitions.definition` (design doc §5.1.4
 * WorkerDefinition row, §9.2 `definition jsonb` — "模型白名单、prompt、skills、扩展、所需
 * capability、能力上限"; docs/development-tasks.md S2.6). `kind` (entry/worker) is **not** a field
 * of this schema — it is already the sibling `worker_definitions.kind` DB column
 * (migrations/worker/0001_worker_definitions.sql) and the `propose_worker_definition`
 * capability's own top-level `kind` param (packages/shared/src/capabilities.ts) — so the content
 * shape to validate against is chosen by `workerDefinitionContentSchemaFor(kind)`, never
 * re-derived from inside the jsonb itself (one source of truth for `kind`, not two that could
 * disagree).
 *
 * Deliberately minimal for S2.6's scope: `capabilities`/`egressDeny` (entry) and `skills` (worker)
 * are the fields S2.6's own deliverables actually consume (the entry ceiling check, entry-agent's
 * egress deny list, and S2.14's "WorkerDefinition `uses` Skill" respectively) — richer fields
 * (`gates`/`can_act_on` targets, per-Operation allowlists) are S2.4/S2.7/S2.13/S2.14 territory and
 * are not speculatively added here (B2 "write only what was asked for").
 */

/** `<provider>/<id>` — never a hard-coded default (this file, like every other, names no real
 *  provider or model id): a workspace sets this via `create-workspace --entry-model` or a later
 *  `propose_worker_definition` call, never a value baked into checked-in YAML. */
export const WorkerDefinitionModelSchema = z.string().min(1);

const WorkerDefinitionContentBaseSchema = z.object({
  /** The system prompt pi is launched with (§7.2 "--system-prompt 来自该用户入口 WorkerDefinition
   *  的已发布版本"). Required — a WorkerDefinition with no prompt is not a usable definition. */
  systemPrompt: z.string().min(1),
  /** Left empty in the checked-in `ontology/*.yaml` templates; a workspace sets it (§7.7 "厂商与
   *  模型是配置", never a platform-wide default). */
  model: WorkerDefinitionModelSchema.optional(),
});

/** `kind='entry'` content (design doc §5.1.4 "entry 类的能力上限"). `capabilities` must be a subset
 *  of `governance/capability/handles.ts`'s `entryScope()` ceiling — checked by the kernel service
 *  (`application/worker/definitions.ts`), not by this pure schema, since the ceiling is runtime
 *  data derived from the capability registry, not something a Zod shape alone can express. */
export const EntryWorkerDefinitionContentSchema = WorkerDefinitionContentBaseSchema.extend({
  capabilities: z.array(z.string().min(1)),
  /** Egress deny-list seeded empty in the checked-in template (§7.9 "按 WorkerDefinition 的允许/
   *  拒绝清单过滤"); platform-specific, so never pre-populated with real hostnames here. */
  egressDeny: z.array(z.string().min(1)).optional(),
}).strict();
export type EntryWorkerDefinitionContent = z.infer<typeof EntryWorkerDefinitionContentSchema>;

/** `kind='worker'` content. `skills` names published Skills this definition `uses` (§5.1.4 "Skill
 *  ... WorkerDefinition uses Skill，容器启动时装载", S2.14) — referenced by name/id only; resolving
 *  and mounting them is S2.14's job. */
export const WorkerWorkerDefinitionContentSchema = WorkerDefinitionContentBaseSchema.extend({
  skills: z.array(z.string().min(1)).optional(),
}).strict();
export type WorkerWorkerDefinitionContent = z.infer<typeof WorkerWorkerDefinitionContentSchema>;

export type WorkerDefinitionContent = EntryWorkerDefinitionContent | WorkerWorkerDefinitionContent;

/** Picks the kind-specific content schema (see this module's doc comment for why `kind` itself is
 *  never a field inside the schema being picked). */
export function workerDefinitionContentSchemaFor(
  kind: WorkerDefinitionKind,
): typeof EntryWorkerDefinitionContentSchema | typeof WorkerWorkerDefinitionContentSchema {
  return kind === 'entry'
    ? EntryWorkerDefinitionContentSchema
    : WorkerWorkerDefinitionContentSchema;
}
