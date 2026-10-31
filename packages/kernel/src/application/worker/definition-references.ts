import type { WorkerDefinitionKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { WORKER_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { existingGatekeeperIds } from '../../governance/gatekeepers/index.js';
import { resolvePublishedSkills } from './skills.js';

/**
 * application/worker/definition-references (legacy 302): a WorkerDefinition is published only when
 * what it names is there. A Worker's run reads its definition's references and leaves out, without
 * a word, what does not resolve: a capability outside the worker ceiling (`computeChildHandleScope`,
 * `application/task/handle-mint.ts`), a Skill that is not published (`resolveSkillsInline`), and a
 * gate no Gatekeeper answers to holds nothing a Handle can use. So a typo, a deprecated Skill or a
 * gate that was never there showed only when a Worker ran without it — and S11's goal steps compose
 * Workers from these references directly. Publishing checks them instead, all at once, so the one
 * refusal names every reference that does not resolve, by field:
 *   - `capabilities` (kind `worker`): a name in the worker ceiling (`WORKER_CEILING_CAPABILITIES`,
 *     the set a run narrows a declaration against — what a pack's Worker is held to when its pack
 *     loads, `application/packs/registry.ts`); an entry definition's are held to the entry ceiling
 *     by `validateWorkerDefinitionContent`, as before;
 *   - `gates` (kind `worker`): a Gatekeeper of this workspace (`existingGatekeeperIds`);
 *   - `skills` (kind `worker`): a published Skill, by id or name (`resolvePublishedSkills`, what a
 *     run mounts from);
 *   - `model` (either kind): a model of the llm-proxy catalog, when the caller passes the catalog —
 *     a person's publish does (`publish_worker_definition`); workspace creation checked its entry
 *     model against the catalog before it publishes, and a pack's Worker carries no model of its
 *     own (it keeps the head's, `WORKSPACE_OWNED_WORKER_FIELDS`).
 *
 * Read through the caller's own client, so a Skill or Gatekeeper written earlier in the same
 * transaction resolves — a pack's install publishes its Skills before the Workers that mount them
 * (`application/packs/install.ts`). Only at publish: a draft may name what is not there yet, and a
 * version published before this check is left as it is (an admission check at composition time is
 * S11 GO8's).
 */

/** The fields of a WorkerDefinition whose values name something else. */
export const WORKER_DEFINITION_REFERENCE_FIELDS = [
  'capabilities',
  'gates',
  'skills',
  'model',
] as const;
export type WorkerDefinitionReferenceField = (typeof WORKER_DEFINITION_REFERENCE_FIELDS)[number];

/** Each field's values that do not resolve, as the definition writes them; a field with none is
 *  absent. */
export type UnresolvedWorkerDefinitionReferences = Readonly<
  Partial<Record<WorkerDefinitionReferenceField, readonly string[]>>
>;

const FIELD_WHAT: Readonly<Record<WorkerDefinitionReferenceField, string>> = {
  capabilities: 'capabilities a Worker can never hold',
  gates: 'Gatekeepers this workspace does not have',
  skills: 'Skills with no published version',
  model: 'a model the llm-proxy catalog does not offer',
};

/** 400 `unresolved_references`: the version names something that is not there, so it was not
 *  published. `details.unresolved` carries each field's values (never anything but what the
 *  version itself holds). */
export class WorkerDefinitionReferenceError extends Error {
  readonly code = 'unresolved_references' as const;
  readonly details: { readonly unresolved: UnresolvedWorkerDefinitionReferences };
  constructor(subject: string, unresolved: UnresolvedWorkerDefinitionReferences) {
    const named = WORKER_DEFINITION_REFERENCE_FIELDS.flatMap((field) => {
      const values = unresolved[field];
      return values && values.length > 0
        ? [
            `${field} — ${FIELD_WHAT[field]}: ${values.map((value) => JSON.stringify(value)).join(', ')}`,
          ]
        : [];
    }).join('; ');
    super(
      `${subject} names what is not there, so it is not published (${named}). Propose a version that names only what exists, then publish that one.`,
    );
    this.name = 'WorkerDefinitionReferenceError';
    this.details = { unresolved };
  }
}

/** What the reference check reads beyond the workspace's own rows. */
export interface WorkerDefinitionReferenceSources {
  /** The model ids a definition's `model` may name (the llm-proxy catalog, `list_models`); read
   *  only when the version names a model. Absent: `model` is not checked. */
  readonly modelCatalog?: () => Promise<ReadonlySet<string>>;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))]
    : [];
}

/** Every reference of `definition` (already valid for its `kind`) that does not resolve in
 *  `workspaceId`, by field — empty when all do. One query at a time on `client` (pg@9). */
export async function unresolvedWorkerDefinitionReferences(
  client: PoolClient,
  workspaceId: string,
  kind: WorkerDefinitionKind,
  definition: Readonly<Record<string, unknown>>,
  sources: WorkerDefinitionReferenceSources = {},
): Promise<UnresolvedWorkerDefinitionReferences> {
  const unresolved: Partial<Record<WorkerDefinitionReferenceField, readonly string[]>> = {};
  if (kind === 'worker') {
    const ceiling: ReadonlySet<string> = new Set(WORKER_CEILING_CAPABILITIES);
    const capabilities = stringList(definition.capabilities).filter((name) => !ceiling.has(name));
    if (capabilities.length > 0) unresolved.capabilities = capabilities;

    const gateRefs = stringList(definition.gates);
    const gatekeepers = await existingGatekeeperIds(client, workspaceId, gateRefs);
    const gates = gateRefs.filter((id) => !gatekeepers.has(id));
    if (gates.length > 0) unresolved.gates = gates;

    const skillRefs = stringList(definition.skills);
    const published = await resolvePublishedSkills(client, workspaceId, skillRefs);
    const resolvesTo = new Set(published.flatMap((skill) => [skill.id, skill.name]));
    const skills = skillRefs.filter((ref) => !resolvesTo.has(ref));
    if (skills.length > 0) unresolved.skills = skills;
  }
  const model = definition.model;
  if (typeof model === 'string' && sources.modelCatalog) {
    const offered = await sources.modelCatalog();
    if (!offered.has(model)) unresolved.model = [model];
  }
  return unresolved;
}

/** Throws `WorkerDefinitionReferenceError` naming every reference of `definition` that does not
 *  resolve; returns nothing when all do. */
export async function assertWorkerDefinitionReferencesResolve(
  client: PoolClient,
  workspaceId: string,
  subject: string,
  kind: WorkerDefinitionKind,
  definition: Readonly<Record<string, unknown>>,
  sources?: WorkerDefinitionReferenceSources,
): Promise<void> {
  const unresolved = await unresolvedWorkerDefinitionReferences(
    client,
    workspaceId,
    kind,
    definition,
    sources,
  );
  if (Object.keys(unresolved).length > 0) {
    throw new WorkerDefinitionReferenceError(subject, unresolved);
  }
}
