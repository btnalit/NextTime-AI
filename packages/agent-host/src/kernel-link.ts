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
 * `turnEnded {status:'failed'}` itself, per that module's own doc comment), so this side's job on
 * reconnect is to say who it is (`hello` with a *process-lifetime* `instanceId` — see
 * `@nexttime/shared`'s `agent-host-protocol.ts` doc comment for why the kernel needs to tell a
 * mere reconnect apart from a genuine restart) and resume relaying from where the kernel stopped
 * acknowledging.
 *
 * Replay (2026-10-02 review R-56, design doc §13 "事件桥重连并从最后确认的事件续读"): every outbound
 * frame but `hello` gets the next `seq` and is kept until the kernel's `ack` covers it; after the
 * `hello` of each new connection the kept frames are sent again, oldest first. Before R-56 a frame
 * sent while the link was down was dropped (with a log line) and one written into a half-open
 * socket vanished silently — a Turn's final message and `turnEnded` with it, so the kernel kept
 * the Turn active and the chat refused every new message until a kernel restart. What is kept is
 * bounded per Turn (`maxBufferedFramesPerTurn`): over the bound, the Turn's oldest `textDelta`
 * goes first, then its oldest `message` or `toolCall*` (the kernel stores a record of each tool
 * call); `turnAccepted`/`turnRejected`/
 * `turnUnknown` and `turnEnded` are never dropped for the per-Turn bound. No new Turn can start
 * while the link is down (`startTurn` only arrives over it), so the number of Turns with frames
 * waiting is bounded by the Turns active when it dropped. A process-wide cap
 * (`maxBufferedFrames`, oldest first) covers a kernel that never acknowledges. An agent-host
 * restart loses what was kept — the kernel's `instanceId` check abandons those Turns instead.
 *
 * Heartbeat (R-56): this side pings the kernel every `heartbeatIntervalMs` and terminates a socket
 * whose previous ping is still unanswered, so a half-open link (the kernel side gone without a
 * close) is noticed and reconnected instead of swallowing frames indefinitely. The kernel side
 * needs no periodic ping of its own: a reconnect that finds the old link still registered is
 * refused with 1013 and the old one is probed (R-03, packages/kernel/src/interfaces/ws/
 * agent-host.ts).
 *
 * Auth (fix/internal-plane-auth, 2026-09): every connection attempt (the initial one and every
 * reconnect) carries `Authorization: Bearer <internal-plane token>` on the WebSocket handshake
 * request — `@nexttime/shared`'s `internal-token.ts` contract, checked by
 * `packages/kernel/src/interfaces/internal-auth`'s guard before the upgrade is even accepted (see
 * that module's own doc comment for the full threat model). `main()` (`index.ts`) loads the token
 * once at startup and fails fast if it cannot; this module only carries the already-built header
 * value (`KernelLinkOptions.authorizationHeader`) and never reads the token file itself.
 */

const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
/** R-56: ping cadence; a ping still unanswered one interval later ends the connection. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** R-56: unacknowledged frames kept per Turn (see the module doc comment). */
const DEFAULT_MAX_BUFFERED_FRAMES_PER_TURN = 256;
/** R-56: unacknowledged frames kept in all — only reached if the kernel never acknowledges. */
const DEFAULT_MAX_BUFFERED_FRAMES = 4096;

/** The kernel's close code for a refused second link (`LINK_REFUSED_CLOSE_CODE` in
 *  packages/kernel/src/interfaces/ws/agent-host.ts, RFC 6455 1013 "Try Again Later"): another
 *  link is registered, so retrying at the base delay would only spin until it goes away. */
const LINK_REFUSED_CLOSE_CODE = 1013;

type SequencedFrame = Exclude<AgentHostToKernelFrame, { type: 'hello' }>;

/** A frame without its `seq` — what the `send*` methods build before `enqueue` numbers it. */
type UnsequencedFrame = SequencedFrame extends infer F
  ? F extends SequencedFrame
    ? Omit<F, 'seq'>
    : never
  : never;

interface BufferedFrame {
  readonly seq: number;
  readonly turnId: string;
  readonly frame: SequencedFrame;
}

/** Which of a Turn's kept frames goes first when it is over its bound: 0 (text deltas) before 1
 *  (`message`, and the tool events the kernel stores a tool-call record from); 2 is never dropped
 *  for the per-Turn bound. */
function evictionRank(frame: SequencedFrame): number {
  if (frame.type !== 'runtimeEvent') return 2;
  switch (frame.event.type) {
    case 'textDelta':
      return 0;
    case 'toolCallStarted':
    case 'toolCallEnded':
    case 'message':
      return 1;
    case 'turnEnded':
      return 2;
  }
}

function turnIdOf(frame: UnsequencedFrame): string {
  return frame.type === 'runtimeEvent' ? frame.event.turnId : frame.turnId;
}

export interface KernelLinkOptions {
  /** e.g. `ws://kernel:8080/internal/agent-host`. */
  readonly kernelWsUrl: string;
  /** `Authorization` header value sent on every handshake (initial connect and every reconnect) —
   *  `@nexttime/shared`'s `internalAuthorizationHeader(token)`, i.e. `Bearer <token>`. */
  readonly authorizationHeader: string;
  /** Generated once per agent-host *process* (not per connection) — see this module's own doc
   *  comment. */
  readonly instanceId: string;
  readonly onStartTurn: (cmd: Extract<KernelToAgentHostFrame, { type: 'startTurn' }>) => void;
  readonly onStopTurn: (cmd: Extract<KernelToAgentHostFrame, { type: 'stopTurn' }>) => void;
  readonly log?: (line: string) => void;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** R-56 overrides (tests): see the module doc comment. */
  readonly heartbeatIntervalMs?: number;
  readonly maxBufferedFramesPerTurn?: number;
  readonly maxBufferedFrames?: number;
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
  /** Each outbound frame kind is numbered and kept until the kernel acknowledges it, sent now if
   *  a link is up and again after the next `hello` otherwise (R-56, this module's doc comment) —
   *  none of them throws or drops a frame because the link is down. */
  sendRuntimeEvent(event: AgentRuntimeEventWire): void;
  sendTurnAccepted(turnId: string): void;
  sendTurnRejected(turnId: string, reason: string): void;
  /** R-56: the answer to a `stopTurn` for a Turn this process has no record of. */
  sendTurnUnknown(turnId: string): void;
}

export function createKernelLink(options: KernelLinkOptions): KernelLink {
  const log = options.log ?? ((line: string) => console.error(line));
  const WebSocketCtor = options.WebSocketCtor ?? NodeWebSocket;
  const baseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const maxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxPerTurn = options.maxBufferedFramesPerTurn ?? DEFAULT_MAX_BUFFERED_FRAMES_PER_TURN;
  const maxTotal = options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED_FRAMES;

  let socket: NodeWebSocket | undefined;
  let stopped = true;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;

  /** R-56: unacknowledged frames, in `seq` order (eviction only ever removes, never reorders). */
  const buffer: BufferedFrame[] = [];
  let nextSeq = 1;
  /** Turns already warned about for an eviction — one line per Turn, not per dropped delta. */
  const evictionWarned = new Set<string>();

  function isOpen(ws: NodeWebSocket | undefined): ws is NodeWebSocket {
    return ws !== undefined && ws.readyState === NodeWebSocket.OPEN;
  }

  function enforceBounds(turnId: string): void {
    let count = 0;
    for (const entry of buffer) if (entry.turnId === turnId) count += 1;
    while (count > maxPerTurn) {
      let victim = -1;
      let victimRank = 2;
      for (let i = 0; i < buffer.length; i += 1) {
        const entry = buffer[i] as BufferedFrame;
        if (entry.turnId !== turnId) continue;
        const rank = evictionRank(entry.frame);
        if (rank < victimRank) {
          victim = i;
          victimRank = rank;
          if (rank === 0) break;
        }
      }
      if (victim < 0) break; // only frames that are never dropped are left
      buffer.splice(victim, 1);
      count -= 1;
      if (!evictionWarned.has(turnId)) {
        if (evictionWarned.size >= maxTotal) evictionWarned.clear();
        evictionWarned.add(turnId);
        log(
          JSON.stringify({
            level: 'warn',
            msg: 'kernel-link: unacknowledged frames over the per-Turn bound — dropping the oldest text deltas (then messages and tool events) for this Turn',
            turnId,
            maxBufferedFramesPerTurn: maxPerTurn,
          }),
        );
      }
    }
    while (buffer.length > maxTotal) {
      const dropped = buffer.shift();
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'kernel-link: unacknowledged frames over the overall bound — dropped the oldest',
          turnId: dropped?.turnId,
          frameType: dropped?.frame.type,
        }),
      );
    }
  }

  function enqueue(frame: UnsequencedFrame): void {
    const seq = nextSeq;
    nextSeq += 1;
    const sequenced = { ...frame, seq } as SequencedFrame;
    const turnId = turnIdOf(frame);
    buffer.push({ seq, turnId, frame: sequenced });
    enforceBounds(turnId);
    // Sent now only on an open link: `open` sends `hello` and then everything kept, in order, in
    // one synchronous handler, so a frame sent here can never overtake either.
    if (isOpen(socket)) socket.send(JSON.stringify(sequenced));
  }

  function acknowledge(seq: number): void {
    while (buffer.length > 0 && (buffer[0] as BufferedFrame).seq <= seq) buffer.shift();
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
    // The internal-plane guard (packages/kernel/src/interfaces/internal-auth) rejects the upgrade
    // with 401 before `hello` is ever read unless this header is present and correct — sent on
    // every attempt, not only the first, since a reconnect is a brand-new HTTP upgrade request.
    const ws = new WebSocketCtor(options.kernelWsUrl, {
      headers: { authorization: options.authorizationHeader },
    });
    socket = ws;
    let opened = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let awaitingPong = false;

    ws.on('open', () => {
      // The backoff is reset on close, not here: the kernel accepts the upgrade of a refused
      // second link before closing it with 1013, so resetting on `open` would retry it every
      // `baseDelayMs` forever.
      opened = true;
      log(
        JSON.stringify({
          level: 'info',
          msg: 'kernel-link: connected',
          instanceId: options.instanceId,
          replaying: buffer.length,
        }),
      );
      ws.send(JSON.stringify({ type: 'hello', instanceId: options.instanceId }));
      // R-56: everything the kernel has not acknowledged, oldest first, right after `hello`.
      for (const entry of buffer) ws.send(JSON.stringify(entry.frame));

      heartbeat = setInterval(() => {
        if (ws.readyState !== NodeWebSocket.OPEN) return; // closing — `close` clears this timer
        if (awaitingPong) {
          log(
            JSON.stringify({
              level: 'warn',
              msg: 'kernel-link: no pong from the kernel within one heartbeat — dropping the link to reconnect',
            }),
          );
          ws.terminate();
          return;
        }
        awaitingPong = true;
        ws.ping();
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
    });

    ws.on('pong', () => {
      awaitingPong = false;
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
      const frame = result.data;
      if (frame.type === 'ack') acknowledge(frame.seq);
      else if (frame.type === 'startTurn') options.onStartTurn(frame);
      else options.onStopTurn(frame);
    });

    ws.on('close', (code) => {
      if (heartbeat) clearInterval(heartbeat);
      if (socket === ws) socket = undefined;
      const refused = code === LINK_REFUSED_CLOSE_CODE;
      // A link that was up and then dropped reconnects promptly; a refused one (another link is
      // registered — the kernel probes it and drops it if dead) and a connection that never opened
      // keep backing off.
      if (opened && !refused) attempt = 0;
      log(
        JSON.stringify({
          level: 'warn',
          msg: refused
            ? 'kernel-link: refused — another agent-host link is registered; will retry with backoff'
            : 'kernel-link: disconnected — will reconnect',
          code,
          unacknowledged: buffer.length,
        }),
      );
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
      return isOpen(socket);
    },
    sendRuntimeEvent(event: AgentRuntimeEventWire): void {
      enqueue({ type: 'runtimeEvent', event });
    },
    sendTurnAccepted(turnId: string): void {
      enqueue({ type: 'turnAccepted', turnId });
    },
    sendTurnRejected(turnId: string, reason: string): void {
      enqueue({ type: 'turnRejected', turnId, reason });
    },
    sendTurnUnknown(turnId: string): void {
      enqueue({ type: 'turnUnknown', turnId });
    },
  };
}
