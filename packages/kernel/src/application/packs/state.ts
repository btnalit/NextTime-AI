import { PACK_INSTALL_STATUS_VALUES, type PackInstallStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { deriveOntologyPackId, loadPublishedOntologyHead } from '../../substrate/ontology/index.js';
import { contentDigest, readFamilyHeadDigest } from '../change-plan/index.js';
import { loadPublishedWorkerDefinitionHead } from '../worker/index.js';
import {
  type PackComponent,
  type PackEntry,
  type PackVersion,
  latestPackVersion,
  packComponentDigest,
  packComponentKey,
  packOwnedWorkerDigest,
} from './registry.js';

/**
 * application/packs/state: what a workspace has of a pack — read from its components' current
 * state, never stored (S11 P1-C / P1-D; S10 plan §6.4). There is no installation row: a pack's
 * component is installed when its family — an ontology family, a Skill, a `worker`
 * WorkerDefinition — has a published head, and which version it is follows from the head's content
 * digest (S7-D D2, generalised from one module to each component). Who installed it is the
 * ChangePlan core's record (`loadOntologyProvenance` / `loadFamilyProvenance`), per component.
 *
 * A component's version — the pack version whose component for that family has the head's digest:
 * the latest when it matches (two versions with identical content are not "outdated"), otherwise the
 * earliest that does (so a breaking version in between is never skipped when confirming an
 * upgrade); none matching is `customized` (published outside this pack: `publish_ontology_version`,
 * an older seed, a hand edit).
 *
 * The pack's version — the same rule over whole versions: a version matches when every component
 * of the latest version has that version's digest, or no head where that version does not publish
 * the component yet (a component is in every version after the first that publishes it,
 * `registry.ts`). No head at all is `not_installed`; heads matching no version are `customized`.
 *
 * A Worker's head is compared without the fields the workspace owns (`packOwnedWorkerDigest`, S11
 * P1-E2): the gates the workspace bound it to and the model it set are not a customization of the
 * pack's Worker.
 */

export { PACK_INSTALL_STATUS_VALUES, type PackInstallStatus };

/** A match of installed content against a list of versions (see this module's comment). */
export interface InstalledMatch {
  readonly status: PackInstallStatus;
  /** The version matched; `null` for `not_installed` and `customized`. */
  readonly installedVersion: number | null;
}

/** Matches `installedDigest` (`null`: not installed) against `candidates`, each a version and the
 *  digest it would install; `latestVersion` is the newest version of all. */
export function matchInstalledVersion(
  candidates: readonly { readonly version: number; readonly digest: string }[],
  latestVersion: number,
  installedDigest: string | null,
): InstalledMatch {
  if (installedDigest === null) return { status: 'not_installed', installedVersion: null };
  const matches = candidates.filter((candidate) => candidate.digest === installedDigest);
  if (matches.some((match) => match.version === latestVersion)) {
    return { status: 'up_to_date', installedVersion: latestVersion };
  }
  const earliest = matches.reduce<number | null>(
    (min, match) => (min === null || match.version < min ? match.version : min),
    null,
  );
  return earliest === null
    ? { status: 'customized', installedVersion: null }
    : { status: 'outdated', installedVersion: earliest };
}

export interface PackComponentState extends InstalledMatch {
  /** The latest version's component. */
  readonly component: PackComponent;
}

export interface PackState extends InstalledMatch {
  readonly entry: PackEntry;
  /** One per component of the latest version, in its order. */
  readonly components: readonly PackComponentState[];
}

/** The digest each component of `entry`'s latest version has installed (`null`: none), by
 *  `packComponentKey`. */
export type PackHeads = ReadonlyMap<string, string | null>;

function componentDigest(version: PackVersion, key: string): string | null {
  const component = version.components.find((c) => packComponentKey(c) === key);
  return component ? packComponentDigest(component) : null;
}

/** Classifies `entry` given what each family has installed (see this module's comment). */
export function classifyPackState(entry: PackEntry, heads: PackHeads): PackState {
  const latest = latestPackVersion(entry);
  const keys = latest.components.map(packComponentKey);
  const headOf = (key: string): string | null => heads.get(key) ?? null;
  const components = latest.components.map((component, index): PackComponentState => {
    const key = keys[index] ?? packComponentKey(component);
    const candidates = entry.versions.flatMap((version) => {
      const digest = componentDigest(version, key);
      return digest === null ? [] : [{ version: version.version, digest }];
    });
    return { component, ...matchInstalledVersion(candidates, latest.version, headOf(key)) };
  });
  if (keys.every((key) => headOf(key) === null)) {
    return { entry, status: 'not_installed', installedVersion: null, components };
  }
  // A whole version as one digest: a component it does not publish yet must have no head.
  const signature = (digests: readonly (string | null)[]) => contentDigest(digests);
  const installed = signature(keys.map(headOf));
  const candidates = entry.versions.map((version) => ({
    version: version.version,
    digest: signature(keys.map((key) => componentDigest(version, key))),
  }));
  return { entry, ...matchInstalledVersion(candidates, latest.version, installed), components };
}

/** The content digest of `component`'s family head in `workspaceId` (`null`: none published). */
async function readComponentHead(
  client: PoolClient,
  workspaceId: string,
  component: PackComponent,
): Promise<string | null> {
  switch (component.kind) {
    case 'ontology': {
      const head = await loadPublishedOntologyHead(
        client,
        workspaceId,
        deriveOntologyPackId(component.family),
      );
      return head ? contentDigest(head.definition) : null;
    }
    case 'skill':
      return readFamilyHeadDigest(client, workspaceId, 'skill_version', component.skillId);
    case 'worker': {
      const head = await loadPublishedWorkerDefinitionHead(
        client,
        workspaceId,
        component.definitionId,
      );
      return head ? packOwnedWorkerDigest(head.definition) : null;
    }
  }
}

/** Reads each component's published head in `workspaceId`. Not locked: a caller about to change
 *  the families plans the change instead (`install.ts`), which locks them first. */
export async function readPackHeads(
  client: PoolClient,
  workspaceId: string,
  entry: PackEntry,
): Promise<PackHeads> {
  const heads = new Map<string, string | null>();
  for (const component of latestPackVersion(entry).components) {
    heads.set(packComponentKey(component), await readComponentHead(client, workspaceId, component));
  }
  return heads;
}

export async function loadPackState(
  client: PoolClient,
  workspaceId: string,
  entry: PackEntry,
): Promise<PackState> {
  return classifyPackState(entry, await readPackHeads(client, workspaceId, entry));
}
