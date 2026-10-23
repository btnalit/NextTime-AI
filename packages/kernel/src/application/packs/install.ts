import type { PoolClient } from 'pg';
import { assertReviewedVersion } from '../../governance/capability/index.js';
import type { GraphTypeUsage } from '../../substrate/graph/index.js';
import { deriveOntologyPackId } from '../../substrate/ontology/index.js';
import {
  type WorkspaceSegmentInput,
  type WorkspaceSegmentPlan,
  applyWorkspaceSegment,
  countRemovedTypeUsage,
  planWorkspaceSegment,
} from '../change-plan/index.js';
import {
  type PackComponent,
  type PackEntry,
  type PackRegistry,
  type PackVersion,
  latestPackVersion,
  packComponentDigest,
  packComponentKey,
  requirePack,
} from './registry.js';
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
 */

/** The change item installing one component (an item per component, in the version's order). */
function componentIntent(component: PackComponent): WorkspaceSegmentInput['items'][number] {
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
        definition: component.definition,
      };
  }
}

/** The segment installing `target`: item `n` installs component `n` (ontology families, then
 *  Skills, then Workers — a Worker after the Skills it mounts). */
export function packSegment(entry: PackEntry, target: PackVersion): WorkspaceSegmentInput {
  return {
    source: {
      kind: 'pack',
      name: entry.name,
      version: String(target.version),
      digest: target.digest,
    },
    items: target.components.map(componentIntent),
  };
}

export interface PackInstallPlan {
  readonly entry: PackEntry;
  readonly target: PackVersion;
  /** What the workspace has before the install. */
  readonly current: PackState;
  readonly segment: WorkspaceSegmentInput;
  readonly plan: WorkspaceSegmentPlan;
  /** The versions the install moves the workspace through, oldest first: those after the installed
   *  one up to the target when `outdated`; the target alone when `not_installed` or `customized`;
   *  none when `up_to_date`. */
  readonly crossed: readonly PackVersion[];
  /** Installing may leave Objects or Facts the workspace holds outside the new shapes: a version it
   *  moves through is `breaking` (`outdated`), or the target is (`customized`: no version to count
   *  from). Never for `not_installed`: there is nothing to leave out. */
  readonly breaking: boolean;
}

/** Plans installing `entry`'s latest version in `workspaceId`: locks its families (until the
 *  transaction ends) and reads what each has now. Writes nothing. */
export async function planPackInstall(
  client: PoolClient,
  workspaceId: string,
  entry: PackEntry,
): Promise<PackInstallPlan> {
  const target = latestPackVersion(entry);
  const segment = packSegment(entry, target);
  const plan = await planWorkspaceSegment(client, workspaceId, segment);
  // Every component the pack has ever published is in the target (`registry.ts`), so the plan's
  // `before` is the whole installed state — read under the lock, with no second read.
  const heads = new Map<string, string | null>();
  for (const [index, component] of target.components.entries()) {
    const before = plan.items[index]?.before;
    const digest = component.kind === 'ontology' ? before?.definitionDigest : before?.contentDigest;
    heads.set(packComponentKey(component), typeof digest === 'string' ? digest : null);
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
  return { entry, target, current, segment, plan, crossed, breaking };
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
): Promise<PackInstallPreview> {
  const install = await planPackInstall(client, workspaceId, requirePack(registry, name));
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
  const target = latestPackVersion(entry);
  assertReviewedVersion('install_pack', `pack ${entry.name}`, input.version, target.version);
  const applied = await applyWorkspaceSegment(client, workspaceId, {
    ...packSegment(entry, target),
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
