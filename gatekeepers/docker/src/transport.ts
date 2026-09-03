import {
  BindingKindMismatchError,
  type Transport,
  type TransportInvokeContext,
  TransportInvokeError,
  type TransportInvokeResult,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import type { ContainerSummary, DockerClient } from './docker-client.js';

/**
 * DockerodeTransport: this gate's own `Transport` implementation (design doc §7.5's "binding.kind
 * matches the gate's own transport kind" contract — every Operation in `../manifest.json`
 * declares `binding.kind: 'cli'` for `CliBindingSchema` wire-shape consistency), but the code that
 * actually runs each Operation talks to the Docker Engine API over `/var/run/docker.sock` via
 * `dockerode` (`docker-client.ts`), never a shelled-out `docker` binary.
 *
 * Why not `@nexttime/gatekeeper-base`'s own `main()`/`startGatekeeperServer()` env-driven
 * bootstrap: its `GATE_TRANSPORT_KIND=cli` path (`src/index.ts` `buildTransport`) always
 * constructs the base package's own `CliTransport` (`kinds/cli.ts`), which renders each
 * Operation's `command_template` and runs it with `execFile` — i.e. it shells out to a real
 * `docker` binary, which this task brief explicitly forbids ("no docker CLI in the image").
 * `GatekeeperBase` itself is transport-agnostic (`gatekeeper-base.ts` takes any object satisfying
 * the `Transport` port, one instance for the whole manifest — `binding.kind` is read only by each
 * transport implementation, `GatekeeperBase` never branches on it), so this file is what "the base
 * supports custom bindings" (task brief) means in practice: `index.ts` constructs `GatekeeperBase`
 * + `createGatekeeperServer` directly with this transport instead of calling `main()`.
 *
 * `GatekeeperBase.simulate` calls a transport's `simulate` for *any* Operation name when the
 * transport defines one (not just `mode: 'execute'` ones — `gatekeeper-base.ts`), so every
 * Operation name below has a `simulate` case, not only the three execute ones.
 */

const OBSERVE_ALL_DEFAULT = true;

function asRecord(params: unknown): Record<string, unknown> {
  return (params ?? {}) as Record<string, unknown>;
}

function requireString(
  params: Record<string, unknown>,
  key: string,
  operationName: string,
): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TransportInvokeError(
      `docker transport: operation "${operationName}" requires a non-empty string param "${key}"`,
    );
  }
  return value;
}

function optionalNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' ? value : fallback;
}

function optionalBoolean(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function assertCliBinding(operation: Operation): void {
  if (operation.binding.kind !== 'cli') {
    throw new BindingKindMismatchError(operation.name, 'cli', operation.binding.kind);
  }
}

/** `compose.up`/`compose.down`'s reduced semantics (README/PR body "已知偏离"): starts/stops the
 *  containers *already present* on the host under `com.docker.compose.project=<project>` — not a
 *  full Compose reconciliation (no image pull, no service create/recreate, no network/volume
 *  management), since only the Docker Engine API is available here, not a `docker compose`
 *  binary. */
async function composeTargets(
  client: DockerClient,
  project: string,
  wantRunning: boolean,
): Promise<ContainerSummary[]> {
  const all = await client.listContainers({ all: true, project });
  return all.filter((c) => (wantRunning ? c.state !== 'running' : c.state === 'running'));
}

async function invokeOperation(
  client: DockerClient,
  operation: Operation,
  params: Record<string, unknown>,
): Promise<TransportInvokeResult> {
  switch (operation.name) {
    case 'containers.list': {
      const all = optionalBoolean(params, 'all', OBSERVE_ALL_DEFAULT);
      const items = await client.listContainers({ all });
      return { data: items };
    }
    case 'container.inspect': {
      const id = requireString(params, 'id', operation.name);
      const item = await client.inspectContainer(id);
      return { data: item };
    }
    case 'compose.ls': {
      const project = optionalString(params, 'project');
      const items = await client.listContainers({ all: true, project });
      const byProject = new Map<string, ContainerSummary[]>();
      for (const item of items) {
        const key = item.labels['com.docker.compose.project'] ?? '';
        if (!key) continue;
        const existing = byProject.get(key) ?? [];
        existing.push(item);
        byProject.set(key, existing);
      }
      const projects = [...byProject.entries()].map(([name, containers]) => ({
        project: name,
        containerCount: containers.length,
        containers,
      }));
      return { data: { projects } };
    }
    case 'container.logs_tail': {
      const id = requireString(params, 'id', operation.name);
      const tail = optionalNumber(params, 'tail', 200);
      const text = await client.logsTail(id, tail);
      return { data: { id, tail, text } };
    }
    case 'container.restart': {
      const id = requireString(params, 'id', operation.name);
      const timeoutSeconds = optionalNumber(params, 'timeoutSeconds', 10);
      await client.restart(id, timeoutSeconds);
      const item = await client.inspectContainer(id);
      return { data: item };
    }
    case 'compose.up': {
      const project = requireString(params, 'project', operation.name);
      const targets = await composeTargets(client, project, true);
      for (const target of targets) await client.start(target.id);
      const containers = await client.listContainers({ all: true, project });
      return { data: { project, started: targets.map((t) => t.id), containers } };
    }
    case 'compose.down': {
      const project = requireString(params, 'project', operation.name);
      const targets = await composeTargets(client, project, false);
      for (const target of targets) await client.stop(target.id);
      const containers = await client.listContainers({ all: true, project });
      return { data: { project, stopped: targets.map((t) => t.id), containers } };
    }
    default:
      throw new TransportInvokeError(`docker transport: unknown operation "${operation.name}"`);
  }
}

async function simulateOperation(
  client: DockerClient,
  operation: Operation,
  params: Record<string, unknown>,
): Promise<{ description: string; detail?: unknown }> {
  switch (operation.name) {
    case 'container.restart': {
      const id = requireString(params, 'id', operation.name);
      const item = await client.inspectContainer(id);
      return {
        description: `would restart container "${item.name}" (${item.id})`,
        detail: { containers: [item] },
      };
    }
    case 'compose.up': {
      const project = requireString(params, 'project', operation.name);
      const targets = await composeTargets(client, project, true);
      return {
        description: `would start ${targets.length} stopped container(s) in compose project "${project}"`,
        detail: { containers: targets },
      };
    }
    case 'compose.down': {
      const project = requireString(params, 'project', operation.name);
      const targets = await composeTargets(client, project, false);
      return {
        description: `would stop ${targets.length} running container(s) in compose project "${project}"`,
        detail: { containers: targets },
      };
    }
    default:
      return {
        description: `would ${operation.mode} "${operation.name}" via docker`,
        detail: { params },
      };
  }
}

export function createDockerTransport(client: DockerClient): Transport {
  return {
    kind: 'cli',

    async invoke(
      operation: Operation,
      params: unknown,
      _ctx: TransportInvokeContext,
    ): Promise<TransportInvokeResult> {
      assertCliBinding(operation);
      try {
        return await invokeOperation(client, operation, asRecord(params));
      } catch (err) {
        if (err instanceof TransportInvokeError) throw err;
        throw new TransportInvokeError(`docker transport: operation "${operation.name}" failed`, {
          cause: err,
        });
      }
    },

    async simulate(
      operation: Operation,
      params: unknown,
      _ctx: TransportInvokeContext,
    ): Promise<{ description: string; detail?: unknown }> {
      assertCliBinding(operation);
      return simulateOperation(client, operation, asRecord(params));
    },

    async health(): Promise<{ status: 'ok' | 'degraded' | 'down'; detail?: string }> {
      try {
        await client.ping();
        return { status: 'ok' };
      } catch (err) {
        return { status: 'down', detail: String(err) };
      }
    },
  };
}
