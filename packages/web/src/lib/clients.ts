import type {
  ActionPendingPush,
  ActionUpdatedPush,
  TaskUpdatedPush,
  Unsubscribe,
  WsConnectionStatus,
} from './ws-client.js';

/**
 * lib/clients: the two narrow interfaces every page depends on instead of the concrete
 * `HttpClient`/`WsClient` classes. `HttpClient` satisfies `CapabilityCaller`; `WsClient` satisfies
 * both `CapabilityCaller` (the `chat` group over WS) and `PushSource`. Component tests hand pages a
 * plain object with a `vi.fn()` `call` and no-op subscriptions — no socket, no fetch, no kernel.
 */
export interface CapabilityCaller {
  call<T = unknown>(capabilityName: string, params?: unknown): Promise<T>;
}

export interface PushSource {
  onActionPending(handler: (event: ActionPendingPush) => void): Unsubscribe;
  onActionUpdated(handler: (event: ActionUpdatedPush) => void): Unsubscribe;
  onTaskUpdated(handler: (event: TaskUpdatedPush) => void): Unsubscribe;
  getStatus(): WsConnectionStatus;
  onStatusChange(handler: (status: WsConnectionStatus) => void): Unsubscribe;
}

/** A `PushSource` that never pushes — for tests and for pages rendered without a socket. */
export const SILENT_PUSH_SOURCE: PushSource = {
  onActionPending: () => () => undefined,
  onActionUpdated: () => () => undefined,
  onTaskUpdated: () => () => undefined,
  getStatus: () => 'closed',
  onStatusChange: () => () => undefined,
};
