import type {
  PackComponentStateWire,
  PackInstallItemWire,
  PackInstallPreviewWire,
  PackInstallResultWire,
  PackVersionWire,
  PackWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PlannedChangeItem, loadOntologyProvenance } from '../change-plan/index.js';
import {
  type PackState,
  type PackVersion,
  installPack,
  latestPackVersion,
  loadPackRegistry,
  loadPackState,
  previewPackInstall,
} from '../packs/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { toOntologyProvenanceWire } from './change-segment-handlers.js';

/**
 * application/gateway/pack-handlers: the thin `CapabilityHandler` layer over `application/packs`
 * (S11 P1-C) — `list_packs`, `preview_pack_install`, `install_pack` (`scope:'workspace'`, the 能力
 * 目录 能力包 tab). Each parses params, calls the domain module and projects its records to
 * `@nexttime/shared`'s `wire/packs.ts`; the only read here is each component's provenance
 * (`loadOntologyProvenance`), in the same transaction as the state it explains.
 */

function toPackVersionWire(version: PackVersion): PackVersionWire {
  return {
    version: version.version,
    summary: version.summary,
    notes: version.notes,
    breaking: version.breaking,
    components: version.components.map((component) => ({
      kind: component.kind,
      family: component.family,
      domainPack: component.domainPack,
    })),
  };
}

async function toPackWire(
  client: PoolClient,
  workspaceId: string,
  state: PackState,
): Promise<PackWire> {
  const latest = latestPackVersion(state.entry);
  const components: PackComponentStateWire[] = [];
  for (const [index, component] of state.components.entries()) {
    const provenance = await loadOntologyProvenance(client, workspaceId, component.family);
    components.push({
      kind: component.kind,
      family: component.family,
      domainPack: latest.components[index]?.domainPack ?? '',
      status: component.status,
      installedVersion: component.installedVersion,
      provenance: toOntologyProvenanceWire(provenance),
    });
  }
  return {
    name: state.entry.name,
    summary: latest.summary,
    latestVersion: latest.version,
    versions: state.entry.versions.map(toPackVersionWire),
    status: state.status,
    installedVersion: state.installedVersion,
    components,
  };
}

function toInstallItemWire(item: PlannedChangeItem, target: PackVersion): PackInstallItemWire {
  const { types } = item.detail;
  const names = (section: typeof types.added) => ({
    objectTypes: [...section.objectTypes],
    linkTypes: [...section.linkTypes],
    actionTypes: [...section.actionTypes],
  });
  const before = item.before as { version: number; definitionDigest: string } | null;
  const after = item.after as { definitionDigest: string };
  return {
    ordinal: item.ordinal,
    kind: item.kind,
    target: item.target as { family: string; ontologyId: string },
    // Item `n` installs the target's component `n` (`packSegment`).
    domainPack: target.components[item.ordinal - 1]?.domainPack ?? '',
    before: before ? { version: before.version, definitionDigest: before.definitionDigest } : null,
    after: { definitionDigest: after.definitionDigest },
    unchanged: item.unchanged,
    classification: item.classification,
    widening: item.widening.map((w) => ({ path: w.path, reason: w.reason })),
    types: {
      added: names(types.added),
      removed: names(types.removed),
      changed: names(types.changed),
    },
  };
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
  };
  return installed.segmentId
    ? { result, resourceType: 'change_segment', resourceId: installed.segmentId }
    : { result };
};
