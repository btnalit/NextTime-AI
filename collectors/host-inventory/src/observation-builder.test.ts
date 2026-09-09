import { describe, expect, it } from 'vitest';
import type {
  ContainerSummary,
  ImageSummary,
  NetworkSummary,
  VolumeSummary,
} from './docker-client.js';
import {
  buildPhase1Observations,
  buildPhase2Observations,
  buildPhase3Observations,
  groupContainersByComposeProject,
} from './observation-builder.js';
import type { RawProcess } from './process-tree.js';
import type { RawRepository } from './repository.js';
import type { RawSystemdService } from './systemd.js';

/** `ontology/ops-assets-v1.yaml`'s own identityKey per ObjectType — mirrored here (not imported;
 *  this package has no dependency on the kernel/ontology YAML) so these tests can assert every
 *  generated observation's/link-target's identity is actually *complete*, the same check
 *  `application/gateway/ingest-handlers.ts`'s `assertIdentityComplete` performs server-side. */
const IDENTITY_KEYS: Record<string, readonly string[]> = {
  Host: ['hostname'],
  ComposeProject: ['hostId', 'projectName'],
  Container: ['composeProjectId', 'serviceName'],
  Image: ['digest'],
  SystemdService: ['hostId', 'unitName'],
  Process: ['executablePath', 'workingDirectory', 'parentPid'],
  Volume: ['hostId', 'volumeName'],
  Network: ['hostId', 'networkName'],
  Endpoint: ['hostId', 'address', 'port'],
  Repository: ['remoteUrl'],
};

function assertIdentityComplete(objectType: string, identity: Record<string, unknown>): void {
  const keys = IDENTITY_KEYS[objectType];
  if (!keys) throw new Error(`test fixture bug: no identityKey known for "${objectType}"`);
  for (const key of keys) {
    if (identity[key] === undefined) {
      throw new Error(
        `${objectType} identity is missing required key "${key}": ${JSON.stringify(identity)}`,
      );
    }
  }
}

function assertAllIdentitiesComplete(
  observations: readonly {
    objectType: string;
    identity: Record<string, unknown>;
    links?: readonly { target: { objectType: string; identity: Record<string, unknown> } }[];
  }[],
): void {
  for (const observation of observations) {
    assertIdentityComplete(observation.objectType, observation.identity);
    for (const link of observation.links ?? []) {
      assertIdentityComplete(link.target.objectType, link.target.identity);
    }
  }
}

describe('buildPhase1Observations', () => {
  it('emits a Host observation with no links', () => {
    const result = buildPhase1Observations({
      hostname: 'h1',
      repositories: [],
      images: [],
      processes: [],
      workingDirectories: new Map(),
    });
    expect(result).toEqual([{ objectType: 'Host', identity: { hostname: 'h1' } }]);
  });

  it('emits a Repository observation per configured repo', () => {
    const repositories: RawRepository[] = [
      { remoteUrl: 'https://example.invalid/a.git', repoPath: '/repo-a', remoteName: 'origin' },
    ];
    const result = buildPhase1Observations({
      hostname: 'h1',
      repositories,
      images: [],
      processes: [],
      workingDirectories: new Map(),
    });
    const repo = result.find((o) => o.objectType === 'Repository');
    expect(repo?.identity).toEqual({ remoteUrl: 'https://example.invalid/a.git' });
  });

  it('skips an Image with no digest (identityKey = [digest])', () => {
    const images: ImageSummary[] = [{ id: 'sha256:abc', digest: null, repoTags: ['nginx:latest'] }];
    const result = buildPhase1Observations({
      hostname: 'h1',
      repositories: [],
      images,
      processes: [],
      workingDirectories: new Map(),
    });
    expect(result.some((o) => o.objectType === 'Image')).toBe(false);
  });

  it('emits a Process observation with a spawned_by link to its parent when the parent is in the same batch', () => {
    const processes: RawProcess[] = [
      { pid: 10, ppid: 1, commandLine: 'pi entrypoint', executablePath: 'pi' },
      { pid: 11, ppid: 10, commandLine: 'node worker', executablePath: 'node' },
    ];
    const result = buildPhase1Observations({
      hostname: 'h1',
      repositories: [],
      images: [],
      processes,
      workingDirectories: new Map([
        [10, '/app'],
        [11, '/app/worker'],
      ]),
    });
    const child = result.find(
      (o) => o.objectType === 'Process' && (o.properties as { pid: number }).pid === 11,
    );
    expect(child?.identity).toEqual({
      executablePath: 'node',
      workingDirectory: '/app/worker',
      parentPid: 10,
    });
    expect(child?.links).toEqual([
      {
        linkType: 'spawned_by',
        target: {
          objectType: 'Process',
          identity: { executablePath: 'pi', workingDirectory: '/app', parentPid: 1 },
        },
      },
    ]);
  });

  it('emits no spawned_by link when the parent is outside this batch (root of the observed subtree)', () => {
    const processes: RawProcess[] = [
      { pid: 10, ppid: 1, commandLine: 'pi entrypoint', executablePath: 'pi' },
    ];
    const result = buildPhase1Observations({
      hostname: 'h1',
      repositories: [],
      images: [],
      processes,
      workingDirectories: new Map(),
    });
    const root = result.find((o) => o.objectType === 'Process');
    expect(root?.links).toEqual([]);
  });

  it('produces only observations with complete identities', () => {
    const result = buildPhase1Observations({
      hostname: 'h1',
      repositories: [
        { remoteUrl: 'https://x.invalid/a.git', repoPath: '/a', remoteName: 'origin' },
      ],
      images: [{ id: 'sha256:x', digest: 'sha256:x', repoTags: [] }],
      processes: [{ pid: 10, ppid: 1, commandLine: 'pi', executablePath: 'pi' }],
      workingDirectories: new Map(),
    });
    assertAllIdentitiesComplete(result);
  });
});

const container = (overrides: Partial<ContainerSummary> = {}): ContainerSummary => ({
  id: 'container-1',
  name: 'web',
  image: 'nginx:latest',
  imageDigest: 'sha256:abc',
  state: 'running',
  status: 'Up 3 hours',
  labels: { 'com.docker.compose.project': 'myapp', 'com.docker.compose.service': 'web' },
  ports: [{ privatePort: 8080 }],
  volumeNames: [],
  networkNames: [],
  ...overrides,
});

describe('groupContainersByComposeProject', () => {
  it('groups containers by their compose project label', () => {
    const containers = [
      container({ id: 'c1' }),
      container({
        id: 'c2',
        labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'db' },
      }),
    ];
    const groups = groupContainersByComposeProject(containers);
    expect(groups.map((g) => g.projectName).sort()).toEqual(['myapp', 'other']);
  });

  it('excludes a container with no compose project label', () => {
    const containers = [container({ id: 'c1' }), container({ id: 'c2', labels: {} })];
    const groups = groupContainersByComposeProject(containers);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.containers.map((c) => c.id)).toEqual(['c1']);
  });
});

describe('buildPhase2Observations', () => {
  it('emits a ComposeProject observation with a runs_on link to Host', () => {
    const result = buildPhase2Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjects: [{ projectName: 'myapp', containers: [container()] }],
      volumes: [],
      networks: [],
      systemdServices: [],
    });
    const project = result.find((o) => o.objectType === 'ComposeProject');
    expect(project?.identity).toEqual({ hostId: 'host-id-1', projectName: 'myapp' });
    expect(project?.links).toEqual([
      { linkType: 'runs_on', target: { objectType: 'Host', identity: { hostname: 'h1' } } },
    ]);
  });

  it('emits Volume/Network observations with part_of links when they carry a compose project label', () => {
    const volumes: VolumeSummary[] = [
      { name: 'myapp_data', labels: { 'com.docker.compose.project': 'myapp' } },
    ];
    const networks: NetworkSummary[] = [
      { id: 'net-1', name: 'myapp_default', labels: { 'com.docker.compose.project': 'myapp' } },
    ];
    const result = buildPhase2Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjects: [],
      volumes,
      networks,
      systemdServices: [],
    });
    const volume = result.find((o) => o.objectType === 'Volume');
    expect(volume?.identity).toEqual({ hostId: 'host-id-1', volumeName: 'myapp_data' });
    expect(volume?.links).toEqual([
      {
        linkType: 'part_of',
        target: {
          objectType: 'ComposeProject',
          identity: { hostId: 'host-id-1', projectName: 'myapp' },
        },
      },
    ]);

    const network = result.find((o) => o.objectType === 'Network');
    expect(network?.links?.[0]?.linkType).toBe('part_of');
  });

  it('emits a SystemdService observation with a runs_on link to Host', () => {
    const services: RawSystemdService[] = [
      {
        unitName: 'docker.service',
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        description: 'Docker',
      },
    ];
    const result = buildPhase2Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjects: [],
      volumes: [],
      networks: [],
      systemdServices: services,
    });
    const service = result.find((o) => o.objectType === 'SystemdService');
    expect(service?.identity).toEqual({ hostId: 'host-id-1', unitName: 'docker.service' });
    expect(service?.links).toEqual([
      { linkType: 'runs_on', target: { objectType: 'Host', identity: { hostname: 'h1' } } },
    ]);
  });

  it('produces only observations with complete identities', () => {
    const result = buildPhase2Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjects: [{ projectName: 'myapp', containers: [] }],
      volumes: [{ name: 'v1', labels: {} }],
      networks: [{ id: 'n1', name: 'net1', labels: {} }],
      systemdServices: [
        {
          unitName: 'x.service',
          loadState: 'loaded',
          activeState: 'active',
          subState: 'running',
          description: '',
        },
      ],
    });
    assertAllIdentitiesComplete(result);
  });
});

describe('buildPhase3Observations (acceptance-relevant: Container runs_on Host)', () => {
  it('emits a Container observation with a runs_on link to Host', () => {
    const result = buildPhase3Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjectIds: new Map([['myapp', 'compose-id-1']]),
      composeProjects: [{ projectName: 'myapp', containers: [container()] }],
    });
    expect(result).toHaveLength(1);
    const runsOn = result[0]?.links?.find((l) => l.linkType === 'runs_on');
    expect(runsOn).toEqual({
      linkType: 'runs_on',
      target: { objectType: 'Host', identity: { hostname: 'h1' } },
    });
  });

  it("sets the Container's own identity to {composeProjectId, serviceName}", () => {
    const result = buildPhase3Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjectIds: new Map([['myapp', 'compose-id-1']]),
      composeProjects: [{ projectName: 'myapp', containers: [container()] }],
    });
    expect(result[0]?.identity).toEqual({ composeProjectId: 'compose-id-1', serviceName: 'web' });
  });

  it('emits uses_image/mounts/attached_to/exposes/depends_on/part_of links from the container data', () => {
    const c = container({
      volumeNames: ['myapp_data'],
      networkNames: ['myapp_default'],
      labels: {
        'com.docker.compose.project': 'myapp',
        'com.docker.compose.service': 'web',
        'com.docker.compose.depends_on': 'db',
      },
    });
    const result = buildPhase3Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjectIds: new Map([['myapp', 'compose-id-1']]),
      composeProjects: [{ projectName: 'myapp', containers: [c] }],
    });
    const linkTypes = (result[0]?.links ?? []).map((l) => l.linkType).sort();
    expect(linkTypes).toEqual(
      ['attached_to', 'depends_on', 'exposes', 'mounts', 'part_of', 'runs_on', 'uses_image'].sort(),
    );

    const dependsOn = result[0]?.links?.find((l) => l.linkType === 'depends_on');
    expect(dependsOn?.target).toEqual({
      objectType: 'Container',
      identity: { composeProjectId: 'compose-id-1', serviceName: 'db' },
    });

    const mounts = result[0]?.links?.find((l) => l.linkType === 'mounts');
    expect(mounts?.target).toEqual({
      objectType: 'Volume',
      identity: { hostId: 'host-id-1', volumeName: 'myapp_data' },
    });
  });

  it('skips a project missing from composeProjectIds defensively (no partial/malformed Container)', () => {
    const result = buildPhase3Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjectIds: new Map(), // 'myapp' not resolved
      composeProjects: [{ projectName: 'myapp', containers: [container()] }],
    });
    expect(result).toEqual([]);
  });

  it('produces only observations/link-targets with complete identities', () => {
    const c = container({ volumeNames: ['v1'], networkNames: ['n1'] });
    const result = buildPhase3Observations({
      hostname: 'h1',
      hostId: 'host-id-1',
      composeProjectIds: new Map([['myapp', 'compose-id-1']]),
      composeProjects: [{ projectName: 'myapp', containers: [c] }],
    });
    assertAllIdentitiesComplete(result);
  });
});
