import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type PackFixtureDirs,
  type PackFixtureVersion,
  objectTypeYaml,
  writePackFixture,
} from './fixture.js';
import { PackRegistryError, loadPackRegistry, readPackRegistry } from './registry.js';

/** application/packs/registry-link-ends.test: legacy 705 (L1) as the registry reads it — a pack's
 *  LinkType ends name ObjectTypes of the platform-meta ontology, of its own components or of a
 *  pack it requires directly, at the version it requires and every later one. The image's packs
 *  must keep it (a deployment bug otherwise); an extra pack breaking it at the version it requires
 *  is left out, and one breaking it only beside a later version is read with a warning. */

const fixtures: PackFixtureDirs[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await rm(fixture.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** A domain pack declaring `type`, with one LinkType `link` from it to `target`. */
const linkingYaml = (type: string, link: string, target: string): string =>
  `objectTypes:\n  - name: ${type}\n    description: d\nlinkTypes:\n  - name: ${link}\n    domain: ${type}\n    range: ${target}\n    description: d\n`;

const declaring = (family: string, file: string, type: string): PackFixtureVersion => ({
  ontology: [{ family, domainPack: file, yaml: objectTypeYaml(type) }],
});

const linking = (
  family: string,
  file: string,
  type: string,
  target: string,
  requiresPacks?: PackFixtureVersion['requiresPacks'],
): PackFixtureVersion => ({
  ontology: [{ family, domainPack: file, yaml: linkingYaml(type, 'ticket_on_host', target) }],
  ...(requiresPacks ? { requiresPacks } : {}),
});

/** The image's packs, an optional extra packs directory, and the library's platform-meta.yaml
 *  declaring `Gatekeeper`. */
async function packs(
  builtin: Readonly<Record<string, readonly PackFixtureVersion[]>>,
  extra?: Readonly<Record<string, readonly PackFixtureVersion[]>>,
) {
  const image = await writePackFixture(builtin);
  fixtures.push(image);
  await mkdir(image.packsDir, { recursive: true });
  await writeFile(path.join(image.ontologyDir, 'platform-meta.yaml'), objectTypeYaml('Gatekeeper'));
  let extraDir: string | null = null;
  if (extra) {
    const added = await writePackFixture(extra, { extra: true });
    fixtures.push(added);
    await mkdir(added.packsDir, { recursive: true });
    extraDir = added.packsDir;
  }
  return readPackRegistry({
    packsDir: image.packsDir,
    ontologyDir: image.ontologyDir,
    extraPacksDir: extraDir,
  });
}

const HOSTS = { hosts: [declaring('hosts', 'hosts.yaml', 'Host')] };

describe('legacy 705: the image’s packs', () => {
  it('a LinkType end naming a type of a pack it does not require is a deployment bug', async () => {
    await expect(
      packs({ ...HOSTS, tickets: [linking('tickets', 'tickets.yaml', 'Ticket', 'Host')] }),
    ).rejects.toThrow(PackRegistryError);
    await expect(
      packs({ ...HOSTS, tickets: [linking('tickets', 'tickets.yaml', 'Ticket', 'Host')] }),
    ).rejects.toThrow(
      /packs\/tickets: version 1: LinkType "ticket_on_host" range "Host" names an ObjectType neither the platform-meta ontology, this version nor a pack it requires/,
    );
  });

  it('requiring the pack that declares it, naming a platform-meta type, or its own: read', async () => {
    const read = await packs({
      ...HOSTS,
      tickets: [
        linking('tickets', 'tickets.yaml', 'Ticket', 'Host', [{ name: 'hosts', minVersion: 1 }]),
      ],
      gates: [linking('gates', 'gates.yaml', 'GateNote', 'Gatekeeper')],
      selfish: [linking('selfish', 'selfish.yaml', 'Self', 'Self')],
    });
    expect([...read.registry.keys()].sort()).toEqual(['gates', 'hosts', 'selfish', 'tickets']);
    expect(read.warnings).toEqual([]);
  });

  it('not through a pack the required one requires: requirements are not transitive', async () => {
    await expect(
      packs({
        ...HOSTS,
        mid: [
          {
            ...declaring('mid', 'mid.yaml', 'Mid'),
            requiresPacks: [{ name: 'hosts', minVersion: 1 }],
          },
        ],
        tickets: [
          linking('tickets', 'tickets.yaml', 'Ticket', 'Host', [{ name: 'mid', minVersion: 1 }]),
        ],
      }),
    ).rejects.toThrow(/packs\/tickets: version 1: LinkType "ticket_on_host" range "Host"/);
  });

  it('a later version of the required pack that no longer declares the type is a deployment bug too', async () => {
    await expect(
      packs({
        hosts: [
          declaring('hosts', 'hosts-1.yaml', 'Host'),
          declaring('hosts', 'hosts-2.yaml', 'Machine'),
        ],
        tickets: [
          linking('tickets', 'tickets.yaml', 'Ticket', 'Host', [{ name: 'hosts', minVersion: 1 }]),
        ],
      }),
    ).rejects.toThrow(/declares at the version it requires but not at v2/);
  });

  it('a pack names its family otherwise than the platform-meta ontology', async () => {
    await expect(
      packs({ meta: [declaring('platform-meta', 'meta.yaml', 'Meta')] }),
    ).rejects.toThrow(/platform-meta/);
  });
});

describe('legacy 705: extra packs', () => {
  it('breaking it at the version it requires: left out, and so is a pack requiring it', async () => {
    const read = await packs(HOSTS, {
      tickets: [linking('tickets', 'tickets.yaml', 'Ticket', 'Host')],
      reports: [
        {
          ...declaring('reports', 'reports.yaml', 'Report'),
          requiresPacks: [{ name: 'tickets', minVersion: 1 }],
        },
      ],
    });
    expect(read.registry.has('tickets')).toBe(false);
    expect(read.registry.has('reports')).toBe(false);
    expect(read.skipped).toEqual([
      { name: 'reports', reason: expect.stringContaining('requires pack "tickets"') },
      {
        name: 'tickets',
        reason: expect.stringContaining(
          'version 1: LinkType "ticket_on_host" range "Host" names an ObjectType neither',
        ),
      },
    ]);
    expect(read.warnings).toEqual([]);
  });

  it('breaking it only beside a later version of the pack it requires: read, with a warning', async () => {
    const read = await packs(
      {
        hosts: [
          declaring('hosts', 'hosts-1.yaml', 'Host'),
          declaring('hosts', 'hosts-2.yaml', 'Machine'),
        ],
      },
      {
        tickets: [
          linking('tickets', 'tickets.yaml', 'Ticket', 'Host', [{ name: 'hosts', minVersion: 1 }]),
        ],
        clean: [declaring('clean', 'clean.yaml', 'Clean')],
      },
    );
    expect(read.registry.has('tickets')).toBe(true);
    expect(read.skipped).toEqual([]);
    expect(read.warnings).toEqual([
      {
        name: 'tickets',
        reasons: [
          'version 1: LinkType "ticket_on_host" range "Host" names an ObjectType pack "hosts" declares at the version it requires but not at v2; it cannot be installed beside that version',
        ],
      },
    ]);
  });

  it('an extra pack requiring an extra pack it links to: read', async () => {
    const read = await packs(
      {},
      {
        hosts: [declaring('hosts', 'hosts.yaml', 'Host')],
        tickets: [
          linking('tickets', 'tickets.yaml', 'Ticket', 'Host', [{ name: 'hosts', minVersion: 1 }]),
        ],
      },
    );
    expect([...read.registry.keys()].sort()).toEqual(['hosts', 'tickets']);
    expect(read.skipped).toEqual([]);
    expect(read.warnings).toEqual([]);
  });

  it('loadPackRegistry logs each warning once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const image = await writePackFixture({
      hosts: [
        declaring('hosts', 'hosts-1.yaml', 'Host'),
        declaring('hosts', 'hosts-2.yaml', 'Machine'),
      ],
    });
    const added = await writePackFixture(
      {
        'tickets-logged': [
          linking('tickets-logged', 'tickets.yaml', 'Ticket', 'Host', [
            { name: 'hosts', minVersion: 1 },
          ]),
        ],
      },
      { extra: true },
    );
    fixtures.push(image, added);
    const options = {
      packsDir: image.packsDir,
      ontologyDir: image.ontologyDir,
      extraPacksDir: added.packsDir,
    };
    await loadPackRegistry(options);
    await loadPackRegistry(options);
    const logged = warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { event: string; pack: string })
      .filter((line) => line.event === 'extra_pack_warning');
    expect(logged).toEqual([
      expect.objectContaining({ event: 'extra_pack_warning', pack: 'tickets-logged' }),
    ]);
  });
});
