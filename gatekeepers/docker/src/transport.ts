import {
  BindingKindMismatchError,
  OperationRefusedError,
  type Transport,
  type TransportInvokeContext,
  TransportInvokeError,
  type TransportInvokeResult,
  TransportOutcomeUnknownError,
  networkFailureCode,
  networkFailureDelivery,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  type ContainerSummary,
  type DockerClient,
  type ListContainersOptions,
} from './docker-client.js';

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
 *
 * Agent containers (R-04, decision D-04): this gate never lists or touches the platform's own
 * agent containers — the entry and Task containers worker-supervisor spawns, whose stdout carries
 * pi RPC (prompts, tool calls, tool results) of whichever principal owns them. They are filtered
 * out of every enumeration (`containers.list`, `compose.ls`, `compose.up/down`'s targets and
 * results), and every per-container Operation resolves its target first, refuses an agent
 * container with `OperationRefusedError` (403 `operation_refused`), and then acts on the resolved
 * full id — never on the caller's name or id prefix. The platform's service containers (kernel,
 * postgres, caddy, …) stay visible and operable.
 *
 * What a result carries per container (legacy 966): `container.inspect` returns the container
 * with every label; every other Operation returns `ContainerListItem` (`listItemOf`) — its compose
 * project and service, no other label (`compose.ls` leaves out the project it lists the container
 * under).
 */

const OBSERVE_ALL_DEFAULT = true;

/** The label worker-supervisor stamps on every container it spawns: `entry` for a resident entry
 *  container, `worker` for a Task container (`packages/worker-supervisor/src/spawn-spec.ts`
 *  `ENTRY_ROLE_LABEL`, `task-spawn-spec.ts` `TASK_ROLE_VALUE`). Matched by key alone, as the
 *  supervisor's own event filter does (`docker-events.ts`), so every role value is excluded. */
const AGENT_ROLE_LABEL = 'nexttime.role';

function isAgentContainer(container: ContainerSummary): boolean {
  return container.labels[AGENT_ROLE_LABEL] !== undefined;
}

/**
 * Legacy 966: one container as every Operation but `container.inspect` returns it — the lists
 * (`containers.list`, `compose.ls`, `compose.up` / `compose.down` and their `simulate`) and
 * `container.restart`. Every label went with each container before: a compose container carries a
 * dozen or more (the config hash, the image digest, the compose file's path and working
 * directory, the image's own OCI labels), so a list of eighteen ran to tens of thousands of
 * characters, past what a Worker's tool result shows (`truncateToolResult`), and cost its budget
 * on every later model call that re-read it. The compose project and service stay: they say what
 * a container belongs to, and `compose.up` / `compose.down` take the project. One container's
 * labels are a `container.inspect` away. A key is left out when the container has no such label.
 */
export interface ContainerListItem {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  /** Its `com.docker.compose.project` label. */
  readonly project?: string;
  /** Its `com.docker.compose.service` label. */
  readonly service?: string;
}

export function listItemOf(container: ContainerSummary): ContainerListItem {
  const project = container.labels[COMPOSE_PROJECT_LABEL];
  const service = container.labels[COMPOSE_SERVICE_LABEL];
  return {
    id: container.id,
    name: container.name,
    image: container.image,
    state: container.state,
    status: container.status,
    ...(project !== undefined ? { project } : {}),
    ...(service !== undefined ? { service } : {}),
  };
}

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

/**
 * Legacy 196 (#532 review M): what a per-container Operation's `id` may look like. dockerode puts
 * it into the request path as it is (`/containers/<id>/json`), and over tcp — how this gate reaches
 * its socket proxy — docker-modem resolves that path as a URL: `x/../../info` asks
 * `GET /info/json`, and `abc#…` asks `GET /containers/abc`. That is another endpoint of the same
 * daemon, within whatever the proxy allows. Docker's ids are hex and its names are
 * `[a-zA-Z0-9][a-zA-Z0-9_.-]+` (moby `RestrictedNamePattern`; listed here without their leading
 * `/`), so this refuses nothing that names a container, and nothing it lets through can leave the
 * container's path segment: no `/`, `?`, `#` or `%`, and no leading `.`.
 */
const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The `id` param, refused before any call to the daemon unless it can only name a container. A
 *  refusal like R-04's: 403 `operation_refused`, and an `apply` frees its idempotency key. */
function requireContainerRef(params: Record<string, unknown>, operationName: string): string {
  const id = requireString(params, 'id', operationName);
  if (!CONTAINER_REF.test(id)) {
    throw new OperationRefusedError(
      `docker gate: operation "${operationName}" refused — "id" is not a container id, id prefix or name (a letter or digit, then letters, digits, "_", "." or "-"; a name without its leading "/"); nothing was sent to the Docker daemon`,
    );
  }
  return id;
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

/** Every container enumeration goes through here, so no Operation can list an agent container. */
async function listServedContainers(
  client: DockerClient,
  options: ListContainersOptions,
): Promise<ContainerSummary[]> {
  const all = await client.listContainers(options);
  return all.filter((c) => !isAgentContainer(c));
}

/** Resolves a per-container Operation's `id` param — a full id, an id prefix or a name, whatever
 *  the Engine API's inspect accepts — to the container it actually names, and refuses an agent
 *  container by that container's own labels, never by the name. Callers then act on the returned
 *  full id, so the check and the action cannot name different containers. */
async function resolveServedContainer(
  client: DockerClient,
  operationName: string,
  idOrName: string,
): Promise<ContainerSummary> {
  const container = await client.inspectContainer(idOrName);
  if (isAgentContainer(container)) {
    throw new OperationRefusedError(
      `docker gate: operation "${operationName}" refused — container "${idOrName}" is a platform agent container (label ${AGENT_ROLE_LABEL}); this gate never lists or touches agent containers`,
    );
  }
  return container;
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
  const all = await listServedContainers(client, { all: true, project });
  return all.filter((c) => (wantRunning ? c.state !== 'running' : c.state === 'running'));
}

/**
 * Legacy 287 (review of #586, #493 M3): the calls that change the target (`restart`, `start`,
 * `stop`), so a failure of an execute Operation can say whether it may have acted. Every other
 * call this transport makes (inspect, list, logs) only reads.
 */
interface Effects {
  /** Effect calls the daemon answered with success. */
  done: number;
  /** The effect call in flight when the Operation failed, if any. */
  inFlight: string | undefined;
}

async function effect(effects: Effects, what: string, call: () => Promise<void>): Promise<void> {
  effects.inFlight = what;
  await call();
  effects.inFlight = undefined;
  effects.done += 1;
}

/** The Docker daemon's own answer to a call: dockerode / docker-modem put its HTTP status on the
 *  error (`404 no such container`, `500 …`). A connection that broke has no status. */
function daemonStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const { statusCode } = err as { statusCode?: unknown };
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/**
 * How a failed Operation reads (legacy 287), the same rule as the base package's http / mcp
 * transports (`kinds/call-failure.ts`):
 *
 *   - It failed before any effect call, or on the first effect call with the daemon's own error
 *     status or a connection that provably never opened: nothing changed — a plain failure.
 *   - An effect call failed without the daemon's answer (the connection broke, an error nobody
 *     recognises), or any call failed after an effect call succeeded (`container.restart`'s
 *     inspect after the restart; `compose.up` / `compose.down` part-way through their containers):
 *     the target may have changed — "outcome unknown", never a failure the kernel could record as
 *     failed and run again.
 *
 * A `docker-socket-proxy` between this gate and the daemon answers 502 / 504 with a status of its
 * own when the daemon does not answer it; that reads as the daemon's answer here — the design
 * trade-off docs/graph-ai-middle-platform-design.md §13 records for the gate→target hop.
 */
function operationFailure(
  operationName: string,
  err: unknown,
  effects: Effects,
): TransportInvokeError {
  const label = `docker transport: operation "${operationName}"`;
  const code = networkFailureCode(err);
  const codeDetail = code !== undefined ? ` (${code})` : '';
  if (effects.done > 0) {
    return new TransportOutcomeUnknownError(
      `${label} failed after it had already changed the target (${effects.done} change call(s) succeeded)${codeDetail} — it partially or fully ran`,
      { cause: err },
    );
  }
  if (effects.inFlight !== undefined) {
    const status = daemonStatus(err);
    if (status !== undefined) {
      return new TransportInvokeError(
        `${label} failed: the Docker daemon answered ${effects.inFlight} with status ${status}`,
        { cause: err },
      );
    }
    if (networkFailureDelivery(err) === 'not_sent') {
      return new TransportInvokeError(
        `${label} not sent — could not connect to the Docker daemon${codeDetail}; nothing changed`,
        { cause: err },
      );
    }
    return new TransportOutcomeUnknownError(
      `${label} failed while its ${effects.inFlight} call was in flight${codeDetail} — it may have run`,
      { cause: err },
    );
  }
  if (err instanceof TransportInvokeError || err instanceof OperationRefusedError) return err;
  return new TransportInvokeError(`${label} failed`, { cause: err });
}

async function invokeOperation(
  client: DockerClient,
  operation: Operation,
  params: Record<string, unknown>,
  effects: Effects,
): Promise<TransportInvokeResult> {
  switch (operation.name) {
    case 'containers.list': {
      const all = optionalBoolean(params, 'all', OBSERVE_ALL_DEFAULT);
      const items = await listServedContainers(client, { all });
      return { data: items.map(listItemOf) };
    }
    case 'container.inspect': {
      const id = requireContainerRef(params, operation.name);
      const item = await resolveServedContainer(client, operation.name, id);
      return { data: item };
    }
    case 'compose.ls': {
      const project = optionalString(params, 'project');
      const items = await listServedContainers(client, { all: true, project });
      // Each container without the project it is listed under (legacy 966: a fortieth of the
      // answer on a host of forty).
      const byProject = new Map<string, Omit<ContainerListItem, 'project'>[]>();
      for (const item of items) {
        const key = item.labels[COMPOSE_PROJECT_LABEL] ?? '';
        if (!key) continue;
        const { project: _project, ...listed } = listItemOf(item);
        const existing = byProject.get(key) ?? [];
        existing.push(listed);
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
      const id = requireContainerRef(params, operation.name);
      const tail = optionalNumber(params, 'tail', 200);
      const target = await resolveServedContainer(client, operation.name, id);
      const text = await client.logsTail(target.id, tail);
      return { data: { id, tail, text } };
    }
    case 'container.restart': {
      const id = requireContainerRef(params, operation.name);
      const timeoutSeconds = optionalNumber(params, 'timeoutSeconds', 10);
      const target = await resolveServedContainer(client, operation.name, id);
      await effect(effects, 'restart', () => client.restart(target.id, timeoutSeconds));
      const item = await client.inspectContainer(target.id);
      return { data: listItemOf(item) };
    }
    case 'compose.up': {
      const project = requireString(params, 'project', operation.name);
      const targets = await composeTargets(client, project, true);
      for (const target of targets) await effect(effects, 'start', () => client.start(target.id));
      const containers = await listServedContainers(client, { all: true, project });
      return {
        data: {
          project,
          started: targets.map((t) => t.id),
          containers: containers.map(listItemOf),
        },
      };
    }
    case 'compose.down': {
      const project = requireString(params, 'project', operation.name);
      const targets = await composeTargets(client, project, false);
      for (const target of targets) await effect(effects, 'stop', () => client.stop(target.id));
      const containers = await listServedContainers(client, { all: true, project });
      return {
        data: {
          project,
          stopped: targets.map((t) => t.id),
          containers: containers.map(listItemOf),
        },
      };
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
    case 'container.inspect':
    case 'container.logs_tail': {
      const id = requireContainerRef(params, operation.name);
      await resolveServedContainer(client, operation.name, id);
      return {
        description: `would ${operation.mode} "${operation.name}" via docker`,
        detail: { params },
      };
    }
    case 'container.restart': {
      const id = requireContainerRef(params, operation.name);
      const item = await resolveServedContainer(client, operation.name, id);
      return {
        description: `would restart container "${item.name}" (${item.id})`,
        detail: { containers: [listItemOf(item)] },
      };
    }
    case 'compose.up': {
      const project = requireString(params, 'project', operation.name);
      const targets = await composeTargets(client, project, true);
      return {
        description: `would start ${targets.length} stopped container(s) in compose project "${project}"`,
        detail: { containers: targets.map(listItemOf) },
      };
    }
    case 'compose.down': {
      const project = requireString(params, 'project', operation.name);
      const targets = await composeTargets(client, project, false);
      return {
        description: `would stop ${targets.length} running container(s) in compose project "${project}"`,
        detail: { containers: targets.map(listItemOf) },
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
      const effects: Effects = { done: 0, inFlight: undefined };
      try {
        return await invokeOperation(client, operation, asRecord(params), effects);
      } catch (err) {
        throw operationFailure(operation.name, err, effects);
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
