import {
  PLATFORM_STATE_IMAGES_LIMIT,
  type PlatformUpdatesWire,
  type ResidentContainerWire,
  type RuntimeImageWire,
  type RuntimeInventoryWire,
  type ServiceHealthWire,
  getCapability,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import { INVARIANT_CHECK_IDS } from '../../substrate/audit/index.js';
import { findAddressLike } from './platform-state-probes.js';
import {
  projectInvariantsState,
  projectRuntimeImage,
  projectRuntimeState,
  projectUpdatesState,
} from './platform-state-runtime.js';

/**
 * application/admin-agent/platform-state-runtime.test (S11 AA2b; pure, no database): the runtime,
 * update and invariant projections against hostile sources, the same way platform-state.test.ts
 * tries the database-backed ones. Every field a projection drops carries a unique canary; every
 * string it passes is tried with values shaped like an address, a path or a credential.
 *
 * Private addresses are assembled at run time: CI's IP-literal guard reads test files too.
 */

const PRIVATE_V4 = [10, 20, 30, 40].join('.');
const PRIVATE_V4_B = [192, 168, 7, 9].join('.');
const ULA_V6 = ['fd12', '3456', '789a', '', '1'].join(':');
const HOSTILE_STRINGS = [
  PRIVATE_V4,
  `${PRIVATE_V4_B}:5432`,
  `[${ULA_V6}]:8443`,
  'registry.internal.example:5000',
  `https://user:pw@${PRIVATE_V4}/x`,
  '/var/lib/canary-hostile-path',
  `sk-${'a1B2'.repeat(12)}`,
  ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.'),
  'ops@registry.internal.example',
] as const;

const T0 = '2026-10-30T08:00:00.000Z';
const T1 = '2026-11-01T11:00:00.000Z';
const NOW = '2026-11-01T12:00:00.000Z';

const DIGEST_A = `sha256:${'a3f9'.repeat(16)}`;
const DIGEST_B = `sha256:${'b7d4'.repeat(16)}`;

function expectClean(capabilityName: string, out: unknown): void {
  expect(JSON.stringify(out), capabilityName).not.toMatch(/canary/i);
  expect(findSuspectedSecrets(out).count, capabilityName).toBe(0);
  expect(findSuspectedSecrets(out, { secretFields: true }).paths, capabilityName).toEqual([]);
  expect(findAddressLike(out), capabilityName).toEqual([]);
  const parsed = getCapability(capabilityName)?.resultSchema?.safeParse(out);
  expect(parsed?.success, `${capabilityName} ${JSON.stringify(parsed?.error?.issues)}`).toBe(true);
}

function hostileImage(overrides: Partial<RuntimeImageWire> = {}): RuntimeImageWire {
  return {
    id: DIGEST_A,
    tags: [
      `${PRIVATE_V4}:5000/nexttime-ai-worker-runtime:canary-runtime-tag`,
      'registry.internal.example:5000/canary-runtime-tag-b',
    ],
    // the container engine's own form, to the nanosecond
    createdAt: '2026-10-31T09:15:00.123456789Z',
    piVersion: '0.73.1',
    platformExtensionVersion: '1.4.0',
    builtFrom: 'c849da6',
    labels: {
      'ai.nexttime.pi-version': '0.73.1',
      'canary-runtime-label-key': `https://${PRIVATE_V4}/canary-runtime-label-value`,
    },
    allowed: true,
    activatableRef: `${PRIVATE_V4}:5000/canary-runtime-activatable`,
    runtimeCompatible: true,
    ...overrides,
  };
}

function resident(overrides: Partial<ResidentContainerWire> = {}): ResidentContainerWire {
  return {
    principalId: 'canary-runtime-resident-principal',
    workspaceId: 'canary-runtime-resident-workspace',
    containerId: 'canary-runtime-container-id',
    running: true,
    status: 'canary-runtime-status-text',
    image: `${PRIVATE_V4}:5000/canary-runtime-resident-image`,
    imageId: DIGEST_A,
    startedAt: T0,
    lastTouchedAt: T1,
    needsRebuild: false,
    ...overrides,
  };
}

function hostileInventory(overrides: Partial<RuntimeInventoryWire> = {}): RuntimeInventoryWire {
  return {
    activeImage: `${PRIVATE_V4}:5000/nexttime-ai-worker-runtime:canary-runtime-active`,
    activeImageSource: 'setting',
    activeImageInfo: hostileImage(),
    images: [
      hostileImage({
        id: DIGEST_B,
        createdAt: '2026-10-20T00:00:00Z',
        piVersion: 'dev',
        platformExtensionVersion: null,
        builtFrom: 'dev',
        allowed: false,
        runtimeCompatible: null,
      }),
      hostileImage(),
      // An id out of shape: dropped, still counted.
      hostileImage({ id: 'canary-runtime-not-a-digest' }),
    ],
    residentContainers: [
      resident(),
      resident({ needsRebuild: true, imageId: DIGEST_B }),
      resident({ running: false, imageId: null, startedAt: null }),
    ],
    checkedAt: T1,
    ...overrides,
  };
}

const HOSTILE_SERVICES: ServiceHealthWire[] = [
  { service: 'kernel', status: 'ok' },
  { service: 'postgres', status: 'ok' },
  {
    service: 'llm-proxy',
    status: 'down',
    detail: `TypeError: fetch failed connect ECONNREFUSED ${PRIVATE_V4}:8082 canary-runtime-err`,
  },
  { service: 'worker-supervisor', status: 'ok', detail: 'HTTP 200 canary-runtime-detail' },
  { service: 'egress-proxy', status: 'unknown', detail: 'canary-runtime-egress-detail' },
  // a gate's entry: its display name is the service name — never passed
  { service: 'gate:canary-runtime-gate-name', status: 'down' },
  // a duplicate keeps the first
  { service: 'kernel', status: 'down' },
];

describe('platform_state_runtime projection', () => {
  it('keeps digests, versions, verdicts and counts; no tag, label, container, address or text', () => {
    const out = projectRuntimeState(hostileInventory(), HOSTILE_SERVICES, NOW);
    expectClean('platform_state_runtime', out);
    expect(out).toEqual({
      activeImage: {
        source: 'setting',
        digest: DIGEST_A,
        piVersion: '0.73.1',
        platformExtensionVersion: '1.4.0',
        builtFrom: 'c849da6',
        runtimeCompatible: true,
      },
      images: [
        {
          digest: DIGEST_A,
          createdAt: '2026-10-31T09:15:00.123Z',
          piVersion: '0.73.1',
          platformExtensionVersion: '1.4.0',
          builtFrom: 'c849da6',
          allowed: true,
          runtimeCompatible: true,
          active: true,
        },
        {
          digest: DIGEST_B,
          createdAt: '2026-10-20T00:00:00.000Z',
          piVersion: 'dev',
          platformExtensionVersion: null,
          builtFrom: 'dev',
          allowed: false,
          runtimeCompatible: null,
          active: false,
        },
      ],
      imageCount: 3,
      entryContainers: { total: 3, running: 2, needsRebuild: 1 },
      services: [
        { service: 'kernel', status: 'ok' },
        { service: 'postgres', status: 'ok' },
        { service: 'llm-proxy', status: 'down' },
        { service: 'worker-supervisor', status: 'ok' },
        { service: 'egress-proxy', status: 'unknown' },
      ],
      checkedAt: NOW,
    });
  });

  it('nulls a version, commit or verdict out of shape, and drops an image without identity', () => {
    for (const hostile of HOSTILE_STRINGS) {
      const image = projectRuntimeImage(
        hostileImage({
          piVersion: hostile,
          platformExtensionVersion: hostile,
          builtFrom: hostile,
          runtimeCompatible: hostile as unknown as boolean,
          allowed: hostile as unknown as boolean,
        }),
        DIGEST_A,
      );
      expect(image, hostile).toMatchObject({
        piVersion: null,
        platformExtensionVersion: null,
        builtFrom: null,
        runtimeCompatible: null,
        allowed: false,
      });
      expect(projectRuntimeImage(hostileImage({ id: hostile }), null), hostile).toBeNull();
      expect(projectRuntimeImage(hostileImage({ createdAt: hostile }), null), hostile).toBeNull();
      const out = projectRuntimeState(
        hostileInventory({
          activeImageSource: hostile as RuntimeInventoryWire['activeImageSource'],
          activeImageInfo: hostileImage({ id: hostile, piVersion: hostile }),
          images: [hostileImage({ builtFrom: hostile })],
        }),
        [
          { service: hostile, status: 'ok' },
          { service: 'kernel', status: hostile as 'ok' },
        ],
        NOW,
      );
      expectClean('platform_state_runtime', out);
      expect(out.activeImage, hostile).toEqual({
        source: 'unknown',
        digest: null,
        piVersion: null,
        platformExtensionVersion: '1.4.0',
        builtFrom: 'c849da6',
        runtimeCompatible: true,
      });
      expect(out.services, hostile).toEqual([]);
    }
  });

  it('an unresolved active image, an unreachable supervisor, more images than the limit', () => {
    const unresolved = projectRuntimeState(
      hostileInventory({
        activeImage: null,
        activeImageSource: 'unknown',
        activeImageInfo: null,
        images: [],
        residentContainers: [],
      }),
      [],
      NOW,
    );
    expectClean('platform_state_runtime', unresolved);
    expect(unresolved.activeImage).toEqual({
      source: 'unknown',
      digest: null,
      piVersion: null,
      platformExtensionVersion: null,
      builtFrom: null,
      runtimeCompatible: null,
    });
    expect(unresolved.images).toEqual([]);
    expect(unresolved.entryContainers).toEqual({ total: 0, running: 0, needsRebuild: 0 });

    const many = Array.from({ length: PLATFORM_STATE_IMAGES_LIMIT + 5 }, (_, i) =>
      hostileImage({
        id: `sha256:${i.toString(16).padStart(4, '0').repeat(16)}`,
        createdAt: new Date(Date.parse(T0) + i * 60_000).toISOString(),
      }),
    );
    const out = projectRuntimeState(hostileInventory({ images: many }), [], NOW);
    expectClean('platform_state_runtime', out);
    expect(out.images).toHaveLength(PLATFORM_STATE_IMAGES_LIMIT);
    expect(out.imageCount).toBe(PLATFORM_STATE_IMAGES_LIMIT + 5);
    // newest first
    expect(out.images[0]?.createdAt).toBe(many.at(-1)?.createdAt);
  });

  it('spreads nothing: a field the source gains changes nothing', () => {
    const base = projectRuntimeState(hostileInventory(), HOSTILE_SERVICES, NOW);
    const widened = projectRuntimeState(
      {
        ...hostileInventory({
          activeImageInfo: { ...hostileImage(), canaryExtra: 'canary-runtime-extra' } as never,
          images: [{ ...hostileImage(), canaryExtra: 'canary-runtime-extra' } as never],
        }),
        canaryExtra: 'canary-runtime-extra',
      } as never,
      HOSTILE_SERVICES.map((entry) => ({ ...entry, canaryExtra: 'canary' }) as never),
      NOW,
    );
    expect(JSON.stringify(widened)).not.toMatch(/canary/i);
    expect(Object.keys(widened)).toEqual(Object.keys(base));
    expect(Object.keys(widened.activeImage)).toEqual(Object.keys(base.activeImage));
    expect(Object.keys(widened.images[0] ?? {})).toEqual(Object.keys(base.images[0] ?? {}));
  });
});

function hostileUpdates(overrides: Partial<PlatformUpdatesWire> = {}): PlatformUpdatesWire {
  return {
    platformUpdate: {
      currentVersion: 'v0.50.0',
      latestVersion: 'v0.58.0',
      available: true,
      newerReleases: [
        {
          version: 'v0.58.0',
          previousVersion: 'v0.57.0',
          publishedAt: T1,
          pi: '0.73.1',
          migrations: ['core 0049', 'goal 0016'],
          breaking: false,
          notesUrl: 'https://github.com/canary/canary-updates-notes/releases/tag/v0.58.0',
        },
        {
          version: 'v0.57.0',
          previousVersion: 'v0.56.0',
          publishedAt: T0,
          pi: null,
          migrations: [],
          breaking: true,
          notesUrl: 'https://github.com/canary/canary-updates-notes/releases/tag/v0.57.0',
        },
      ],
      migrations: ['core 0049', 'goal 0016', 'canary-updates-migration'],
      migrationsIncomplete: true,
      breaking: true,
      notesUrl: 'https://github.com/canary/canary-updates-notes/releases/tag/v0.58.0',
      prefetchCommands: [
        'git fetch -q origin --tags',
        'git show v0.58.0:scripts/apply-release.sh > /tmp/canary-updates-apply.sh',
      ],
      applyCommand: 'sh /tmp/canary-updates-apply.sh --pull v0.58.0',
      rollbackVersion: 'v0.50.0',
    },
    piUpdate: {
      state: 'released',
      bundledVersion: '0.71.0',
      activeImageVersion: '0.71.0',
      upstreamLatest: '0.73.1',
      sdkSuite: 'pass',
      failureSummary: `canary-updates-failure ${PRIVATE_V4}`,
      bundledIn: 'v0.58.0',
      checkedAt: T1,
      runUrl: 'https://github.com/canary/canary-updates-run/actions/runs/1',
    },
    feedFreshness: {
      status: 'stale',
      staleCause: 'ci',
      fetchedAt: T1,
      generatedAt: T0,
      maxAgeHours: 48,
      detail: 'update feed /data/config/update-feed/channel.json canary-updates-detail',
    },
    checkedAt: T1,
    ...overrides,
  };
}

describe('platform_state_updates projection', () => {
  it('keeps versions, counts and verdicts; no link, command, failure text or feed text', () => {
    const out = projectUpdatesState(hostileUpdates(), NOW);
    expectClean('platform_state_updates', out);
    expect(out).toEqual({
      platform: {
        currentVersion: 'v0.50.0',
        latestVersion: 'v0.58.0',
        available: true,
        breaking: true,
        migrationsPending: ['core 0049', 'goal 0016'],
        migrationCount: 3,
        migrationsIncomplete: true,
        newerReleases: [
          { version: 'v0.58.0', publishedAt: T1, breaking: false, pi: '0.73.1', migrationCount: 2 },
          { version: 'v0.57.0', publishedAt: T0, breaking: true, pi: null, migrationCount: 0 },
        ],
        rollbackVersion: 'v0.50.0',
      },
      pi: {
        state: 'released',
        bundledVersion: '0.71.0',
        activeImageVersion: '0.71.0',
        upstreamLatest: '0.73.1',
        sdkSuite: 'pass',
        bundledIn: 'v0.58.0',
        checkedAt: T1,
      },
      feed: {
        status: 'stale',
        staleCause: 'ci',
        fetchedAt: T1,
        generatedAt: T0,
        maxAgeHours: 48,
      },
      checkedAt: NOW,
    });
  });

  it('nulls a version or time out of shape and drops a release without one', () => {
    for (const hostile of HOSTILE_STRINGS) {
      const base = hostileUpdates();
      const update = base.platformUpdate as NonNullable<PlatformUpdatesWire['platformUpdate']>;
      const [newest, older] = update.newerReleases as [
        (typeof update.newerReleases)[number],
        (typeof update.newerReleases)[number],
      ];
      const out = projectUpdatesState(
        {
          ...base,
          platformUpdate: {
            ...update,
            currentVersion: hostile,
            latestVersion: hostile,
            rollbackVersion: hostile,
            migrations: [hostile, 'core 0049'],
            newerReleases: [
              { ...newest, version: hostile },
              { ...older, pi: hostile, publishedAt: T0 },
            ],
          },
          piUpdate: {
            ...base.piUpdate,
            state: hostile as 'released',
            bundledVersion: hostile,
            activeImageVersion: hostile,
            upstreamLatest: hostile,
            sdkSuite: hostile as 'pass',
            bundledIn: hostile,
            checkedAt: hostile,
          },
          feedFreshness: {
            ...base.feedFreshness,
            status: hostile as 'fresh',
            staleCause: hostile as 'ci',
            fetchedAt: hostile,
            generatedAt: hostile,
          },
        },
        NOW,
      );
      expectClean('platform_state_updates', out);
      expect(out.platform, hostile).toMatchObject({
        currentVersion: null,
        latestVersion: null,
        rollbackVersion: null,
        migrationsPending: ['core 0049'],
        migrationCount: 2,
        newerReleases: [{ version: 'v0.57.0', pi: null }],
      });
      expect(out.pi, hostile).toEqual({
        state: 'unknown',
        bundledVersion: null,
        activeImageVersion: null,
        upstreamLatest: null,
        sdkSuite: null,
        bundledIn: null,
        checkedAt: null,
      });
      expect(out.feed, hostile).toEqual({
        status: 'invalid',
        staleCause: null,
        fetchedAt: null,
        generatedAt: null,
        maxAgeHours: 48,
      });
    }
  });

  it('a missing record has no platform part', () => {
    const out = projectUpdatesState(
      hostileUpdates({
        platformUpdate: null,
        feedFreshness: {
          status: 'missing',
          staleCause: null,
          fetchedAt: null,
          generatedAt: null,
          maxAgeHours: 48,
          detail: 'no update feed at /data/config/update-feed/channel.json canary-updates-missing',
        },
      }),
      NOW,
    );
    expectClean('platform_state_updates', out);
    expect(out.platform).toBeNull();
    expect(out.feed.status).toBe('missing');
  });
});

describe('platform_state_invariants projection', () => {
  const ranAt = new Date(T1);

  it('counts per known invariant and the overall status, never a sample', () => {
    const results = INVARIANT_CHECK_IDS.map((invariant, i) => ({
      invariant,
      violations: i === 2 ? 3 : 0,
      sample: [`canary-invariants-sample-${invariant}`, PRIVATE_V4],
    }));
    const out = projectInvariantsState({ results, lastRunAt: ranAt }, NOW);
    expectClean('platform_state_invariants', out);
    expect(out.status).toBe('violations');
    expect(out.lastRunAt).toBe(T1);
    expect(out.checks).toEqual(
      INVARIANT_CHECK_IDS.map((invariant, i) => ({ invariant, violations: i === 2 ? 3 : 0 })),
    );
    expect(out.checkedAt).toBe(NOW);
  });

  it('clean when nothing is violated; not_run before the first check or with no store', () => {
    const clean = projectInvariantsState(
      { results: [{ invariant: 'I4', violations: 0, sample: [] }], lastRunAt: ranAt },
      NOW,
    );
    expectClean('platform_state_invariants', clean);
    expect(clean).toEqual({
      status: 'clean',
      lastRunAt: T1,
      checks: [{ invariant: 'I4', violations: 0 }],
      checkedAt: NOW,
    });
    for (const snapshot of [undefined, { results: [], lastRunAt: null }]) {
      const out = projectInvariantsState(snapshot, NOW);
      expectClean('platform_state_invariants', out);
      expect(out).toEqual({ status: 'not_run', lastRunAt: null, checks: [], checkedAt: NOW });
    }
  });

  it('an unknown or hostile id is left out of the list but still counts towards the status', () => {
    for (const hostile of [...HOSTILE_STRINGS, 'I-canary-unknown', 'ops.canary_unknown']) {
      const out = projectInvariantsState(
        {
          results: [
            { invariant: hostile, violations: 2, sample: ['canary-invariants-x'] },
            { invariant: 'I6', violations: -4, sample: [] },
          ],
          lastRunAt: ranAt,
        },
        NOW,
      );
      expectClean('platform_state_invariants', out);
      expect(out.checks, hostile).toEqual([{ invariant: 'I6', violations: 0 }]);
      expect(out.status, hostile).toBe('violations');
    }
  });
});
