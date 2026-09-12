import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Operation } from '@nexttime/shared';
import {
  DEFAULT_INTERNAL_TOKEN_FILE,
  internalAuthorizationHeader,
  normalizeInternalToken,
} from '@nexttime/shared';

/**
 * announce: P-B1 gate self-registration (docs/platform-admin-design.md §6.3 "打包门自注册";
 * docs/development-tasks.md P-B 决定 ⑤). On start, and then every `GATE_ANNOUNCE_INTERVAL_SEC`
 * as a heartbeat, a gate tells the kernel who it is — its stable `GATE_ID`, connector, transport
 * kind, human-readable target, the URL the kernel should call it at, and the manifest it serves
 * from `describe_operations` — via `POST /internal/gates/announce` on the internal plane (the
 * compose secret `internal_token`, the same token worker-supervisor and agent-host hold).
 *
 * Opt-in: without `GATE_ID`, `GATE_CONNECTOR` and `KERNEL_URL` this is a no-op (accept fixtures,
 * ad-hoc gates and P-B2's host mode keep working unchanged). Never a credential: the body has no
 * field for one and the token is never logged. A failure is a warning, never a crash — a gate is
 * useful to the workspaces that already enabled it even while the kernel is unreachable.
 *
 * Env:
 *   GATE_ID                     stable identity, `^[a-z0-9][a-z0-9-]{1,63}$` (compose config)
 *   GATE_CONNECTOR              接入包 name, `^[a-z0-9][a-z0-9-]{0,63}$` (`docker`, `ragflow`, …)
 *   KERNEL_URL                  kernel base URL, e.g. http://kernel:8080
 *   GATE_INTERNAL_TOKEN_FILE    default /run/secrets/internal_token
 *   GATE_ANNOUNCE_INTERVAL_SEC  default 60
 *   GATE_PUBLIC_ENDPOINT        URL the kernel calls this gate at; default http://<GATE_SERVICE_NAME|hostname>:<GATE_PORT>
 *   GATE_SERVICE_NAME           compose service name for the default endpoint
 *   GATE_TARGET                 human-readable target; default RAGFLOW_BASE_URL, else DOCKER_HOST, else ''
 *   GATE_DISPLAY_NAME           default GATE_ID
 */

export const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const CONNECTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_INTERVAL_SEC = 60;
const REQUEST_TIMEOUT_MS = 5_000;
const BACKOFF_CAP_MS = 30_000;

export interface Announcer {
  start(): void;
  stop(): void;
  /** One announce now; resolves `true` on HTTP 200. Exposed for tests and for `start()`. */
  announceOnce(): Promise<boolean>;
}

export interface AnnouncerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly manifest: readonly Operation[];
  readonly log?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
}

export interface AnnounceBody {
  readonly gateId: string;
  readonly connector: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  readonly target: string;
  readonly endpoint: string;
  readonly healthEndpoint: string;
  readonly displayName: string;
  readonly operations: readonly Operation[];
}

function transportKindOf(env: NodeJS.ProcessEnv): AnnounceBody['transportKind'] {
  const kind = env.GATE_TRANSPORT_KIND ?? 'http';
  if (kind === 'http' || kind === 'mcp' || kind === 'cli' || kind === 'ssh') return kind;
  throw new Error(`announce: GATE_TRANSPORT_KIND must be http/mcp/cli/ssh (got "${kind}")`);
}

/** The body this gate would announce, or `null` when self-registration is not configured. */
export function buildAnnounceBody(
  env: NodeJS.ProcessEnv,
  manifest: readonly Operation[],
): AnnounceBody | null {
  const gateId = env.GATE_ID?.trim();
  const connector = env.GATE_CONNECTOR?.trim();
  const kernelUrl = env.KERNEL_URL?.trim();
  if (!gateId && !connector) return null;
  if (!gateId || !connector || !kernelUrl) {
    throw new Error(
      'announce: GATE_ID, GATE_CONNECTOR and KERNEL_URL must all be set for self-registration (or none of them)',
    );
  }
  if (!GATE_ID_PATTERN.test(gateId)) {
    throw new Error(`announce: GATE_ID "${gateId}" must match ${GATE_ID_PATTERN}`);
  }
  if (!CONNECTOR_NAME_PATTERN.test(connector)) {
    throw new Error(`announce: GATE_CONNECTOR "${connector}" must match ${CONNECTOR_NAME_PATTERN}`);
  }
  const port = env.GATE_PORT ?? '8090';
  const endpoint = (
    env.GATE_PUBLIC_ENDPOINT ?? `http://${env.GATE_SERVICE_NAME ?? hostname()}:${port}`
  ).replace(/\/$/, '');
  return {
    gateId,
    connector,
    transportKind: transportKindOf(env),
    target: env.GATE_TARGET ?? env.RAGFLOW_BASE_URL ?? env.DOCKER_HOST ?? '',
    endpoint,
    healthEndpoint: `${endpoint}/gate/health`,
    displayName: env.GATE_DISPLAY_NAME ?? gateId,
    operations: manifest,
  };
}

export function loadInternalToken(env: NodeJS.ProcessEnv): string {
  const file = env.GATE_INTERNAL_TOKEN_FILE ?? DEFAULT_INTERNAL_TOKEN_FILE;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'error';
    throw new Error(
      `announce: cannot read the internal token file "${file}" (GATE_INTERNAL_TOKEN_FILE; ${code}) — mount the compose secret internal_token or unset GATE_ID to disable self-registration`,
    );
  }
  return normalizeInternalToken(raw, file);
}

/** One `POST /internal/gates/announce`. `true` on 2xx; every failure is a warn line (never the
 *  token) and `false`. Shared by the single-gate announcer and the gate host (host.ts). */
export async function postAnnouncement(options: {
  readonly url: string;
  readonly token: string;
  readonly body: AnnounceBody;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((line: string) => console.error(line));
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const announceBody = options.body;
  const controller = new AbortController();
  const timeout = setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: internalAuthorizationHeader(options.token),
      },
      body: JSON.stringify(announceBody),
      signal: controller.signal,
    });
    if (response.ok) return true;
    let code: string | undefined;
    try {
      const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? parsed.error?.message;
    } catch {
      code = undefined;
    }
    log(
      JSON.stringify({
        level: 'warn',
        msg: 'announce: kernel refused the announcement',
        gateId: announceBody.gateId,
        status: response.status,
        code,
      }),
    );
    return false;
  } catch (err) {
    log(
      JSON.stringify({
        level: 'warn',
        msg: 'announce: kernel unreachable',
        gateId: announceBody.gateId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  } finally {
    clearTimer(timeout);
  }
}

const NOOP_ANNOUNCER: Announcer = {
  start() {},
  stop() {},
  announceOnce: async () => false,
};

export function createAnnouncer(options: AnnouncerOptions): Announcer {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));
  const fetchImpl = options.fetchImpl ?? fetch;
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;

  const body = buildAnnounceBody(env, options.manifest);
  if (!body) {
    log(
      JSON.stringify({
        level: 'info',
        msg: 'announce: self-registration off (GATE_ID / GATE_CONNECTOR / KERNEL_URL not set)',
      }),
    );
    return NOOP_ANNOUNCER;
  }
  const announceBody: AnnounceBody = body;
  const token = loadInternalToken(env);
  const url = `${(env.KERNEL_URL as string).replace(/\/$/, '')}/internal/gates/announce`;
  const intervalMs =
    Math.max(5, Number(env.GATE_ANNOUNCE_INTERVAL_SEC ?? DEFAULT_INTERVAL_SEC)) * 1000;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let backoffMs = 1_000;

  async function announceOnce(): Promise<boolean> {
    return postAnnouncement({
      url,
      token,
      body: announceBody,
      fetchImpl,
      log,
      setTimer,
      clearTimer,
    });
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      void tick();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
  }

  let registered = false;
  async function tick(): Promise<void> {
    const ok = await announceOnce();
    if (stopped) return;
    if (ok) {
      if (!registered) {
        registered = true;
        log(
          JSON.stringify({
            level: 'info',
            msg: 'announce: registered with the kernel',
            gateId: announceBody.gateId,
            connector: announceBody.connector,
            endpoint: announceBody.endpoint,
          }),
        );
      }
      backoffMs = 1_000;
      schedule(intervalMs);
      return;
    }
    // Until the first success: exponential backoff (1 s → 30 s). After it: keep the heartbeat
    // interval — a rejected heartbeat must not turn into a tight loop either way.
    if (!registered) {
      schedule(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
    } else {
      schedule(intervalMs);
    }
  }

  return {
    start() {
      if (timer !== undefined || stopped) return;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
    announceOnce,
  };
}
