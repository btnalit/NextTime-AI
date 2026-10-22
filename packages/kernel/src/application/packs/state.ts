import { PACK_INSTALL_STATUS_VALUES, type PackInstallStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { deriveOntologyPackId, loadPublishedOntologyHead } from '../../substrate/ontology/index.js';
import { contentDigest } from '../change-plan/index.js';
import { type PackEntry, type PackVersion, latestPackVersion } from './registry.js';

/**
 * application/packs/state: what a workspace has of a pack — read from its components' current
 * state, never stored (S11 P1-C; S10 plan §6.4). There is no installation row: a pack's ontology
 * component is installed when its family has a published head, and which version it is follows
 * from the head's content digest (S7-D D2, generalised from one module to each component). Who
 * installed it is the ChangePlan core's record (`loadOntologyProvenance`), per component.
 *
 * A component's version — the pack version whose component for that family has the head's digest:
 * the latest when it matches (two versions with identical content are not "outdated"), otherwise the
 * earliest that does (so a breaking version in between is never skipped when confirming an
 * upgrade); none matching is `customized` (published outside this pack: `publish_ontology_version`,
 * an older seed, a hand edit).
 *
 * The pack's version — the same rule over whole versions: a version matches when every family of
 * the latest version has that version's digest, or no head where that version does not publish the
 * family yet (a family is in every version after the first that publishes it, `registry.ts`). No
 * head at all is `not_installed`; heads matching no version are `customized`.
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
  readonly kind: 'ontology';
  readonly family: string;
}

export interface PackState extends InstalledMatch {
  readonly entry: PackEntry;
  /** One per component of the latest version, in its order. */
  readonly components: readonly PackComponentState[];
}

/** The digest each family of `entry`'s latest version has installed (`null`: none). */
export type PackHeads = ReadonlyMap<string, string | null>;

function componentDigest(version: PackVersion, family: string): string | null {
  return (
    version.components.find((component) => component.family === family)?.definitionDigest ?? null
  );
}

/** Classifies `entry` given what each family has installed (see this module's comment). */
export function classifyPackState(entry: PackEntry, heads: PackHeads): PackState {
  const latest = latestPackVersion(entry);
  const headOf = (family: string): string | null => heads.get(family) ?? null;
  const components = latest.components.map((component): PackComponentState => {
    const candidates = entry.versions.flatMap((version) => {
      const digest = componentDigest(version, component.family);
      return digest === null ? [] : [{ version: version.version, digest }];
    });
    return {
      kind: 'ontology',
      family: component.family,
      ...matchInstalledVersion(candidates, latest.version, headOf(component.family)),
    };
  });
  if (latest.components.every((component) => headOf(component.family) === null)) {
    return { entry, status: 'not_installed', installedVersion: null, components };
  }
  // A whole version as one digest: a family it does not publish yet must have no head.
  const signature = (digests: readonly (string | null)[]) => contentDigest(digests);
  const installed = signature(latest.components.map((component) => headOf(component.family)));
  const candidates = entry.versions.map((version) => ({
    version: version.version,
    digest: signature(
      latest.components.map((component) => componentDigest(version, component.family)),
    ),
  }));
  return { entry, ...matchInstalledVersion(candidates, latest.version, installed), components };
}

/** Reads each family's published head in `workspaceId`. Not locked: a caller about to change the
 *  families plans the change instead (`install.ts`), which locks them first. */
export async function readPackHeads(
  client: PoolClient,
  workspaceId: string,
  entry: PackEntry,
): Promise<PackHeads> {
  const heads = new Map<string, string | null>();
  for (const component of latestPackVersion(entry).components) {
    const head = await loadPublishedOntologyHead(
      client,
      workspaceId,
      deriveOntologyPackId(component.family),
    );
    heads.set(component.family, head ? contentDigest(head.definition) : null);
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
