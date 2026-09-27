import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import {
  type AgentRuntimeEventWire,
  type KernelToAgentHostFrame,
  MetricsRegistry,
  PROMETHEUS_TEXT_CONTENT_TYPE,
} from '@nexttime/shared';
import type { KernelLink } from './kernel-link.js';

/**
 * metrics: agent-host's Turn-level observability (docs/STATUS.md leftover 87) — counters for
 * `GET /internal/metrics` on the existing healthz port (8090, index.ts) plus one structured log
 * line when a Turn starts and one when it ends, both carrying the Turn id as `correlationId` (the
 * same id the kernel, worker-supervisor and the entry agent's own kernel calls log it under).
 *
 * Observed at the one boundary every Turn crosses: the `startTurn` frame in, and the outcome
 * frame out (`turnRejected`, or a `turnEnded` runtime event) — `observe(link)` decorates the
 * `KernelLink` host.ts sends through, so host.ts itself is unchanged.
 *
 *   nexttime_agent_host_turns_started_total                  counter
 *   nexttime_agent_host_turns_ended_total{status}            counter
 *   nexttime_agent_host_turn_duration_seconds{status}        histogram
 *   nexttime_agent_host_active_turns                         gauge
 *   nexttime_agent_host_kernel_link_up                       gauge (1 connected / 0 not)
 *
 * `status` ∈ completed | interrupted | failed (pi's own outcome) | rejected (never reached pi).
 */

type StartTurn = Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;

export interface AgentHostMetricsOptions {
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

export interface AgentHostMetrics {
  /** Call for every `startTurn` frame, before host.ts handles it. */
  turnStarted(cmd: StartTurn): void;
  /** Returns a `KernelLink` that records each Turn outcome it forwards. */
  observe(link: KernelLink): KernelLink;
  render(): string;
}

export function createAgentHostMetrics(options: AgentHostMetricsOptions = {}): AgentHostMetrics {
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => Date.now());
  const registry = new MetricsRegistry();
  const started = registry.counter(
    'nexttime_agent_host_turns_started_total',
    'startTurn commands received from the kernel.',
  );
  const ended = registry.counter(
    'nexttime_agent_host_turns_ended_total',
    'Turns that ended, by outcome (rejected = never reached pi).',
    ['status'],
  );
  const duration = registry.histogram(
    'nexttime_agent_host_turn_duration_seconds',
    'Wall time from startTurn to the Turn outcome, by outcome.',
    ['status'],
  );
  const active = registry.gauge('nexttime_agent_host_active_turns', 'Turns currently in flight.');
  const linkUp = registry.gauge(
    'nexttime_agent_host_kernel_link_up',
    'Whether the event-bridge WebSocket to the kernel is connected (1) or not (0).',
  );
  const startedAt = new Map<string, number>();
  let observedLink: KernelLink | undefined;

  function finish(turnId: string, status: string): void {
    const t0 = startedAt.get(turnId);
    if (t0 === undefined) return; // not observed starting (or already ended) — count once only
    startedAt.delete(turnId);
    const durationSeconds = (now() - t0) / 1000;
    ended.inc({ status });
    duration.observe({ status }, durationSeconds);
    active.dec();
    log(
      JSON.stringify({
        level: 'info',
        msg: 'agent-host: turn ended',
        correlationId: turnId,
        turnId,
        status,
        durationMs: Math.round(durationSeconds * 1000),
      }),
    );
  }

  return {
    turnStarted(cmd) {
      if (startedAt.has(cmd.turnId)) return;
      startedAt.set(cmd.turnId, now());
      started.inc();
      active.inc();
      log(
        JSON.stringify({
          level: 'info',
          msg: 'agent-host: turn started',
          correlationId: cmd.turnId,
          turnId: cmd.turnId,
          workspaceId: cmd.workspaceId,
          chatId: cmd.chatId,
          principalId: cmd.principalId,
        }),
      );
    },
    observe(link) {
      observedLink = link;
      return {
        start: () => link.start(),
        stop: () => link.stop(),
        isConnected: () => link.isConnected(),
        sendTurnAccepted: (turnId) => link.sendTurnAccepted(turnId),
        sendTurnRejected: (turnId, reason) => {
          link.sendTurnRejected(turnId, reason);
          finish(turnId, 'rejected');
        },
        sendRuntimeEvent: (event: AgentRuntimeEventWire) => {
          link.sendRuntimeEvent(event);
          if (event.type === 'turnEnded') finish(event.turnId, event.status);
        },
      };
    },
    render() {
      if (observedLink) linkUp.set(undefined, observedLink.isConnected() ? 1 : 0);
      return registry.render();
    },
  };
}

function tokenMatches(presented: string, expected: Buffer): boolean {
  const presentedBuffer = Buffer.from(presented, 'utf8');
  return presentedBuffer.length === expected.length && timingSafeEqual(presentedBuffer, expected);
}

/**
 * `GET /internal/metrics` for the healthz listener: the internal-plane token agent-host already
 * holds (`Authorization: Bearer <token>`, constant-time compared) or 401. Returns `false` for any
 * other request so the caller can fall through to its own routes.
 */
export function handleMetricsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { readonly authorizationHeader: string; readonly render: () => string },
): boolean {
  if (req.method !== 'GET' || req.url !== '/internal/metrics') return false;
  const presented = req.headers.authorization;
  if (
    typeof presented !== 'string' ||
    !tokenMatches(presented, Buffer.from(options.authorizationHeader, 'utf8'))
  ) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(
      JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'unauthorized' } }),
    );
    return true;
  }
  res.writeHead(200, { 'content-type': PROMETHEUS_TEXT_CONTENT_TYPE });
  res.end(options.render());
  return true;
}
