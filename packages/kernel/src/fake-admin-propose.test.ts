import type { PackWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { fakeProposablePack } from './fake-admin-propose.js';

/** Unit tests (no IO) for the pack the CI-only pack hook proposes (S11 AA5g). */

function pack(name: string, overrides: Partial<PackWire> = {}): PackWire {
  return {
    name,
    source: 'builtin',
    summary: '',
    latestVersion: 2,
    versions: [],
    status: 'not_installed',
    installedVersion: null,
    components: [],
    requirements: [],
    dependencies: [],
    ...overrides,
  } as PackWire;
}

describe('fakeProposablePack', () => {
  it('picks, by name, the first pack that needs no system and builds on no other pack', () => {
    const needsSystem = pack('a-needs-docker', {
      requirements: [{ connector: 'docker' }] as unknown as PackWire['requirements'],
    });
    const buildsOn = pack('b-builds-on', {
      dependencies: [{ name: 'c' }] as unknown as PackWire['dependencies'],
    });
    expect(
      fakeProposablePack([pack('z-plain'), needsSystem, buildsOn, pack('c-plain')])?.name,
    ).toBe('c-plain');
  });

  it('none fits: undefined (the hook then fails the Turn with why)', () => {
    expect(
      fakeProposablePack([
        pack('only', { requirements: [{}] as unknown as PackWire['requirements'] }),
      ]),
    ).toBeUndefined();
  });
});
