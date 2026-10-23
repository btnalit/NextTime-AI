import { describe, expect, it } from 'vitest';
import type { PackEntry, PackVersion } from './registry.js';
import { type PackComponentState, classifyPackState, matchInstalledVersion } from './state.js';

/** application/packs/state.test: which version of a pack a workspace has, from the digests its
 *  families have installed (S11 P1-C) — pure, no database. */

/** A pack whose version `n` publishes `families[n - 1]`, each family's digest `<family>@<n>`
 *  unless `same` says otherwise. Only what `classifyPackState` reads is filled in. */
function packOf(
  versions: readonly (readonly string[])[],
  same: Readonly<Record<string, string>> = {},
): PackEntry {
  return {
    name: 'kit',
    versions: versions.map(
      (families, index) =>
        ({
          name: 'kit',
          version: index + 1,
          components: families.map((family) => ({
            kind: 'ontology',
            family,
            definitionDigest: same[`${family}@${index + 1}`] ?? `${family}@${index + 1}`,
          })),
        }) as unknown as PackVersion,
    ),
  };
}

/** Heads by family name (each an ontology component's `packComponentKey`). */
const heads = (entries: Record<string, string | null>) =>
  new Map(Object.entries(entries).map(([family, digest]) => [`ontology:${family}`, digest]));
const familyOf = (state: PackComponentState) =>
  state.component.kind === 'ontology' ? state.component.family : state.component.name;

describe('matchInstalledVersion', () => {
  const candidates = [
    { version: 1, digest: 'a' },
    { version: 2, digest: 'b' },
    { version: 3, digest: 'b' },
  ];

  it('nothing installed, the latest, an older one, none', () => {
    expect(matchInstalledVersion(candidates, 3, null)).toEqual({
      status: 'not_installed',
      installedVersion: null,
    });
    expect(matchInstalledVersion(candidates, 3, 'a')).toEqual({
      status: 'outdated',
      installedVersion: 1,
    });
    expect(matchInstalledVersion(candidates, 3, 'x')).toEqual({
      status: 'customized',
      installedVersion: null,
    });
  });

  it('content shared by the latest and an older version is up to date, not outdated', () => {
    expect(matchInstalledVersion(candidates, 3, 'b')).toEqual({
      status: 'up_to_date',
      installedVersion: 3,
    });
  });

  it('content shared by two older versions matches the earliest (a breaking one after it counts)', () => {
    expect(matchInstalledVersion(candidates, 4, 'b')).toEqual({
      status: 'outdated',
      installedVersion: 2,
    });
  });
});

describe('classifyPackState', () => {
  // v1 publishes kit-core; v2 adds kit-extra.
  const kit = packOf([['kit-core'], ['kit-core', 'kit-extra']]);

  it('no family installed is not_installed', () => {
    const state = classifyPackState(kit, heads({ 'kit-core': null, 'kit-extra': null }));
    expect(state).toMatchObject({ status: 'not_installed', installedVersion: null });
    expect(state.components.map((c) => [familyOf(c), c.status])).toEqual([
      ['kit-core', 'not_installed'],
      ['kit-extra', 'not_installed'],
    ]);
  });

  it('every family at the latest is up_to_date', () => {
    const state = classifyPackState(
      kit,
      heads({ 'kit-core': 'kit-core@2', 'kit-extra': 'kit-extra@2' }),
    );
    expect(state).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
  });

  it('v1 installed: a family v1 does not publish yet has no head — outdated at 1', () => {
    const state = classifyPackState(kit, heads({ 'kit-core': 'kit-core@1', 'kit-extra': null }));
    expect(state).toMatchObject({ status: 'outdated', installedVersion: 1 });
    expect(state.components.map((c) => [familyOf(c), c.status, c.installedVersion])).toEqual([
      ['kit-core', 'outdated', 1],
      ['kit-extra', 'not_installed', null],
    ]);
  });

  it('part of a version, or a family edited by hand, is customized; each component says which', () => {
    const partial = classifyPackState(kit, heads({ 'kit-core': 'kit-core@2', 'kit-extra': null }));
    expect(partial).toMatchObject({ status: 'customized', installedVersion: null });
    expect(partial.components.map((c) => c.status)).toEqual(['up_to_date', 'not_installed']);

    const edited = classifyPackState(
      kit,
      heads({ 'kit-core': 'by-hand', 'kit-extra': 'kit-extra@2' }),
    );
    expect(edited).toMatchObject({ status: 'customized', installedVersion: null });
    expect(edited.components.map((c) => c.status)).toEqual(['customized', 'up_to_date']);
  });

  it('a family a version does not publish must have no head for that version to match', () => {
    // kit-extra installed by hand next to v1's kit-core: not v1, not v2.
    const state = classifyPackState(kit, heads({ 'kit-core': 'kit-core@1', 'kit-extra': 'x' }));
    expect(state.status).toBe('customized');
  });

  it('identical content in two versions: the latest wins', () => {
    const same = packOf([['kit-core'], ['kit-core']], { 'kit-core@2': 'kit-core@1' });
    expect(classifyPackState(same, heads({ 'kit-core': 'kit-core@1' }))).toMatchObject({
      status: 'up_to_date',
      installedVersion: 2,
    });
  });
});
