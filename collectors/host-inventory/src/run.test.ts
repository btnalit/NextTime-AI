import { describe, expect, it, vi } from 'vitest';
import type { CollectorConfig } from './config.js';
import type { ContainerSummary, DockerClient, HostInfo } from './docker-client.js';
import type {
  KernelClient,
  ObserveOperationParams,
  ObserveOperationResult,
  RegisterSourceParams,
  RegisterSourceResult,
  SubmitObservationsParams,
  SubmitObservationsResult,
} from './kernel-client.js';
import { KernelClientError } from './kernel-client.js';
import type { RunOptions, RunSummary } from './run.js';
import { RunFailedError, runOnce } from './run.js';

/**
 * Wraps `runOnce` with a hermetic default `processTreeOverride` (`{skipped: true, processes: []}`)
 * so these tests behave identically regardless of the *real* OS/`/proc` this test suite happens to
 * run on — without this, `collectProcessTree()`'s own real `/proc`-backed reader (invoked whenever
 * a test omits `processTreeOverride`) sees nothing on this repo's Windows dev machines (`/proc`
 * does not exist there) but sees the *actual CI runner's own real process list* on Linux CI, which
 * can legitimately contain a command line `redact.ts`'s tier-2 sniff flags as secret-shaped —
 * exactly what broke this suite on GitHub Actions before this wrapper existed (a real, environment-
 * dependent hermeticity bug this task's own CI run caught). Every test that specifically exercises
 * process-tree/sanitization behavior still passes its own explicit `processTreeOverride`, which
 * this shallow merge preserves unchanged.
 */
async function run(options: RunOptions): Promise<RunSummary> {
  return runOnce({ processTreeOverride: { skipped: true, processes: [] }, ...options });
}

function baseConfig(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    kernelUrl: 'http://kernel:8080',
    handleTokenFile: '/does/not/matter',
    dockerHost: undefined,
    runSystemdPath: '/definitely/does/not/exist', // systemd collection skips cleanly
    repositoryPaths: [],
    once: true,
    intervalMs: 1000,
    sourceName: 'host-inventory',
    sourceKind: 'host-inventory-collector',
    ragflowGatekeeperId: undefined,
    ...overrides,
  };
}

const container = (overrides: Partial<ContainerSummary> = {}): ContainerSummary => ({
  id: 'container-1',
  name: 'web',
  image: 'nginx:latest',
  imageDigest: 'sha256:abc',
  state: 'running',
  status: 'Up',
  labels: { 'com.docker.compose.project': 'myapp', 'com.docker.compose.service': 'web' },
  ports: [],
  volumeNames: [],
  networkNames: [],
  ...overrides,
});

function fakeDockerClient(overrides: Partial<DockerClient> = {}): DockerClient {
  return {
    info: async (): Promise<HostInfo> => ({ hostname: 'h1' }),
    listContainers: async () => [container()],
    listImages: async () => [],
    listNetworks: async () => [],
    listVolumes: async () => [],
    ping: async () => true,
    ...overrides,
  };
}

function fakeKernelClient(
  overrides: {
    registerSource?: (params: RegisterSourceParams) => Promise<RegisterSourceResult>;
    submitObservations?: (params: SubmitObservationsParams) => Promise<SubmitObservationsResult>;
    observeOperation?: (params: ObserveOperationParams) => Promise<ObserveOperationResult>;
  } = {},
): {
  client: KernelClient;
  calls: {
    registerSource: number;
    submitObservations: SubmitObservationsParams[];
    observeOperation: ObserveOperationParams[];
  };
} {
  const calls = {
    registerSource: 0,
    submitObservations: [] as SubmitObservationsParams[],
    observeOperation: [] as ObserveOperationParams[],
  };

  const client: KernelClient = {
    registerSource: async (params) => {
      calls.registerSource += 1;
      if (overrides.registerSource) return overrides.registerSource(params);
      return {
        id: 'src-1',
        kind: params.kind,
        name: params.name,
        ownerPrincipalId: 'svc-1',
        visibility: params.visibility,
      };
    },
    submitObservations: async (params) => {
      calls.submitObservations.push(params);
      if (overrides.submitObservations) return overrides.submitObservations(params);

      // Dispatch by which ObjectType(s) this call's own observations carry — robust across
      // multiple `runOnce` calls sharing one fake client (unlike a closure-scoped call counter,
      // which would keep incrementing across runs and misclassify the second run's own phase 1).
      const objectTypes = new Set(params.observations.map((o) => o.objectType));
      if (objectTypes.has('Host')) {
        // Phase 1: resolve Host's graph id.
        return {
          activityId: 'act-1',
          objectsUpserted: params.observations.length,
          factsAsserted: 0,
          factsSuperseded: 0,
          objects: [{ objectType: 'Host', identity: { hostname: 'h1' }, id: 'host-graph-id-1' }],
        };
      }
      if (objectTypes.has('ComposeProject')) {
        // Phase 2: resolve each ComposeProject's graph id.
        const projectNames = params.observations
          .filter((o) => o.objectType === 'ComposeProject')
          .map((o) => String(o.identity.projectName));
        return {
          activityId: 'act-1',
          objectsUpserted: params.observations.length,
          factsAsserted: params.observations.length,
          factsSuperseded: 0,
          objects: projectNames.map((projectName) => ({
            objectType: 'ComposeProject',
            identity: { hostId: 'host-graph-id-1', projectName },
            id: `compose-graph-id-${projectName}`,
          })),
        };
      }
      if (objectTypes.has('Container')) {
        // Phase 3: Container.
        return {
          activityId: 'act-1',
          objectsUpserted: params.observations.length,
          factsAsserted: params.observations.length,
          factsSuperseded: 0,
          objects: [],
        };
      }
      // Phase 4 (S3.4): KnowledgeBase/Document.
      return {
        activityId: 'act-1',
        objectsUpserted: params.observations.length,
        factsAsserted: params.observations.length,
        factsSuperseded: 0,
        objects: [],
      };
    },
    observeOperation: async (params) => {
      calls.observeOperation.push(params);
      if (overrides.observeOperation) return overrides.observeOperation(params);
      return { status: 'ok', data: { code: 0, data: [] }, observedFactCount: 0 };
    },
  };

  return { client, calls };
}

describe('runOnce', () => {
  it('submits three dependency-ordered phases sharing one activityId', async () => {
    const { client: kernelClient, calls } = fakeKernelClient();

    const summary = await run({
      config: baseConfig(),
      dockerClient: fakeDockerClient(),
      kernelClient,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(calls.submitObservations).toHaveLength(3);
    expect(
      calls.submitObservations.every(
        (p) => p.activityId === 'act-1' || p === calls.submitObservations[0],
      ),
    ).toBe(true);
    // phase 1 has no activityId (creates one); phases 2/3 reuse it.
    expect(calls.submitObservations[0]?.activityId).toBeUndefined();
    expect(calls.submitObservations[1]?.activityId).toBe('act-1');
    expect(calls.submitObservations[2]?.activityId).toBe('act-1');

    // phase 1: Host (+ no repos/images/processes in this fixture).
    expect(calls.submitObservations[0]?.observations.some((o) => o.objectType === 'Host')).toBe(
      true,
    );
    // phase 2: ComposeProject using the resolved Host id.
    const composeProject = calls.submitObservations[1]?.observations.find(
      (o) => o.objectType === 'ComposeProject',
    );
    expect(composeProject?.identity).toEqual({ hostId: 'host-graph-id-1', projectName: 'myapp' });
    // phase 3: Container using the resolved ComposeProject id.
    const containerObservation = calls.submitObservations[2]?.observations.find(
      (o) => o.objectType === 'Container',
    );
    expect(containerObservation?.identity).toEqual({
      composeProjectId: 'compose-graph-id-myapp',
      serviceName: 'web',
    });

    expect(summary.activityId).toBe('act-1');
  });

  it('S5.3: registers its Source on every run with the same (kind, name) and keeps no local state — the kernel is idempotent', async () => {
    const { client: kernelClient, calls } = fakeKernelClient({
      registerSource: async (params) => {
        expect(params).toEqual({
          kind: 'host-inventory-collector',
          name: 'host-inventory',
          visibility: 'workspace',
        });
        return {
          id: 'src-1',
          kind: params.kind,
          name: params.name,
          ownerPrincipalId: 'svc-1',
          visibility: 'workspace',
          created: calls.registerSource === 1,
        };
      },
    });

    await run({ config: baseConfig(), dockerClient: fakeDockerClient(), kernelClient });
    await run({ config: baseConfig(), dockerClient: fakeDockerClient(), kernelClient });
    expect(calls.registerSource).toBe(2);
    for (const submission of calls.submitObservations) {
      expect(submission.sourceId).toBe('src-1');
    }
  });

  it('aborts before any kernel call when a process command line resists sanitization (S3.3 acceptance)', async () => {
    const { client: kernelClient, calls } = fakeKernelClient();
    const opaqueToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'; // gitleaks:allow (synthetic fixture)

    await expect(
      run({
        config: baseConfig(),
        dockerClient: fakeDockerClient(),
        kernelClient,
        processTreeOverride: {
          skipped: false,
          processes: [
            { pid: 10, ppid: 1, commandLine: 'myapp --token=abc', executablePath: 'myapp' },
            {
              pid: 11,
              ppid: 10,
              commandLine: `myapp --send ${opaqueToken}`,
              executablePath: 'myapp',
            },
          ],
        },
        logger: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(RunFailedError);

    expect(calls.registerSource).toBe(0);
    expect(calls.submitObservations).toHaveLength(0);
  });

  it('a batch with only clean command lines is redacted and submitted normally', async () => {
    const { client: kernelClient, calls } = fakeKernelClient();

    await run({
      config: baseConfig(),
      dockerClient: fakeDockerClient(),
      kernelClient,
      processTreeOverride: {
        skipped: false,
        processes: [
          { pid: 10, ppid: 1, commandLine: 'myapp --token=abc', executablePath: 'myapp' },
        ],
      },
    });

    const phase1Process = calls.submitObservations[0]?.observations.find(
      (o) => o.objectType === 'Process',
    );
    expect((phase1Process?.properties as { commandLine: string }).commandLine).toBe(
      'myapp --token=***',
    );
  });

  it('throws RunFailedError (not a raw error) when the Docker Engine API is unreachable, and calls no kernel API', async () => {
    const { client: kernelClient, calls } = fakeKernelClient();
    const dockerClient = fakeDockerClient({
      info: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    await expect(run({ config: baseConfig(), dockerClient, kernelClient })).rejects.toThrow(
      RunFailedError,
    );
    expect(calls.registerSource).toBe(0);
    expect(calls.submitObservations).toHaveLength(0);
  });

  it('S5.2: phase 3 is still submitted with no compose-managed container — empty, carrying the observation window', async () => {
    const { client: kernelClient, calls } = fakeKernelClient();
    const dockerClient = fakeDockerClient({ listContainers: async () => [] });

    await run({ config: baseConfig(), dockerClient, kernelClient });
    expect(calls.submitObservations).toHaveLength(3);
    const phase3 = calls.submitObservations[2];
    expect(phase3?.observations).toEqual([]);
    expect(phase3?.window?.complete).toBe(true);
    // Docker-backed types are always in the window; the optional scans only when they ran (this
    // fixture's process tree is `skipped` and no repository path is configured).
    expect(phase3?.window?.objectTypes).toEqual(
      expect.arrayContaining(['Host', 'Container', 'ComposeProject', 'Image']),
    );
    expect(phase3?.window?.objectTypes).not.toContain('Process');
    expect(phase3?.window?.objectTypes).not.toContain('Repository');
  });

  describe('phase 4 (S3.4, ragflow — optional, non-fatal)', () => {
    it('never calls observe_operation when ragflowGatekeeperId is unset (default)', async () => {
      const { client: kernelClient, calls } = fakeKernelClient();

      const summary = await run({
        config: baseConfig(),
        dockerClient: fakeDockerClient(),
        kernelClient,
      });

      expect(calls.observeOperation).toHaveLength(0);
      expect(calls.submitObservations).toHaveLength(3); // phases 1-3 only.
      expect(summary.activityId).toBe('act-1');
    });

    it('when set, calls kb.list/kb.documents and submits a fourth phase under the same activityId, folded into the summary', async () => {
      const { client: kernelClient, calls } = fakeKernelClient({
        observeOperation: async (params) => {
          if (params.operation === 'kb.list') {
            return {
              status: 'ok',
              data: { code: 0, data: [{ id: 'ds1', name: 'kb-1' }], total_datasets: 1 },
              observedFactCount: 1,
            };
          }
          return {
            status: 'ok',
            data: { code: 0, data: { docs: [{ id: 'doc1', name: 'a.pdf' }], total: 1 } },
            observedFactCount: 1,
          };
        },
      });

      const summary = await run({
        config: baseConfig({ ragflowGatekeeperId: 'gk-1' }),
        dockerClient: fakeDockerClient(),
        kernelClient,
      });

      expect(calls.observeOperation.map((p) => p.operation)).toEqual(['kb.list', 'kb.documents']);
      expect(calls.submitObservations).toHaveLength(4);
      const phase4 = calls.submitObservations[3];
      expect(phase4?.activityId).toBe('act-1');
      expect(phase4?.observations.map((o) => o.objectType)).toEqual(['KnowledgeBase', 'Document']);
      expect(phase4?.window).toEqual({
        complete: true,
        objectTypes: ['KnowledgeBase', 'Document'],
      });
      // 3 phases * 1 observation (Host) + phase 2/3's own counts + phase 4's own 2 — just confirm
      // phase 4's own contribution shows up (exact totals for phases 1-3 covered by other tests).
      expect(summary.factsAsserted).toBeGreaterThanOrEqual(2);
      expect(summary.activityId).toBe('act-1');
    });

    it('logs a warning and completes the run normally when kb.list throws (RAGFlow being down is not fatal)', async () => {
      const { client: kernelClient, calls } = fakeKernelClient({
        observeOperation: async () => {
          throw new KernelClientError(
            'observe_operation',
            503,
            'gate_unreachable',
            'connect refused',
          );
        },
      });
      const warn = vi.fn();

      const summary = await run({
        config: baseConfig({ ragflowGatekeeperId: 'gk-1' }),
        dockerClient: fakeDockerClient(),
        kernelClient,
        logger: { info: vi.fn(), warn },
      });

      expect(calls.submitObservations).toHaveLength(3); // phase 4's own submit never happens.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('ragflow observation phase failed'),
        expect.objectContaining({ gatekeeperId: 'gk-1' }),
      );
      expect(summary.activityId).toBe('act-1');
    });

    it('S5.2: an empty KnowledgeBase list still submits phase 4 — empty, with its own window', async () => {
      const { client: kernelClient, calls } = fakeKernelClient({
        observeOperation: async () => ({
          status: 'ok',
          data: { code: 0, data: [] },
          observedFactCount: 0,
        }),
      });

      await run({
        config: baseConfig({ ragflowGatekeeperId: 'gk-1' }),
        dockerClient: fakeDockerClient(),
        kernelClient,
      });

      expect(calls.observeOperation.map((p) => p.operation)).toEqual(['kb.list']);
      expect(calls.submitObservations).toHaveLength(4);
      const phase4 = calls.submitObservations[3];
      expect(phase4?.observations).toEqual([]);
      expect(phase4?.window).toEqual({
        complete: true,
        objectTypes: ['KnowledgeBase', 'Document'],
      });
    });

    describe('R-70: the window is committed only after a complete read', () => {
      interface RagflowState {
        kbs: Array<{ id: string }>;
        docs: Record<string, Array<{ id: string }>>;
        /** A raw RAGFlow body to answer one call with instead of the listing. */
        failWith?: (params: ObserveOperationParams) => unknown;
      }

      /** RAGFlow behind `observe_operation`, paged like the real server (totals included). */
      function ragflow(state: RagflowState) {
        return async (params: ObserveOperationParams): Promise<ObserveOperationResult> => {
          const failure = state.failWith?.(params);
          if (failure !== undefined) return { status: 'ok', data: failure, observedFactCount: 0 };
          const page = Number(params.params?.page ?? 1);
          const size = Number(params.params?.page_size ?? 30);
          const slice = <T>(all: T[]) => all.slice((page - 1) * size, page * size);
          if (params.operation === 'kb.list') {
            return {
              status: 'ok',
              data: { code: 0, data: slice(state.kbs), total_datasets: state.kbs.length },
              observedFactCount: 0,
            };
          }
          const docs = state.docs[String(params.params?.dataset_id)] ?? [];
          return {
            status: 'ok',
            data: { code: 0, data: { docs: slice(docs), total: docs.length } },
            observedFactCount: 0,
          };
        };
      }

      /** The kernel's S5.2 window, for phase 4's types: a `complete` window retires every live
       *  Fact of its ObjectTypes (this Source) that the same submission did not re-observe. */
      function windowedFacts(client: KernelClient) {
        const live = new Set<string>();
        const retired: string[] = [];
        const key = (o: { objectType: string; identity: Record<string, unknown> }) =>
          `${o.objectType}:${Object.values(o.identity).slice(1).join('/')}`;
        const inner = client.submitObservations.bind(client);
        client.submitObservations = async (params) => {
          const result = await inner(params);
          const types = params.window?.complete ? params.window.objectTypes : [];
          if (!types.includes('KnowledgeBase')) return result;
          const observed = new Set(params.observations.map(key));
          for (const k of observed) live.add(k);
          for (const k of [...live]) {
            if (types.includes(k.split(':')[0] ?? '') && !observed.has(k)) {
              live.delete(k);
              retired.push(k);
            }
          }
          return result;
        };
        return { live, retired };
      }

      const docs = (kb: string, n: number) =>
        Array.from({ length: n }, (_, i) => ({ id: `${kb}-doc-${i + 1}` }));

      it('a failed read leaves existing Facts untouched and commits no window; a full pass retires only what is really gone', async () => {
        const state: RagflowState = {
          kbs: [{ id: 'ds1' }, { id: 'ds2' }],
          docs: { ds1: docs('ds1', 150), ds2: docs('ds2', 3) },
        };
        const { client: kernelClient, calls } = fakeKernelClient({
          observeOperation: ragflow(state),
        });
        const facts = windowedFacts(kernelClient);
        const runPhase4 = () =>
          run({
            config: baseConfig({ ragflowGatekeeperId: 'gk-1' }),
            dockerClient: fakeDockerClient(),
            kernelClient,
            logger: { info: vi.fn(), warn: vi.fn() },
          });
        const phase4Windows = () =>
          calls.submitObservations.filter((p) => p.window?.objectTypes.includes('KnowledgeBase'))
            .length;

        // Run 1: everything read — 2 KnowledgeBases and all 153 Documents, past the first page.
        await runPhase4();
        expect(facts.live.size).toBe(2 + 153);
        expect(facts.retired).toEqual([]);
        expect(phase4Windows()).toBe(1);

        // Run 2: the RAGFlow key was rotated — kb.list answers an error in a 200 body.
        state.failWith = (p) =>
          p.operation === 'kb.list' ? { code: 109, message: 'Authentication error' } : undefined;
        await runPhase4();
        expect(facts.live.size).toBe(155);
        expect(facts.retired).toEqual([]);
        expect(phase4Windows()).toBe(1);

        // Run 3: one page of one KnowledgeBase fails; every other page reads fine.
        state.failWith = (p) =>
          p.operation === 'kb.documents' && p.params?.dataset_id === 'ds1' && p.params?.page === 2
            ? { code: 102, message: 'internal error' }
            : undefined;
        await runPhase4();
        expect(facts.live.size).toBe(155);
        expect(facts.retired).toEqual([]);
        expect(phase4Windows()).toBe(1);

        // Run 4: a complete read after a Document (on page 2) and a whole KnowledgeBase were deleted.
        state.failWith = undefined;
        state.docs.ds1 = (state.docs.ds1 ?? []).filter((d) => d.id !== 'ds1-doc-120');
        state.kbs = [{ id: 'ds1' }];
        await runPhase4();
        expect(phase4Windows()).toBe(2);
        expect(facts.retired.sort()).toEqual(
          [
            'Document:ds1/ds1-doc-120',
            'KnowledgeBase:ds2',
            'Document:ds2/ds2-doc-1',
            'Document:ds2/ds2-doc-2',
            'Document:ds2/ds2-doc-3',
          ].sort(),
        );
        expect(facts.live.size).toBe(1 + 149);
      });
    });
  });
});
