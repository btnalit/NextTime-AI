import type { ChatStreamPayload } from '@nexttime/shared';

/**
 * lib/streaming-reducer: assembles one in-progress Turn's ephemeral `chat.stream`/`chat.metadata`
 * push events (design doc §9.4; docs/development-tasks.md S1.8 deliverable 1) into the state the
 * chat page renders — the running assistant reply text, a list of tool-call rows, and the Turn's
 * status badge. Pure and dependency-free (no DOM, no WsClient) so it is unit-testable without a
 * socket at all; the chat page component is the only caller, feeding it events forwarded from
 * `WsClient.subscribeChat`'s `onStream`/`onMetadata` handlers.
 *
 * Scope: only the *current* Turn's transient state. Persisted chat history (`chat.message`) is a
 * separate concern the chat page keeps as its own `ChatMessage[]` (keyed by `sequence`, from
 * `WsClient.subscribeChat`'s `onMessage`) — this reducer never sees those.
 */

export type TurnStatus = 'idle' | 'running' | 'completed' | 'interrupted' | 'failed';

export interface ToolCallRow {
  readonly toolCallId: string;
  readonly name: string;
  readonly args?: unknown;
  readonly status: 'started' | 'ended';
  readonly result?: unknown;
}

export interface TurnState {
  readonly turnId: string | null;
  readonly status: TurnStatus;
  readonly streamingText: string;
  readonly toolCalls: readonly ToolCallRow[];
}

export const initialTurnState: TurnState = {
  turnId: null,
  status: 'idle',
  streamingText: '',
  toolCalls: [],
};

export type StreamAction =
  /** Dispatched locally when `send_chat_message` succeeds (result.turnId) — the only way this
   *  reducer learns a new Turn started; nothing on the wire announces "TurnStarted" to the human
   *  channel (design doc §7.10's `TurnStarted` domain event is host-bridge-internal). */
  | { readonly kind: 'turnStarted'; readonly turnId: string }
  /** One `chat.stream` push (WsClient's `onStream(turnId, payload)`). */
  | { readonly kind: 'stream'; readonly turnId: string; readonly payload: ChatStreamPayload }
  /** One `chat.metadata` push (WsClient's `onMetadata(metadata)`) — carries `{turnId, turnStatus}`
   *  when a Turn ends (application/chat/event-sink.ts `turnEnded` case). */
  | { readonly kind: 'metadata'; readonly metadata: Readonly<Record<string, unknown>> };

function isKnownTurnStatus(value: unknown): value is TurnStatus {
  return (
    value === 'completed' ||
    value === 'interrupted' ||
    value === 'failed' ||
    value === 'running' ||
    value === 'idle'
  );
}

function applyStreamPayload(state: TurnState, payload: ChatStreamPayload): TurnState {
  switch (payload.streamKind) {
    case 'textDelta':
      return { ...state, streamingText: state.streamingText + payload.delta };

    case 'toolCallStarted': {
      const row: ToolCallRow = {
        toolCallId: payload.toolCallId,
        name: payload.name,
        args: payload.args,
        status: 'started',
      };
      return { ...state, toolCalls: [...state.toolCalls, row] };
    }

    case 'toolCallEnded': {
      const toolCalls = state.toolCalls.map((row) =>
        row.toolCallId === payload.toolCallId
          ? { ...row, status: 'ended' as const, result: payload.result }
          : row,
      );
      return { ...state, toolCalls };
    }

    default:
      // workerSpawned / taskUpdated: S2 scope (Worker/Task lifecycle) — no S1.8 UI surface for
      // these yet; falls through to this no-op default rather than an explicit case per streamKind,
      // since the two behave identically here (a future S2 extension is where they'd diverge).
      return state;
  }
}

export function streamReducer(state: TurnState, action: StreamAction): TurnState {
  switch (action.kind) {
    case 'turnStarted':
      return { turnId: action.turnId, status: 'running', streamingText: '', toolCalls: [] };

    case 'stream':
      if (action.turnId !== state.turnId) return state;
      return applyStreamPayload(state, action.payload);

    case 'metadata': {
      const { turnId, turnStatus } = action.metadata as {
        turnId?: unknown;
        turnStatus?: unknown;
      };
      if (typeof turnId !== 'string' || turnId !== state.turnId) return state;
      if (!isKnownTurnStatus(turnStatus)) return state;
      return { ...state, status: turnStatus };
    }

    default:
      return state;
  }
}
