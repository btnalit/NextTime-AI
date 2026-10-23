import type {
  PackComponentStateWire,
  PackComponentWire,
  PackInstallItemWire,
  PackInstallPreviewWire,
  PackInstallResultWire,
  PackVersionWire,
  PackWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import {
  type ChangeProvenance,
  type PlannedChangeItem,
  loadFamilyProvenance,
  loadOntologyProvenance,
  verifyChangeSegment,
} from '../change-plan/index.js';
import {
  type PackComponent,
  type PackComponentState,
  type PackEntry,
  type PackState,
  type PackVersion,
  installPack,
  latestPackVersion,
  loadPackRegistry,
  loadPackState,
  previewPackInstall,
  readPackRequirements,
} from '../packs/index.js';
import { loadPublishedWorkerDefinitionHead } from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { toChangeProvenanceWire, toChangeVerificationWire } from './change-segment-handlers.js';
import { sourceRequirementsChecker } from './change-verification.js';

/**
 * application/gateway/pack-handlers: the thin `CapabilityHandler` layer over `application/packs`
 * (S11 P1-C) — `list_packs`, `preview_pack_install`, `install_pack` (`scope:'workspace'`, the 能力
 * 目录 能力包 tab). Each parses params, calls the domain module and projects its records to
 * `@nexttime/shared`'s `wire/packs.ts`; the reads here are each component's provenance
 * (`loadOntologyProvenance` / `loadFamilyProvenance`) and where each system the latest version
 * needs stands (`readPackRequirements`, no gate contacted), in the same transaction as the state
 * they explain. `install_pack` verifies the segment it recorded once it has committed (P1-E).
 */

function toPackComponentWire(component: PackComponent): PackComponentWire {
  switch (component.kind) {
    case 'ontology':
      return { kind: 'ontology', family: component.family, domainPack: component.domainPack };
    case 'skill':
      return { kind: 'skill', name: component.name, description: component.content.description };
    case 'worker':
      return {
        kind: 'worker',
        name: component.name,
        description: component.definition.description ?? null,
      };
  }
}

async function loadComponentProvenance(
  client: PoolClient,
  workspaceId: string,
  component: PackComponent,
): Promise<ChangeProvenance> {
  switch (component.kind) {
    case 'ontology':
      return loadOntologyProvenance(client, workspaceId, component.family);
    case 'skill':
      return loadFamilyProvenance(client, workspaceId, 'skill_version', component.skillId);
    case 'worker':
      return loadFamilyProvenance(
        client,
        workspaceId,
        'worker_definition_version',
        component.definitionId,
      );
  }
}

async function toComponentStateWire(
  client: PoolClient,
  workspaceId: string,
  state: PackComponentState,
): Promise<PackComponentStateWire> {
  const { component } = state;
  const common = {
    status: state.status,
    installedVersion: state.installedVersion,
    provenance: toChangeProvenanceWire(
      await loadComponentProvenance(client, workspaceId, component),
    ),
  };
  switch (component.kind) {
    case 'ontology':
      return {
        kind: 'ontology',
        family: component.family,
        domainPack: component.domainPack,
        ...common,
      };
    case 'skill':
      return { kind: 'skill', name: component.name, skillId: component.skillId, ...common };
    case 'worker': {
      const head = await loadPublishedWorkerDefinitionHead(
        client,
        workspaceId,
        component.definitionId,
      );
      return {
        kind: 'worker',
        name: component.name,
        definitionId: component.definitionId,
        headVersion: head?.version ?? null,
        ...common,
      };
    }
  }
}

function toPackVersionWire(version: PackVersion): PackVersionWire {
  return {
    version: version.version,
    summary: version.summary,
    notes: version.notes,
    breaking: version.breaking,
    requiredConnectors: [...version.requiredConnectors],
    components: version.components.map(toPackComponentWire),
  };
}

async function toPackWire(
  client: PoolClient,
  workspaceId: string,
  state: PackState,
): Promise<PackWire> {
  const latest = latestPackVersion(state.entry);
  const components: PackComponentStateWire[] = [];
  for (const component of state.components) {
    components.push(await toComponentStateWire(client, workspaceId, component));
  }
  return {
    name: state.entry.name,
    summary: latest.summary,
    latestVersion: latest.version,
    versions: state.entry.versions.map(toPackVersionWire),
    status: state.status,
    installedVersion: state.installedVersion,
    components,
    requirements: (await readPackRequirements(client, workspaceId, latest.requiredConnectors)).map(
      (requirement) => ({ connector: requirement.connector, state: requirement.state }),
    ),
  };
}

/** Item `n` installs the target's component `n` (`packSegment`): the component names what the
 *  item installs, the item what it changes. */
function toInstallItemWire(item: PlannedChangeItem, target: PackVersion): PackInstallItemWire {
  const component = target.components[item.ordinal - 1];
  const common = {
    ordinal: item.ordinal,
    unchanged: item.unchanged,
    classification: item.classification,
    widening: item.widening.map((w) => ({ path: w.path, reason: w.reason })),
  };
  const { detail } = item;
  if (detail.kind === 'ontology_version' && component?.kind === 'ontology') {
    const names = (section: typeof detail.types.added) => ({
      objectTypes: [...section.objectTypes],
      linkTypes: [...section.linkTypes],
      actionTypes: [...section.actionTypes],
    });
    const before = item.before as { version: number; definitionDigest: string } | null;
    const after = item.after as { definitionDigest: string };
    return {
      ...common,
      kind: detail.kind,
      target: item.target as { family: string; ontologyId: string },
      domainPack: component.domainPack,
      before: before
        ? { version: before.version, definitionDigest: before.definitionDigest }
        : null,
      after: { definitionDigest: after.definitionDigest },
      types: {
        added: names(detail.types.added),
        removed: names(detail.types.removed),
        changed: names(detail.types.changed),
      },
    };
  }
  const before = item.before as { version: number; contentDigest: string } | null;
  const after = item.after as { contentDigest: string };
  const versions = {
    before: before ? { version: before.version, contentDigest: before.contentDigest } : null,
    after: { contentDigest: after.contentDigest },
  };
  if (detail.kind === 'skill_version' && component?.kind === 'skill') {
    return {
      ...common,
      kind: detail.kind,
      target: { skillId: component.skillId, name: component.name },
      ...versions,
      skill: {
        name: detail.content.name,
        description: detail.content.description,
        markdown: detail.content.markdown,
      },
      changedFields: [...detail.changedFields],
    };
  }
  if (detail.kind === 'worker_definition_version' && component?.kind === 'worker') {
    const { definition } = component;
    return {
      ...common,
      kind: detail.kind,
      target: { definitionId: component.definitionId, name: component.name },
      ...versions,
      worker: {
        name: component.name,
        description: definition.description ?? null,
        systemPrompt: definition.systemPrompt,
        skills: [...(definition.skills ?? [])],
        capabilities: definition.capabilities ? [...definition.capabilities] : null,
        egressDeny: [...(definition.egressDeny ?? [])],
      },
      changedFields: [...detail.changedFields],
    };
  }
  throw new Error(
    `install review: item ${item.ordinal} (${detail.kind}) does not install component ${item.ordinal} (${component?.kind ?? 'none'})`,
  );
}

export const listPacksHandler: CapabilityHandler = async (client, workspaceId) => {
  const registry = await loadPackRegistry();
  const items: PackWire[] = [];
  for (const entry of registry.values()) {
    items.push(
      await toPackWire(client, workspaceId, await loadPackState(client, workspaceId, entry)),
    );
  }
  return { result: { items } };
};

export const previewPackInstallHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { name } = params as { name: string };
  const preview = await previewPackInstall(client, workspaceId, await loadPackRegistry(), name);
  const result: PackInstallPreviewWire = {
    pack: await toPackWire(client, workspaceId, preview.current),
    targetVersion: preview.target.version,
    digest: preview.plan.digest,
    unchanged: preview.plan.unchanged,
    crossedVersions: preview.crossed.map((version) => version.version),
    breaking: preview.breaking,
    items: preview.plan.items.map((item) => toInstallItemWire(item, preview.target)),
    inUse: { ...preview.inUse },
  };
  return { result };
};

export const installPackHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  context,
) => {
  const input = params as {
    name: string;
    version: number;
    reviewedDigest: string;
    confirmedOrdinals?: number[];
  };
  if (!context?.principalId) throw new Error('install_pack: no calling principal in context');
  // `channel: 'human'`: the person installing is the one confirming any widening item (I-A4).
  if (context.channel !== 'human')
    throw new Error('install_pack: invoked outside the human channel');
  // A confirmation of an authority-widening item is a person's (I-A4, the same rule as
  // `roll_back_change_segment` and `attest_fact`): a *service* Principal's API key also
  // authenticates on the human channel, and a service is not a person. Without a confirmation a
  // service owner may still install a pack that widens nothing.
  const confirmedOrdinals = input.confirmedOrdinals ?? [];
  if (confirmedOrdinals.length > 0 && context.principal?.kind !== 'human') {
    throw new ForbiddenError(
      'install_pack: only a person (a human Principal on the human channel) can confirm an authority-widening change',
    );
  }
  const installed = await installPack(
    client,
    workspaceId,
    context.principalId,
    await loadPackRegistry(),
    {
      name: input.name,
      version: input.version,
      reviewedDigest: input.reviewedDigest,
      confirmedOrdinals,
    },
  );
  const result: PackInstallResultWire = {
    pack: await toPackWire(client, workspaceId, installed.state),
    segmentId: installed.segmentId,
    verification: null,
  };
  const { segmentId } = installed;
  if (!segmentId) return { result };
  const principalId = context.principalId;
  const { entry } = installed.state;
  return {
    result,
    resourceType: 'change_segment',
    resourceId: segmentId,
    // S11 P1-E: once the install has committed, verify it once — as the person who installed,
    // recorded as `trigger: system` — in a transaction of its own, so the gate probes run after the
    // install's locks are gone. The install stands whatever happens here.
    afterCommit: async (pool) => ({
      ...result,
      ...(await verifyAfterInstall(pool, workspaceId, principalId, segmentId, entry)),
    }),
  };
};

/** The install's first verification (see `installPackHandler`) and the pack read again after it
 *  (its components' records now carry the run's status); nothing when the run could not be made —
 *  logged, never thrown: the install is committed, and the owner can verify it again from its
 *  record. */
async function verifyAfterInstall(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
  segmentId: string,
  entry: PackEntry,
): Promise<Pick<PackInstallResultWire, 'pack' | 'verification'> | Record<string, never>> {
  try {
    return await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
      const { verification } = await verifyChangeSegment(client, workspaceId, {
        segmentId,
        verifiedBy: principalId,
        trigger: 'system',
        checkRequirements: sourceRequirementsChecker(client, workspaceId),
      });
      return {
        pack: await toPackWire(
          client,
          workspaceId,
          await loadPackState(client, workspaceId, entry),
        ),
        verification: toChangeVerificationWire(verification),
      };
    });
  } catch (err) {
    console.error(
      `[kernel] install_pack: verifying segment ${segmentId} after the install failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
}
