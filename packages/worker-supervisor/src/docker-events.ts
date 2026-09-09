/**
 * docker-events: event-driven egress de-registration (feat/egress-docker-events). Subscribes to
 * the Docker Engine's container-lifecycle event stream (`DockerClient.getContainerEvents`,
 * `docker-client.ts` — `GET /events`, routed through `docker-socket-proxy`'s `EVENTS` flag,
 * docker-compose.yml) so a crashed/killed container's egress-source-map entry is removed within
 * about a second, instead of waiting for the next periodic reaper tick
 * (`TASK_REAP_INTERVAL_MS`/resident mode's idle sweep — see `index.ts`).
 *
 * This module is a faster, best-effort *addition*, not a replacement: the reaper
 * (`task-service.ts` `reap()`) and resident mode's own crash-detection (`resident-service.ts`
 * `spawn()`'s "crash path", `sweepIdle()`) are untouched and keep running on their own intervals
 * regardless of whether this subscription is up. If the event stream can never be established
 * (e.g. the proxy's `EVENTS` flag is off), `connect()` below logs exactly one warning and keeps
 * retrying with capped backoff in the background forever — the fail-open window stays bounded by
 * the reaper's own interval, exactly as it was before this module existed (never crash the
 * supervisor over a missing events subscription).
 *
 * Filter (server-side, `docker-client.ts` `getContainerEvents`): `type=container`,
 * `event=die|destroy|kill|stop`, `label=nexttime.role` — a bare label *key* (no `=value`), which
 * the Engine API matches regardless of value, so one filter entry covers both resident mode's
 * `nexttime.role=entry` containers (`spawn-spec.ts` `ENTRY_ROLE_LABEL`) and Task mode's
 * `nexttime.role=worker` containers (`task-spawn-spec.ts` `TASK_ROLE_LABEL` — same label key,
 * different value) without this module importing either spec module. Every other container on
 * the host (if any) never reaches this process at all.
 *
 * Routing a matched event to the right service (resident vs Task) is the caller's job
 * (`index.ts`): this module only parses the NDJSON stream and hands each event's `{action,
 * containerId}` to `onContainerEvent` — it has no registry of its own to check "known" against,
 * and does not itself decide whether the container has actually finished exiting (Docker emits
 * `kill` when the signal is *sent*, not when the process has died — `resident-service.ts`'s and
 * `task-service.ts`'s own `notifyContainerExited` each re-inspect the container before treating
 * it as gone, for exactly this reason).
 */

import type { DockerClient } from './docker-client.js';

/** Docker Engine container-lifecycle actions this platform cares about — any exit path
 *  (`docker stop`, `docker kill`, an OOM/crash `die`, or `destroy` after a `docker rm`). Every
 *  one of these can fire for a single container exit (`kill` → `die` → `destroy`), which is why
 *  the services' own `notifyContainerExited` must be idempotent — see this module's doc comment. */
const CONTAINER_EVENT_ACTIONS = ['die', 'destroy', 'kill', 'stop'] as const;

/** Shared label *key* with `spawn-spec.ts`'s `ENTRY_ROLE_LABEL`/`task-spawn-spec.ts`'s
 *  `TASK_ROLE_LABEL` — re-declared here (not imported) so this module doesn't need to depend on
 *  either mode's spec module for a bare string constant; see this module's own doc comment for
 *  why a bare key (not `key=value`) is exactly what's wanted here. */
const PLATFORM_ROLE_LABEL_KEY = 'nexttime.role';

export interface ContainerLifecycleEvent {
  readonly action: string;
  readonly containerId: string;
}

export interface ContainerEventsSubscriberOptions {
  /** Only `getContainerEvents` is used — narrowed so tests (and any future caller) don't need a
   *  full `DockerClient` fake just to drive this module. */
  readonly docker: Pick<DockerClient, 'getContainerEvents'>;
  /** Called for every container event matching the server-side filter — whether the containerId
   *  is "known" to any service's registry, and whether the container has actually finished
   *  exiting, is entirely the caller's/service's job to check (see this module's doc comment). */
  readonly onContainerEvent: (event: ContainerLifecycleEvent) => void;
  /** Run after every successful (re)connection, including the first. `residentService.reconcile`/
   *  `taskService.reconcile()` are both idempotent no-ops for a container they already know about
   *  (task-service.ts's own `reconcile()` explicitly skips a known `workerRunId`; resident mode's
   *  registry-set is a cheap overwrite — see that method's own doc comment for the one edge case
   *  this PR fixes, `lastTouchedAt`), so re-running the *first* connect's reconcile pass right
   *  after `index.ts`'s own startup `reconcile()` call is harmless — and running it again on every
   *  later reconnect is exactly what closes the "missed events while disconnected" gap. */
  readonly reconcile: () => Promise<void>;
  /** Defaults to one JSON line via `console.log`/`console.error` by level — overridable for
   *  tests. */
  readonly log?: (line: Record<string, unknown>) => void;
  /** Initial reconnect delay; doubles on each consecutive failure up to `maxReconnectDelayMs`,
   *  and resets back to this on every successful connection. Default 1000ms. */
  readonly baseReconnectDelayMs?: number;
  /** Cap on the reconnect backoff. Default 30000ms (30s) — this task's own stated cap. */
  readonly maxReconnectDelayMs?: number;
}

export interface ContainerEventsSubscriber {
  /** Stops reconnecting and detaches from the current stream, if any. Deliberately does NOT
   *  force-close a still-live stream by removing its listeners — an `http.IncomingMessage` that
   *  later emits `'error'` with no listener attached crashes the process (Node's unhandled-
   *  `'error'`-event behavior), which is exactly what this module's fail-safe requirement
   *  forbids. `destroy()`, when the underlying stream supports it, cleanly emits `'close'`
   *  instead — already handled (a no-op, since `stopped` is set first). */
  stop(): void;
}

function parseContainerLifecycleEvent(raw: unknown): ContainerLifecycleEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const msg = raw as { Type?: unknown; Action?: unknown; Actor?: unknown };
  if (msg.Type !== 'container' || typeof msg.Action !== 'string') return undefined;
  const actor = msg.Actor;
  const containerId =
    typeof actor === 'object' && actor !== null ? (actor as { ID?: unknown }).ID : undefined;
  if (typeof containerId !== 'string' || containerId.length === 0) return undefined;
  return { action: msg.Action, containerId };
}

export function subscribeToContainerEvents(
  options: ContainerEventsSubscriberOptions,
): ContainerEventsSubscriber {
  const {
    docker,
    onContainerEvent,
    reconcile,
    log = (line) => console.log(JSON.stringify(line)),
    baseReconnectDelayMs = 1_000,
    maxReconnectDelayMs = 30_000,
  } = options;

  let stopped = false;
  let warnedSubscriptionFailure = false;
  let currentStream: NodeJS.ReadableStream | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectDelayMs = baseReconnectDelayMs;

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function handleDisconnect(stream: NodeJS.ReadableStream, err: unknown): void {
    // Docker Engine event streams commonly fire 'error' immediately followed by 'close' (or
    // 'end') for the same disconnect — this guard makes the second callback a no-op instead of
    // scheduling a duplicate reconnect.
    if (currentStream !== stream) return;
    currentStream = undefined;
    if (stopped) return;
    log({
      level: 'warn',
      msg: 'docker events stream disconnected — reconnecting with backoff',
      ...(err !== undefined ? { error: String(err) } : {}),
    });
    scheduleReconnect();
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    let stream: NodeJS.ReadableStream;
    try {
      stream = await docker.getContainerEvents({
        event: CONTAINER_EVENT_ACTIONS,
        label: [PLATFORM_ROLE_LABEL_KEY],
      });
    } catch (err) {
      if (!warnedSubscriptionFailure) {
        warnedSubscriptionFailure = true;
        log({
          level: 'warn',
          msg:
            'docker events subscription could not be established — falling back to the ' +
            'periodic reaper only (check docker-socket-proxy EVENTS flag); retrying in the ' +
            'background, this warning will not repeat',
          error: String(err),
        });
      }
      scheduleReconnect();
      return;
    }
    if (stopped) return; // stop() raced this connect — do not adopt the stream

    currentStream = stream;
    reconnectDelayMs = baseReconnectDelayMs; // reset backoff on a successful connection
    let buffer = '';

    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue; // malformed line — never let one bad line crash the subscriber
        }
        const event = parseContainerLifecycleEvent(parsed);
        if (event) onContainerEvent(event);
      }
    });
    stream.on('error', (err) => handleDisconnect(stream, err));
    stream.on('end', () => handleDisconnect(stream, undefined));
    stream.on('close', () => handleDisconnect(stream, undefined));

    try {
      await reconcile();
    } catch (err) {
      log({ level: 'warn', msg: 'post-connect reconcile pass failed', error: String(err) });
    }
  }

  void connect();

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const stream = currentStream;
      currentStream = undefined;
      (stream as { destroy?: () => void } | undefined)?.destroy?.();
    },
  };
}
