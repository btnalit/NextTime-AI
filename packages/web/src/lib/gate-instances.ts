import type { AvailableGateInstanceWire, GateInstanceWire } from '@nexttime/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceState } from '../hooks/useResource.js';
import type { CapabilityCaller } from './clients.js';
import type { ConnectionKind } from './connections.js';

/**
 * lib/gate-instances: S6-C (docs/console-completion-plan.md §5.6) helpers shared by the
 * "接入一个系统" launcher (`components/connect/ConnectSystemLauncher.tsx`) and the two pages that
 * mount it — which of design §6.3's two gate-instance paths a transport kind takes, the hash
 * links between a platform instance and the workspace 系统接入 page, and a small polling read of
 * the gate-instance lists for the "wait until it announces / the host takes it over" steps.
 */

/** design §6.3 "门实例的两条路径": http / mcp are served by the generic gate host (an administrator
 *  creates the instance on the 集成 page, P-B2a); cli / ssh carry a binary and a key, so they stay
 *  packaged gates — a compose service that announces itself (`GATE_ID` / `GATE_CONNECTOR`). */
export type GatePath = 'hosted' | 'packaged';

export function gatePathForKind(kind: ConnectionKind): GatePath {
  return kind === 'http' || kind === 'mcp' ? 'hosted' : 'packaged';
}

/** `#/platform/integrations/<gateId>` — the deep link the workspace page's "平台实例" chip uses.
 *  `lib/router.ts` (another lane's file) does not parse the trailing segment yet; until it does the
 *  hash falls back to the default route, so callers should prefer the bare
 *  `hrefs.platformIntegrations()` unless the route line reported by S6-C has landed. Kept here so
 *  the spelling exists in exactly one place. */
export function platformGateInstanceHref(gateId: string): string {
  return `#/platform/integrations/${encodeURIComponent(gateId)}`;
}

/** Whether the kernel's `enable_gate_instance` would accept this instance right now
 *  (`gate-instance-handlers.ts` `requireAvailable`: announced at least once, has Operations,
 *  administrator-enabled). Used by the launcher to know when the "wait for the gate host / the
 *  gate's announce" step is over. */
export function gateInstanceReady(
  instance: Pick<GateInstanceWire, 'status' | 'lastSeenAt' | 'operationCount'>,
): boolean {
  return (
    instance.status === 'enabled' && instance.lastSeenAt !== null && instance.operationCount > 0
  );
}

/** The gate has been heard from (announce / gate-host takeover) and described Operations — the
 *  precondition for the administrator's own 启用 to be meaningful. */
export function gateInstanceAnnounced(
  instance: Pick<GateInstanceWire, 'lastSeenAt' | 'operationCount'>,
): boolean {
  return instance.lastSeenAt !== null && instance.operationCount > 0;
}

export type GateInstanceListName = 'list_gate_instances' | 'list_available_gate_instances';

export interface GateInstancePoll<T> {
  readonly state: ResourceState<readonly T[]>;
  readonly refresh: () => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Polls `list_gate_instances` (platform plane — every status, what an administrator sees) or
 * `list_available_gate_instances` (workspace plane — only what this workspace may enable) every
 * `intervalMs` while `active`, so the launcher can wait for a packaged gate's first announce or the
 * gate host's takeover of a hosted instance without the reader pressing Refresh. Overlapping
 * calls are skipped (one in flight at a time); a failed poll after a success keeps the last rows
 * (`refreshError`), the same `ResourceState` contract every page renders from. Stops on unmount
 * or when `active` turns false.
 */
export function useGateInstancePoll<T = GateInstanceWire | AvailableGateInstanceWire>(
  http: CapabilityCaller,
  name: GateInstanceListName,
  params: Readonly<Record<string, unknown>>,
  options: { readonly active: boolean; readonly intervalMs?: number },
): GateInstancePoll<T> {
  const { active } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const [state, setState] = useState<ResourceState<readonly T[]>>({ status: 'loading' });
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const serializedParams = JSON.stringify(params);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = stateRef.current;
    if (current.status === 'ready') setState({ ...current, refreshing: true, refreshError: null });
    try {
      const result = await http.call<{ readonly items: readonly T[] }>(
        name,
        JSON.parse(serializedParams) as Record<string, unknown>,
      );
      if (!mounted.current) return;
      setState({ status: 'ready', data: result.items, refreshing: false, refreshError: null });
    } catch (error) {
      if (!mounted.current) return;
      setState((prev) =>
        prev.status === 'ready'
          ? { ...prev, refreshing: false, refreshError: error }
          : { status: 'error', error },
      );
    } finally {
      inFlight.current = false;
    }
  }, [http, name, serializedParams]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, refresh]);

  return { state, refresh };
}
