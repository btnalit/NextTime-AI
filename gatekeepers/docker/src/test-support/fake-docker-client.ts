import type { ContainerSummary, DockerClient, ListContainersOptions } from '../docker-client.js';

/**
 * fake-docker-client: an in-memory `DockerClient` for `transport.test.ts` — never touches a real
 * socket. Mirrors `packages/worker-supervisor/src/test-support/fake-docker-client.ts`'s pattern
 * (call-recording fakes over a narrow port interface) for this package's own narrower port.
 */

export interface FakeContainerSeed {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly running?: boolean;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface FakeDockerClient extends DockerClient {
  readonly restartCalls: Array<{ id: string; timeoutSeconds: number }>;
  readonly startCalls: string[];
  readonly stopCalls: string[];
  readonly pingCalls: number;
  setRunning(id: string, running: boolean): void;
}

function toSummary(state: {
  id: string;
  name: string;
  image: string;
  running: boolean;
  labels: Record<string, string>;
}): ContainerSummary {
  return {
    id: state.id,
    name: state.name,
    image: state.image,
    state: state.running ? 'running' : 'exited',
    status: state.running ? 'Up 1 minute' : 'Exited (0) 1 minute ago',
    labels: state.labels,
  };
}

export function createFakeDockerClient(seeds: readonly FakeContainerSeed[] = []): FakeDockerClient {
  const containers = new Map<
    string,
    { id: string; name: string; image: string; running: boolean; labels: Record<string, string> }
  >();
  for (const seed of seeds) {
    containers.set(seed.id, {
      id: seed.id,
      name: seed.name,
      image: seed.image,
      running: seed.running ?? true,
      labels: { ...(seed.labels ?? {}) },
    });
  }

  const restartCalls: Array<{ id: string; timeoutSeconds: number }> = [];
  const startCalls: string[] = [];
  const stopCalls: string[] = [];
  let pingCalls = 0;

  function findByIdOrName(idOrName: string) {
    const byId = containers.get(idOrName);
    if (byId) return byId;
    for (const c of containers.values()) {
      if (c.name === idOrName) return c;
    }
    return undefined;
  }

  return {
    restartCalls,
    startCalls,
    stopCalls,
    get pingCalls() {
      return pingCalls;
    },

    async listContainers(options: ListContainersOptions = {}): Promise<ContainerSummary[]> {
      let items = [...containers.values()];
      if (options.project !== undefined) {
        items = items.filter((c) => c.labels['com.docker.compose.project'] === options.project);
      }
      if (options.all === false) {
        items = items.filter((c) => c.running);
      }
      return items.map(toSummary);
    },

    async inspectContainer(id: string): Promise<ContainerSummary> {
      const found = findByIdOrName(id);
      if (!found) {
        const err = new Error(`no such container: ${id}`) as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return toSummary(found);
    },

    async logsTail(id: string, tail: number): Promise<string> {
      const found = findByIdOrName(id);
      if (!found) throw new Error(`no such container: ${id}`);
      return `fake logs for ${found.name} (tail=${tail})`;
    },

    async restart(id: string, timeoutSeconds: number): Promise<void> {
      restartCalls.push({ id, timeoutSeconds });
      const found = findByIdOrName(id);
      if (!found) throw new Error(`no such container: ${id}`);
      found.running = true;
    },

    async start(id: string): Promise<void> {
      startCalls.push(id);
      const found = findByIdOrName(id);
      if (!found) throw new Error(`no such container: ${id}`);
      found.running = true;
    },

    async stop(id: string): Promise<void> {
      stopCalls.push(id);
      const found = findByIdOrName(id);
      if (!found) return;
      found.running = false;
    },

    async ping(): Promise<void> {
      pingCalls += 1;
    },

    setRunning(id: string, running: boolean): void {
      const found = findByIdOrName(id);
      if (found) found.running = running;
    },
  };
}
