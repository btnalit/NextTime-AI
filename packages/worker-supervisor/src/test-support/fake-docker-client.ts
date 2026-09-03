/**
 * fake-docker-client: an in-memory `DockerClient` (docker-client.ts) for resident-service.test.ts
 * and server.test.ts — never touches a real socket. Assigns each created container a fake
 * sequential IP so tests can assert egress registration without a real Docker network.
 */

import type { ContainerSpec, ContainerState, DockerClient } from '../docker-client.js';

export interface FakeDockerClient extends DockerClient {
  /** Every container this fake has ever created, keyed by name — includes stopped/removed ones
   *  removed from `containers` but still inspectable via history, for assertions. */
  readonly createCalls: ContainerSpec[];
  readonly stopCalls: Array<{ name: string; timeoutSeconds: number }>;
  readonly removeCalls: string[];
  /** Simulates an out-of-band `docker kill` (or a crash) — unlike `stop()`, this is never called
   *  by the code under test, only by a test setting up a "found existing but not running"
   *  scenario for the next `spawn()`. */
  simulateExternalKill(name: string): void;
  /** Simulates a container that exited **on its own** with a specific code — task-service.test.ts
   *  uses this to distinguish "the process finished" (`exited`/`failed`, depending on the code)
   *  from an out-of-band kill or this service's own `stop()`/`remove()` calls. */
  simulateExit(name: string, exitCode: number): void;
}

let ipCounter = 10;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

export function createFakeDockerClient(options: { networkName?: string } = {}): FakeDockerClient {
  const containers = new Map<string, ContainerState & { idCounter: number }>();
  let idSeq = 0;
  const createCalls: ContainerSpec[] = [];
  const stopCalls: Array<{ name: string; timeoutSeconds: number }> = [];
  const removeCalls: string[] = [];

  return {
    createCalls,
    stopCalls,
    removeCalls,

    async createAndStart(spec: ContainerSpec): Promise<ContainerState> {
      createCalls.push(spec);
      idSeq += 1;
      const state: ContainerState & { idCounter: number } = {
        id: `container-${idSeq}`,
        idCounter: idSeq,
        name: spec.name,
        running: true,
        status: 'running',
        startedAt: new Date().toISOString(),
        ip: nextIp(),
        labels: { ...spec.labels },
        exitCode: undefined,
      };
      containers.set(spec.name, state);
      return state;
    },

    async inspectByName(name: string): Promise<ContainerState | undefined> {
      return containers.get(name);
    },

    async stop(name: string, timeoutSeconds: number): Promise<void> {
      stopCalls.push({ name, timeoutSeconds });
      const existing = containers.get(name);
      if (existing) {
        containers.set(name, {
          ...existing,
          running: false,
          status: 'exited',
          ip: undefined,
          exitCode: 137,
        });
      }
    },

    async remove(name: string): Promise<void> {
      removeCalls.push(name);
      containers.delete(name);
    },

    async listByLabel(label: string, value: string): Promise<ContainerState[]> {
      return [...containers.values()].filter((c) => c.labels[label] === value);
    },

    async resolveNetworkByComposeLabel(
      _networkLabel: string,
      explicitName?: string,
    ): Promise<string> {
      return explicitName ?? options.networkName ?? 'fake_workers';
    },

    simulateExternalKill(name: string): void {
      const existing = containers.get(name);
      if (existing) {
        containers.set(name, {
          ...existing,
          running: false,
          status: 'exited',
          ip: undefined,
          exitCode: 137,
        });
      }
    },

    simulateExit(name: string, exitCode: number): void {
      const existing = containers.get(name);
      if (existing) {
        containers.set(name, {
          ...existing,
          running: false,
          status: 'exited',
          ip: undefined,
          exitCode,
        });
      }
    },
  };
}
