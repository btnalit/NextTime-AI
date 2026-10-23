import type { PoolClient } from 'pg';
import { assertReviewedVersion } from '../../governance/capability/index.js';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import type { GraphTypeUsage } from '../../substrate/graph/index.js';
import { deriveOntologyPackId } from '../../substrate/ontology/index.js';
import {
  type WorkspaceSegmentInput,
  type WorkspaceSegmentPlan,
  applyWorkspaceSegment,
  countRemovedTypeUsage,
  planWorkspaceSegment,
} from '../change-plan/index.js';
import { loadPublishedWorkerDefinitionHead } from '../worker/index.js';
import {
  type PackComponent,
  type PackEntry,
  type PackRegistry,
  type PackVersion,
  WORKSPACE_OWNED_WORKER_FIELDS,
  latestPackVersion,
  packComponentDigest,
  packComponentKey,
  packOwnedWorkerDigest,
  requirePack,
} from './registry.js';
import { type PackRequirementGate, readPackRequirements } from './requirements.js';
import { type PackState, classifyPackState } from './state.js';

/**
 * application/packs/install: installing a pack into a workspace as one ChangePlan workspace segment
 * (S11 P1-C / P1-D; S10 plan §6.4; plan §5.4 I-A4, I-A8). An install always targets the pack's
 * latest version, in one segment that publishes each component whose content differs — an ontology
 * family's next version, a Skill's, a Worker's — so the same call installs, upgrades and replaces a
 * customized component. Nothing is stored about the pack beyond the segment (`state.ts`).
 *
 *   preview (`previewPackInstall`) — the segment's dry run, plus what the person reviewing it needs
 *         beside the items: which versions it moves through and whether one is `breaking`, and how
 *         many graph rows use a type it takes out. The digest is what they review.
 *   install (`installPack`) — refuses when the latest version is not the one reviewed (409
 *         `version_changed`), then applies the segment with the reviewed digest (409
 *         `change_plan_changed` when anything moved since) and the widening items the person
 *         confirmed one by one (400 `change_confirmation_required` otherwise).
 *
 * A customized component or a `breaking` version needs no separate confirmation here: the preview
 * shows both, and the digest the installer passes back covers what each item replaces (`before`)
 * and installs (`after`) — reviewing that digest is the confirmation. `install_module` /
 * `upgrade_module` keep their own `confirm` (`application/platform/modules.ts`), since they take no
 * digest.
 *
 * A Worker's gates and model are the workspace's (S11 P1-E2, `WORKSPACE_OWNED_WORKER_FIELDS`):
 *   - an install keeps them — each Worker item publishes the head's `gates` and `model` where the
 *     head has them (`keepFromHead`, read under the registry lock), so upgrading the pack never
 *     takes away the systems the workspace bound its Worker to or the model it chose;
 *   - a Worker that names its systems (`PackWorkerComponent.systems`) and has no gates yet is bound
 *     by the install to the workspace's connected gates of those systems (`readPackRequirements`'
 *     `gatekeepers`): every one, unless the person reviewing kept only some (`WorkerGateChoice`).
 *     Binding widens what the Worker may act on, so the item is confirmed by itself (I-A4); a gate
 *     connected or cut off between the review and the install changes the digest (409
 *     `change_plan_changed`). Installing again once a system is connected binds a Worker installed
 *     before it was: the pack is `up_to_date`, its Worker `bindable` (`readWorkerBindings`).
 */

/** The change item installing one component (an item per component, in the version's order).
 *  `gates`: what a Worker with no gates yet is bound to (see this module's comment). */
function componentIntent(
  component: PackComponent,
  gates: readonly string[],
): WorkspaceSegmentInput['items'][number] {
  switch (component.kind) {
    case 'ontology':
      return {
        kind: 'ontology_version',
        family: component.family,
        definition: component.definition,
      };
    case 'skill':
      return { kind: 'skill_version', skillId: component.skillId, content: component.content };
    case 'worker':
      return {
        kind: 'worker_definition_version',
        definitionId: component.definitionId,
        definition:
          gates.length > 0 ? { ...component.definition, gates: [...gates] } : component.definition,
        keepFromHead: WORKSPACE_OWNED_WORKER_FIELDS,
      };
  }
}

/** The segment installing `target`: item `n` installs component `n` (ontology families, then
 *  Skills, then Workers — a Worker after the Skills it mounts). `gates`: by WorkerDefinition id,
 *  what a Worker with no gates yet is bound to (none when absent). */
export function packSegment(
  entry: PackEntry,
  target: PackVersion,
  gates: ReadonlyMap<string, readonly string[]> = new Map(),
): WorkspaceSegmentInput {
  return {
    source: {
      kind: 'pack',
      name: entry.name,
      version: String(target.version),
      digest: target.digest,
    },
    items: target.components.map((component) =>
      componentIntent(
        component,
        component.kind === 'worker' ? (gates.get(component.definitionId) ?? []) : [],
      ),
    ),
  };
}

/** The gates the person reviewing an install kept for a Worker it binds, by Worker name
 *  (`install_pack`'s `workerGates`). A Worker not named is bound to every candidate. */
export type WorkerGateChoice = ReadonlyMap<string, readonly string[]>;

/** `400 invalid_params`: a `WorkerGateChoice` naming a Worker the version does not have, one that
 *  names no system, or a gate that is not one of its candidates. Never sent by the console. */
export class PackWorkerGatesError extends Error {
  constructor(reason: string) {
    super(`workerGates: ${reason}`);
    this.name = 'PackWorkerGatesError';
  }
}

/** A gate a Worker of the pack may be bound to: a connected Gatekeeper of one of its systems. */
export interface WorkerGateCandidate extends PackRequirementGate {
  readonly connector: string;
}

/** The gates each Worker of `target` that names systems could be bound to in `workspaceId`, by
 *  WorkerDefinition id: the workspace's connected Gatekeepers of those systems, in the systems'
 *  order. */
export async function readWorkerGateCandidates(
  client: PoolClient,
  workspaceId: string,
  target: PackVersion,
): Promise<ReadonlyMap<string, readonly WorkerGateCandidate[]>> {
  const requirements = await readPackRequirements(client, workspaceId, target.requiredConnectors);
  const connected = new Map(
    requirements.map((requirement) => [requirement.connector, requirement.gatekeepers]),
  );
  const candidates = new Map<string, readonly WorkerGateCandidate[]>();
  for (const component of target.components) {
    if (component.kind !== 'worker' || component.systems.length === 0) continue;
    candidates.set(
      component.definitionId,
      component.systems.flatMap((connector) =>
        (connected.get(connector) ?? []).map((gate) => ({ ...gate, connector })),
      ),
    );
  }
  return candidates;
}

/** Where a Worker of a pack stands with its gates in a workspace (the pack's detail). */
export interface WorkerBinding {
  /** The systems it acts on (`PackWorkerComponent.systems`). */
  readonly systems: readonly string[];
  /** The gates its published head may act on (its `gates`), with their names; empty when it has
   *  none (or is not installed). */
  readonly gates: readonly PackRequirementGate[];
  /** Installing the pack again would bind it: it is installed, has no gates yet, and a gate of a
   *  system it acts on is connected now (see this module's comment). */
  readonly bindable: boolean;
}

/** `WorkerBinding` for each Worker of `entry`'s latest version in `workspaceId`, by
 *  WorkerDefinition id. Not locked: a read for the pack's detail. */
export async function readWorkerBindings(
  client: PoolClient,
  workspaceId: string,
  entry: PackEntry,
): Promise<ReadonlyMap<string, WorkerBinding>> {
  const target = latestPackVersion(entry);
  const candidates = await readWorkerGateCandidates(client, workspaceId, target);
  const bindings = new Map<string, WorkerBinding>();
  for (const component of target.components) {
    if (component.kind !== 'worker') continue;
    const head = await loadPublishedWorkerDefinitionHead(
      client,
      workspaceId,
      component.definitionId,
    );
    bindings.set(component.definitionId, {
      systems: component.systems,
      gates: await gateRefs(client, workspaceId, stringList(head?.definition.gates)),
      bindable:
        head !== null &&
        head.definition.gates === undefined &&
        (candidates.get(component.definitionId) ?? []).length > 0,
    });
  }
  return bindings;
}

/** What a Worker with no gates yet is bound to: the person's choice, checked against the
 *  candidates, or every candidate (see `WorkerGateChoice`). */
function chooseWorkerGates(
  target: PackVersion,
  candidates: ReadonlyMap<string, readonly WorkerGateCandidate[]>,
  choice: WorkerGateChoice,
): ReadonlyMap<string, readonly string[]> {
  const workers = new Map(
    target.components.flatMap((component) =>
      component.kind === 'worker' ? [[component.name, component] as const] : [],
    ),
  );
  for (const [name, ids] of choice) {
    const worker = workers.get(name);
    if (!worker) throw new PackWorkerGatesError(`v${target.version} has no Worker "${name}"`);
    const offered = new Set((candidates.get(worker.definitionId) ?? []).map((gate) => gate.id));
    const foreign = ids.filter((id) => !offered.has(id));
    if (foreign.length > 0) {
      throw new PackWorkerGatesError(
        `gate(s) ${foreign.join(', ')} are not connected gates of the systems Worker "${name}" acts on`,
      );
    }
  }
  const gates = new Map<string, readonly string[]>();
  for (const [definitionId, offered] of candidates) {
    const name = [...workers.values()].find((worker) => worker.definitionId === definitionId)?.name;
    const chosen = name === undefined ? undefined : choice.get(name);
    const kept = chosen === undefined ? null : new Set(chosen);
    gates.set(
      definitionId,
      offered.filter((gate) => kept === null || kept.has(gate.id)).map((gate) => gate.id),
    );
  }
  return gates;
}

/** How an install sets a Worker's gates (see this module's comment). */
export interface PlannedWorkerGates {
  /** The item installing the Worker. */
  readonly ordinal: number;
  readonly definitionId: string;
  readonly name: string;
  /** The systems it acts on (`PackWorkerComponent.systems`). */
  readonly systems: readonly string[];
  /** `workspace`: the head's gates, kept; `install`: the install binds it; `none`: it has none
   *  and gets none (it names no system, none is connected, or the person kept none). */
  readonly source: 'workspace' | 'install' | 'none';
  /** The gates the item publishes. */
  readonly gates: readonly PackRequirementGate[];
  /** For a Worker with no gates yet: the connected gates of its systems it could be bound to. */
  readonly candidates: readonly WorkerGateCandidate[];
  /** The model the item publishes — the workspace's own, kept — or `null`. */
  readonly model: string | null;
}

export interface PackInstallPlan {
  readonly entry: PackEntry;
  readonly target: PackVersion;
  /** What the workspace has before the install. */
  readonly current: PackState;
  readonly segment: WorkspaceSegmentInput;
  readonly plan: WorkspaceSegmentPlan;
  /** One per Worker of the target, in item order. */
  readonly workerGates: readonly PlannedWorkerGates[];
  /** The versions the install moves the workspace through, oldest first: those after the installed
   *  one up to the target when `outdated`; the target alone when `not_installed` or `customized`;
   *  none when `up_to_date`. */
  readonly crossed: readonly PackVersion[];
  /** Installing may leave Objects or Facts the workspace holds outside the new shapes: a version it
   *  moves through is `breaking` (`outdated`), or the target is (`customized`: no version to count
   *  from). Never for `not_installed`: there is nothing to leave out. */
  readonly breaking: boolean;
}

/** The segment installing `entry`'s latest version in `workspaceId`, with the gates a Worker with
 *  none yet is bound to (`choice`, see `WorkerGateChoice`). Locks nothing. */
async function installSegment(
  client: PoolClient,
  workspaceId: string,
  entry: PackEntry,
  choice: WorkerGateChoice,
): Promise<{
  readonly target: PackVersion;
  readonly segment: WorkspaceSegmentInput;
  readonly candidates: ReadonlyMap<string, readonly WorkerGateCandidate[]>;
}> {
  const target = latestPackVersion(entry);
  const candidates = await readWorkerGateCandidates(client, workspaceId, target);
  const segment = packSegment(entry, target, chooseWorkerGates(target, candidates, choice));
  return { target, segment, candidates };
}

/** Plans installing `entry`'s latest version in `workspaceId`: locks its families (until the
 *  transaction ends) and reads what each has now. Writes nothing. */
export async function planPackInstall(
  client: PoolClient,
  workspaceId: string,
  entry: PackEntry,
  choice: WorkerGateChoice = new Map(),
): Promise<PackInstallPlan> {
  const { target, segment, candidates } = await installSegment(client, workspaceId, entry, choice);
  const plan = await planWorkspaceSegment(client, workspaceId, segment);
  // Read under the plan's locks: what each family has now, for the pack's state (a Worker's
  // without the workspace's own fields) and for the gates each Worker keeps.
  const heads = new Map<string, string | null>();
  const workerGates: PlannedWorkerGates[] = [];
  for (const [index, component] of target.components.entries()) {
    const item = plan.items[index];
    if (component.kind !== 'worker') {
      const before = item?.before;
      const digest =
        component.kind === 'ontology' ? before?.definitionDigest : before?.contentDigest;
      heads.set(packComponentKey(component), typeof digest === 'string' ? digest : null);
      continue;
    }
    const head = await loadPublishedWorkerDefinitionHead(
      client,
      workspaceId,
      component.definitionId,
    );
    heads.set(packComponentKey(component), head ? packOwnedWorkerDigest(head.definition) : null);
    const published =
      item?.detail.kind === 'worker_definition_version' ? item.detail.definition : {};
    const kept = head?.definition.gates !== undefined;
    const offered = kept ? [] : (candidates.get(component.definitionId) ?? []);
    const gates = await gateRefs(client, workspaceId, stringList(published.gates), offered);
    workerGates.push({
      ordinal: index + 1,
      definitionId: component.definitionId,
      name: component.name,
      systems: component.systems,
      source: kept ? 'workspace' : gates.length > 0 ? 'install' : 'none',
      gates,
      candidates: offered,
      model: typeof published.model === 'string' ? published.model : null,
    });
  }
  const current = classifyPackState(entry, heads);
  let crossed: readonly PackVersion[];
  let breaking: boolean;
  switch (current.status) {
    case 'up_to_date':
      crossed = [];
      breaking = false;
      break;
    case 'outdated': {
      const from = current.installedVersion ?? 0;
      crossed = entry.versions.filter((version) => version.version > from);
      breaking = crossed.some((version) => version.breaking);
      break;
    }
    case 'customized':
      crossed = [target];
      breaking = target.breaking;
      break;
    case 'not_installed':
      crossed = [target];
      breaking = false;
      break;
  }
  return { entry, target, current, segment, plan, workerGates, crossed, breaking };
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/** `ids` with the names people know them by: a candidate's, else the Gatekeeper's (the id itself
 *  for one no longer registered). */
async function gateRefs(
  client: PoolClient,
  workspaceId: string,
  ids: readonly string[],
  known: readonly PackRequirementGate[] = [],
): Promise<PackRequirementGate[]> {
  const names = new Map(known.map((gate) => [gate.id, gate.name]));
  const gates: PackRequirementGate[] = [];
  for (const id of ids) {
    const name = names.get(id) ?? (await getGatekeeper(client, workspaceId, id))?.name ?? id;
    gates.push({ id, name });
  }
  return gates;
}

export interface PackInstallPreview extends PackInstallPlan {
  /** Graph rows using a type the install takes out of the workspace's ontology (a type a component
   *  had and its new version does not; counts stop at `CHANGE_ROLLBACK_IN_USE_CAP`). */
  readonly inUse: GraphTypeUsage;
}

/** `preview_pack_install`. `PackNotFoundError` for a name the deployment does not ship. */
export async function previewPackInstall(
  client: PoolClient,
  workspaceId: string,
  registry: PackRegistry,
  name: string,
  choice: WorkerGateChoice = new Map(),
): Promise<PackInstallPreview> {
  const install = await planPackInstall(client, workspaceId, requirePack(registry, name), choice);
  // A type one component drops and another declares after the install is not taken out.
  const ontology = install.target.components.flatMap((component) =>
    component.kind === 'ontology' ? [component] : [],
  );
  const declaredAfter = (section: 'objectTypes' | 'linkTypes') =>
    new Set(
      ontology.flatMap((component) =>
        (component.definition[section] ?? []).map((type) => type.name),
      ),
    );
  const objectsAfter = declaredAfter('objectTypes');
  const linksAfter = declaredAfter('linkTypes');
  // Only an ontology item takes types out; a Skill or a Worker has none.
  const removed = install.plan.items.flatMap((item) =>
    item.detail.kind === 'ontology_version' ? [item.detail.types.removed] : [],
  );
  const inUse = await countRemovedTypeUsage(
    client,
    workspaceId,
    {
      objectTypes: removed
        .flatMap((names) => names.objectTypes)
        .filter((n) => !objectsAfter.has(n)),
      linkTypes: removed.flatMap((names) => names.linkTypes).filter((n) => !linksAfter.has(n)),
    },
    new Set(ontology.map((component) => deriveOntologyPackId(component.family))),
  );
  return { ...install, inUse };
}

export interface InstallPackInput {
  readonly name: string;
  /** The pack version the person reviewed: the install refuses (409 `version_changed`) when the
   *  latest is another one. */
  readonly version: number;
  /** The preview's `digest` (I-A8). */
  readonly reviewedDigest: string;
  /** The ordinals of the authority-widening items the person confirmed, one by one (I-A4). */
  readonly confirmedOrdinals: readonly number[];
  /** The gates the person kept for a Worker the install binds (the preview's own choice). */
  readonly workerGates?: WorkerGateChoice;
}

export interface InstalledPack {
  /** After the install: `up_to_date`. */
  readonly state: PackState;
  /** The segment recorded; `null` when nothing needed to change. */
  readonly segmentId: string | null;
}

/** `install_pack`, in the caller's transaction (see this module's comment). `principalId` is the
 *  person installing — proposer, applier and confirmer. */
export async function installPack(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  registry: PackRegistry,
  input: InstallPackInput,
): Promise<InstalledPack> {
  const entry = requirePack(registry, input.name);
  assertReviewedVersion(
    'install_pack',
    `pack ${entry.name}`,
    input.version,
    latestPackVersion(entry).version,
  );
  const { target, segment } = await installSegment(
    client,
    workspaceId,
    entry,
    input.workerGates ?? new Map(),
  );
  const applied = await applyWorkspaceSegment(client, workspaceId, {
    ...segment,
    reviewedDigest: input.reviewedDigest,
    proposedBy: principalId,
    appliedBy: principalId,
    channel: 'human',
    confirmedOrdinals: input.confirmedOrdinals,
  });
  const heads = new Map(
    target.components.map((component) => [
      packComponentKey(component),
      packComponentDigest(component),
    ]),
  );
  return { state: classifyPackState(entry, heads), segmentId: applied.segmentId };
}
