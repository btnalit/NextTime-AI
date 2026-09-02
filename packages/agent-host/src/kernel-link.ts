import type {
  AgentHostToKernelFrame,
  AgentRuntimeEventWire,
  KernelToAgentHostFrame,
} from '@nexttime/shared';
import { KernelToAgentHostFrameSchema } from '@nexttime/shared';
import { WebSocket as NodeWebSocket } from 'ws';

/**
 * kernel-link: the one long-lived WebSocket agent-host opens to the kernel's
 * `/internal/agent-host` (design doc §7.2, §7.10; docs/development-tasks.md S1.5, second half,
 * architecture point 1). Reconnects with exponential backoff (capped) on any drop — the kernel
 * side tolerates absence entirely (`AgentHostRuntime.startTurn` with no link connected reports
 * `turnEnded {status:'failed'}` itself, per that module's own doc comment), so this side's only
 * job on reconnect is to say who it is (`hello` with a *process-lifetime* `instanceId` — see
 * `@nexttime/shared`'s `agent-host-protocol.ts` doc comment for why the kernel needs to tell a
 * mere reconnect apart from a genuine restart) and resume relaying.
 *
 * No auth of its own — same `control`-network-only trust boundary as every other `/internal/*`
 * kernel route (see `packages/kernel/src/interfaces/ws/agent-host.ts`'s own doc comment).
 */

const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

export interface KernelLinkOptions {
  /** e.g. `ws://kernel:8080/internal/agent-host`. */
  readonly kernelWsUrl: string;
  /** Generated once per agent-host *process* (not per connection) — see this module's own doc
   *  comment. */
  readonly instanceId: string;
  readonly onStartTurn: (cmd: Extract<KernelToAgentHostFrame, { type: 'startTurn' }>) => void;
  readonly onStopTurn: (cmd: Extract<KernelToAgentHostFrame, { type: 'stopTurn' }>) => void;
  readonly log?: (line: string) => void;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** Injectable WebSocket constructor, for tests. Defaults to `ws`'s own `WebSocket`. */
  readonly WebSocketCtor?: typeof NodeWebSocket;
}

export interface KernelLink {
  /** Connects (or begins the reconnect loop). Idempotent — a second call while already
   *  started/connecting is a no-op. */
  start(): void;
  /** Stops reconnecting and closes the current connection, if any. */
  stop(): void;
  isConnected(): boolean;
  /** Any of the three outbound frame kinds silently drops the frame (with a logged warning) when
   *  not currently connected — matching the design's own "kernel tolerates absence" posture: a
   *  runtimeEvent lost to a mid-turn disconnect is not this link's problem to solve (host.ts's own
   *  container-close handling, and the kernel's `instanceId`-keyed restart detection, are what
   *  cover that — see this module's own doc comment). */
  sendRuntimeEvent(event: AgentRuntimeEventWire): void;
  sendTurnAccepted(turnId: string): void;
  sendTurnRejected(turnId: string, reason: string): void;
}

export function createKernelLink(options: KernelLinkOptions): KernelLink {
  const log = options.log ?? ((line: string) => console.error(line));
  const WebSocketCtor = options.WebSocketCtor ?? NodeWebSocket;
  const baseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const maxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;

  let socket: NodeWebSocket | undefined;
  let stopped = true;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;

  function send(frame: AgentHostToKernelFrame): void {
    if (!socket || socket.readyState !== NodeWebSocket.OPEN) {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'kernel-link: dropped a frame — not currently connected to the kernel',
          frameType: frame.type,
        }),
      );
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
    reconnectTimer.unref?.();
  }

  function connect(): void {
    if (stopped) return;
    const ws = new WebSocketCtor(options.kernelWsUrl);
    socket = ws;

    ws.on('open', () => {
      attempt = 0;
      log(
        JSON.stringify({
          level: 'info',
          msg: 'kernel-link: connected',
          instanceId: options.instanceId,
        }),
      );
      send({ type: 'hello', instanceId: options.instanceId });
    });

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return; // malformed frame from the kernel — ignored, not fatal
      }
      const result = KernelToAgentHostFrameSchema.safeParse(parsed);
      if (!result.success) return;
      if (result.data.type === 'startTurn') options.onStartTurn(result.data);
      else options.onStopTurn(result.data);
    });

    ws.on('close', () => {
      if (socket === ws) socket = undefined;
      log(JSON.stringify({ level: 'warn', msg: 'kernel-link: disconnected — will reconnect' }));
      scheduleReconnect();
    });
    ws.on('error', (err) => {
      log(JSON.stringify({ level: 'warn', msg: 'kernel-link: socket error', error: String(err) }));
      // 'close' always follows 'error' for `ws` — reconnect is scheduled there, not here.
    });
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      socket?.close();
      socket = undefined;
    },
    isConnected(): boolean {
      return socket !== undefined && socket.readyState === NodeWebSocket.OPEN;
    },
    sendRuntimeEvent(event: AgentRuntimeEventWire): void {
      send({ type: 'runtimeEvent', event });
    },
    sendTurnAccepted(turnId: string): void {
      send({ type: 'turnAccepted', turnId });
    },
    sendTurnRejected(turnId: string, reason: string): void {
      send({ type: 'turnRejected', turnId, reason });
    },
  };
}
