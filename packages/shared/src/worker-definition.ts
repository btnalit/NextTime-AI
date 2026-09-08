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
 *
 * S2.7 addition: `name`/`description` (both kinds — `find_workers`'s ranking, `substrate/graph/
 * find-means.ts`, needs *some* human-readable text to match a `need` query against; the graph
 * projection of a WorkerDefinition Object otherwise carries only `{kind}`,
 * `substrate/ontology/meta-objects.ts`) and, for `kind='worker'`, `capabilities`/`gates` — the
 * WorkerDefinition's own declared needs `application/task/invoke.ts`'s child-Handle minting
 * requires (design doc §5.1.4 "WorkerDefinition --requires--> Capability",
 * "WorkerDefinition --can_act_on--> Gatekeeper"). `capabilities`/`gates` are both optional and
 * default to the platform's fixed worker ceiling / no gates respectively when omitted — see
 * `governance/capability/handles.ts`'s `WORKER_CEILING_CAPABILITIES` and
 * `application/task/invoke.ts`'s `computeChildHandleScope` for exactly how they are consumed.
 *
 * feat/egress-definition-lists addition: `egressDeny` is no longer entry-only — both kind-specific
 * schemas below now carry it (design doc §7.9 names both "WorkerRun" and "入口会话" as targets of a
 * WorkerDefinition's own allow/deny list). Still deny-list only, both kinds: `egressAllow` is not
 * part of the domain today — neither schema below defines it, and nothing in this change invents
 * it.
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
  /** S2.7: human-readable name/summary, purely for `find_workers`/`find_operations`/
   *  `find_procedures` text-match ranking (`substrate/graph/find-means.ts`) — never interpreted by
   *  the kernel otherwise. Optional; a definition with neither is still valid, just less
   *  discoverable by a text `need` query (it remains discoverable by `list_worker_definitions` and
   *  by direct `definitionId`). */
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

/** `kind='entry'` content (design doc §5.1.4 "entry 类的能力上限"). `capabilities` must be a subset
 *  of `governance/capability/handles.ts`'s `entryScope()` ceiling — checked by the kernel service
 *  (`application/worker/definitions.ts`), not by this pure schema, since the ceiling is runtime
 *  data derived from the capability registry, not something a Zod shape alone can express. */
export const EntryWorkerDefinitionContentSchema = WorkerDefinitionContentBaseSchema.extend({
  capabilities: z.array(z.string().min(1)),
  /** Egress deny-list seeded empty in the checked-in template (§7.9 "按 WorkerDefinition 的允许/
   *  拒绝清单过滤"); platform-specific, so never pre-populated with real hostnames here. Semantics:
   *  a hostname or a `.suffix` entry (matches the host and every subdomain), case-insensitive;
   *  literal IPs/CIDRs are not part of this list — the egress proxy's own built-in private-range
   *  denial already covers those (`packages/egress-proxy/src/policy.ts`). Same field, same
   *  semantics, on `WorkerWorkerDefinitionContentSchema` below (feat/egress-definition-lists). */
  egressDeny: z.array(z.string().min(1)).optional(),
}).strict();
export type EntryWorkerDefinitionContent = z.infer<typeof EntryWorkerDefinitionContentSchema>;

/**
 * `kind='worker'` content. `skills` names published Skills this definition `uses` (§5.1.4 "Skill
 * ... WorkerDefinition uses Skill，容器启动时装载", S2.14) — referenced by name/id only; resolving
 * and mounting them is S2.14's job.
 *
 * `capabilities`/`gates` (S2.7): the WorkerDefinition's own declared needs — what
 * `application/task/invoke.ts`'s `invokeWorker` must be able to prove the calling Handle already
 * holds before minting a child Handle for a WorkerRun of this definition (never granted "for
 * free" — see `governance/capability/handles.ts`'s module doc comment on `WORKER_CEILING_
 * CAPABILITIES` for the exact rule, including why an execute-class capability here can never be
 * silently dropped). `capabilities` omitted defaults to the full worker ceiling *minus* every
 * execute-class capability (least-privilege: a definition that never says it needs to act on a
 * system gets an observe/propose-only Handle); `gates` (Gatekeeper Object ids this definition
 * `can_act_on`) omitted defaults to no gates at all.
 *
 * `egressDeny` (feat/egress-definition-lists): same shape and semantics as the entry schema's own
 * field below — design doc §7.9 "按来源容器解析到 WorkerRun / 入口会话，套用其 WorkerDefinition 的允许 /
 * 拒绝清单" names *both* WorkerRun and entry session as targets of a WorkerDefinition's own egress
 * list, not entry alone. Added here (S2.6 originally scoped this field to `kind='entry'` only —
 * see this schema's own "rejects an entry-only field" test history) once a real consumer existed:
 * `application/task/spawn.ts` forwards a `kind='worker'` WorkerDefinition's own `egressDeny` into
 * the spawned WorkerRun container's source-map registration, narrowing that Task's own egress on
 * top of (never in place of) the platform's fixed deny list — never a widening. Optional; a
 * WorkerDefinition with none behaves exactly as before this field existed.
 */
export const WorkerWorkerDefinitionContentSchema = WorkerDefinitionContentBaseSchema.extend({
  skills: z.array(z.string().min(1)).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  gates: z.array(z.string().min(1)).optional(),
  egressDeny: z.array(z.string().min(1)).optional(),
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
