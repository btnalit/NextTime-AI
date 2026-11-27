import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatekeeperBase, InMemoryIdempotencyStore } from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  type FakeContainerSeed,
  createFakeDockerClient,
} from './test-support/fake-docker-client.js';
import { createDockerTransport } from './transport.js';

/**
 * The docker gate's payload budget (legacy 966; legacy 967's design,
 * `docs/tool-result-and-budget-design-2026-11-27.md` §5 in #1622: every packaged gate has one). A model reads a gate's answer through `truncateToolResult`
 * (`packages/platform-extension`, 16,000 characters), and every later model call of the Task reads
 * it again, so a list answer has to fit well under that line. The fixture is a host's worth of
 * compose containers, every field as long as a real one: 40 containers in 4 projects, full ids,
 * registry images (some pinned by digest), `Up … (healthy)` status lines, and the labels compose
 * and an OCI image put on a container (18 of them, with the config hash, the image digest, the
 * compose file's path and the image's revision).
 *
 * Measured on this fixture (2026-11-27): `containers.list` 11,845 characters as compact JSON and
 * 13,766 indented, as the model is shown it until the indentation goes (that design's stage 1);
 * `compose.ls` 11,162 and 14,934; the shape every list returned before, with every label, 56,858
 * and 64,499. The budget is 320 compact characters a container — 12,800 for the 40, four-fifths of
 * the cap, so the cap holds some 50 such containers: a short field more on each still fits (`"health":
 * "healthy"`), a timestamp or a label map does not. When a change here trips it, return the new
 * field from `container.inspect` (one container), or raise the budget in the same PR, with the
 * reason.
 */

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'manifest.json',
);
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Operation[];

const CONTAINERS = 40;
const BUDGET_PER_CONTAINER = 320;
/** `truncateToolResult`'s default cap (`packages/platform-extension/src/modes/gate-tools.ts`). */
const TOOL_RESULT_CAP = 16_000;

function hex(seed: string, length: number): string {
  let out = '';
  for (let i = 0; out.length < length; i += 1) {
    out += createHash('sha256').update(`${seed}:${i}`).digest('hex');
  }
  return out.slice(0, length);
}

const PROJECTS: readonly (readonly [string, readonly string[]])[] = [
  [
    'nexttime-ai',
    [
      'kernel',
      'agent-host',
      'worker-supervisor',
      'llm-proxy',
      'egress-proxy',
      'caddy',
      'postgres',
      'backup',
      'gatekeeper-docker',
      'gatekeeper-ragflow',
      'gate-host',
      'docker-socket-proxy',
      'docker-socket-proxy-gate',
      'collector-host-inventory',
    ],
  ],
  [
    'ragflow',
    ['ragflow-server', 'ragflow-mysql', 'ragflow-redis', 'ragflow-minio', 'ragflow-es-01'],
  ],
  [
    'monitoring',
    ['prometheus', 'grafana', 'node-exporter', 'cadvisor', 'alertmanager', 'loki', 'promtail'],
  ],
  [
    'media-stack',
    [
      'jellyfin',
      'sonarr',
      'radarr',
      'prowlarr',
      'qbittorrent',
      'bazarr',
      'overseerr',
      'tautulli',
      'homepage',
      'watchtower',
      'syncthing',
      'filebrowser',
      'uptime-kuma',
      'vaultwarden',
    ],
  ],
];

/** One container as compose and its image label it. */
function seed(project: string, service: string, index: number): FakeContainerSeed {
  const id = hex(`${project}/${service}`, 64);
  const image =
    index % 3 === 0
      ? `ghcr.io/example-org/${project}-${service}@sha256:${hex(`image/${service}`, 64)}`
      : `registry.example.invalid/${project}/${service}:v2.14.3-alpine`;
  return {
    id,
    name: `${project}-${service}-1`,
    image,
    running: index % 7 !== 6,
    status: 'Up 3 days (healthy)',
    labels: {
      'com.docker.compose.config-hash': hex(`config/${service}`, 64),
      'com.docker.compose.container-number': '1',
      'com.docker.compose.depends_on':
        'postgres:service_healthy:false,llm-proxy:service_started:false',
      'com.docker.compose.image': `sha256:${hex(`local/${service}`, 64)}`,
      'com.docker.compose.oneoff': 'False',
      'com.docker.compose.project': project,
      'com.docker.compose.project.config_files': `/srv/${project}/docker-compose.yml`,
      'com.docker.compose.project.working_dir': `/srv/${project}`,
      'com.docker.compose.service': service,
      'com.docker.compose.version': '2.29.7',
      'org.opencontainers.image.created': '2026-11-20T08:14:03.512Z',
      'org.opencontainers.image.description': `${service} for the ${project} stack`,
      'org.opencontainers.image.licenses': 'Apache-2.0',
      'org.opencontainers.image.revision': hex(`revision/${service}`, 40),
      'org.opencontainers.image.source': `https://example.invalid/example-org/${project}`,
      'org.opencontainers.image.title': service,
      'org.opencontainers.image.url': `https://example.invalid/example-org/${project}`,
      'org.opencontainers.image.version': 'v2.14.3',
    },
  };
}

const SEEDS = PROJECTS.flatMap(([project, services]) =>
  services.map((service) => [project, service] as const),
).map(([project, service], index) => seed(project, service, index));

function buildGate() {
  const client = createFakeDockerClient(SEEDS);
  const gate = new GatekeeperBase({
    manifest: MANIFEST,
    transport: createDockerTransport(client),
    credentialResolver: { resolve: async () => ({}) },
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  return { gate, client };
}

/** Compact, and as `packages/platform-extension` renders a gate's answer for the model today. */
function sizes(data: unknown): { compact: number; indented: number } {
  return { compact: JSON.stringify(data).length, indented: JSON.stringify(data, null, 2).length };
}

describe('docker gate payload budget (legacy 966)', () => {
  it('the fixture is a host of 40 compose containers whose labels alone would overflow the cap', async () => {
    const { client } = buildGate();
    const summaries = await client.listContainers({ all: true });
    expect(summaries).toHaveLength(CONTAINERS);
    expect(Object.keys(summaries[0]?.labels ?? {})).toHaveLength(18);
    // The shape every list returned before: the budget below would fail on it.
    expect(sizes(summaries).compact).toBeGreaterThan(2 * TOOL_RESULT_CAP);
  });

  for (const [operation, params] of [
    ['containers.list', { all: true }],
    ['compose.ls', {}],
  ] as const) {
    it(`${operation}: ${BUDGET_PER_CONTAINER} compact characters a container, under the cap as the model is shown it today`, async () => {
      const { gate } = buildGate();
      const { data } = await gate.observe(operation, params);
      const { compact, indented } = sizes(data);
      expect(compact).toBeLessThanOrEqual(CONTAINERS * BUDGET_PER_CONTAINER);
      expect(indented).toBeLessThan(TOOL_RESULT_CAP);
    });
  }

  it('compose.up and compose.down for the largest project, simulate and result, stay within the same budget', async () => {
    const { gate } = buildGate();
    const project = 'nexttime-ai';
    for (const name of ['compose.up', 'compose.down']) {
      const simulated = await gate.simulate(name, { project });
      const applied = await gate.apply(name, { project }, `req-${name}`);
      for (const data of [simulated.detail, applied.data]) {
        expect(sizes(data).compact).toBeLessThanOrEqual(CONTAINERS * BUDGET_PER_CONTAINER);
      }
    }
  });
});
