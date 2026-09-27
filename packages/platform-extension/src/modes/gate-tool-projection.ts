import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type KernelClient, KernelError } from '../kernel-client.js';
import { type AllowedOperationWire, gateToolName } from './gate-tools.js';

/**
 * Per-turn gate tool projection (收尾波次 C3, productization-plan-v2 §7 "P4"): keeps the pi tool
 * set an agent sees in step with the kernel's own `list_allowed_operations` read model, refreshed
 * at every turn start instead of only once at `session_start` — so a gate enabled in the workspace or
 * an Operation published / deprecated reaches a running agent on its next turn, without restarting
 * its container. (Changes that rotate the Handle — Grant, AgentProfile / AgentPolicy, connector deny
 * list — still recreate the container on the next Turn; that is authority delivery, not this.)
 *
 * **Projection is UX, not authority.** The kernel re-checks every call (`observe_operation` runs
 * `observeRefusal` per call); a stale tool here can only produce a refused call, a missing one only
 * hides a call the kernel would have allowed. Nothing in this module widens or narrows what the
 * Handle may do.
 *
 * pi 0.87.1 surface this relies on (`dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`
 * — see docs/runbooks/pi-upgrade.md §2.3 for the verification record):
 *
 *   - `registerTool()` after `session_start` is supported: it stores the definition by name
 *     (re-registering a name replaces the definition) and calls `refreshTools()`, which activates
 *     names that are new to the registry and keeps every previously active name active.
 *   - There is no `unregisterTool`; a tool leaves the model's view only by being left out of
 *     `setActiveTools(names)`, which *replaces* the whole active set (built-ins included) and
 *     ignores unknown names. So this module always derives the next set from `getActiveTools()`
 *     and only ever adds / drops names it assigned itself — pi's built-ins, the mode's static
 *     capability tools and anything else registered stay exactly as they were.
 *   - `before_agent_start` handlers are awaited before the run; when a handler calls
 *     `setActiveTools()` and does not edit `event.systemPromptOptions.selectedTools`, pi takes the
 *     live loadout for that run's request (tool declarations + system prompt sections are rebuilt
 *     from it), and every later request of the same run reads the live loadout again.
 */

/** Per-refresh kernel read budget. `list_allowed_operations` is a handful of indexed reads on the
 *  kernel; a refresh that has not answered by then is abandoned (previous set kept) rather than
 *  holding up the turn — the RPC `prompt` is acknowledged only after `before_agent_start`. */
export const GATE_TOOL_REFRESH_TIMEOUT_MS = 2_000;

export type GateToolRefreshReason = 'session_start' | 'turn';

export interface GateToolRefreshTrigger {
  readonly reason: GateToolRefreshReason;
  /** Platform Turn id, when known (entry mode's `input` marker) — logged only. */
  readonly turnId?: string;
}

export interface GateToolProjectorOptions {
  readonly kernelClient: KernelClient;
  /** Log prefix component: lines read `nexttime-<component> check=tool_projection ...`. */
  readonly component: string;
  /** Which allowed Operations this mode projects (entry: observe-class only). */
  readonly include: (op: AllowedOperationWire) => boolean;
  /** Builds the pi tool for one projected Operation under its already-resolved name / label. */
  readonly buildTool: (op: AllowedOperationWire, name: string, label: string) => ToolDefinition;
  /** Overrides {@link GATE_TOOL_REFRESH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export interface GateToolProjector {
  /** One `list_allowed_operations` read, then the active set is reconciled. Never throws; a failed
   *  or slow read keeps the previous set. Concurrent calls share the in-flight refresh. */
  refresh(trigger: GateToolRefreshTrigger): Promise<void>;
}

/** Identity of one projected Operation across refreshes. */
function operationKey(op: AllowedOperationWire): string {
  return `${op.gatekeeperId}\u0000${op.name}`;
}

function isWellFormed(op: unknown): op is AllowedOperationWire {
  if (typeof op !== 'object' || op === null) return false;
  const row = op as Record<string, unknown>;
  return (
    typeof row.gatekeeperId === 'string' &&
    typeof row.gateName === 'string' &&
    typeof row.name === 'string' &&
    typeof row.operation === 'object' &&
    row.operation !== null
  );
}

function formatNames(names: readonly string[]): string {
  return names.length > 0 ? names.join(',') : '-';
}

function sameOrderedNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function createGateToolProjector(
  pi: ExtensionAPI,
  options: GateToolProjectorOptions,
): GateToolProjector {
  const timeoutMs = options.timeoutMs ?? GATE_TOOL_REFRESH_TIMEOUT_MS;
  const prefix = `nexttime-${options.component} check=tool_projection`;

  // Stable for the session: an Operation keeps its tool name across refreshes, and a name once
  // assigned is never handed to a different Operation (the model's earlier tool calls keep
  // meaning what they meant). Names this projector assigned are the only ones it ever deactivates.
  const nameByKey = new Map<string, string>();
  // What was last registered under each assigned name — a changed row (new description, schema,
  // blast radius) is re-registered so the declaration the model sees stays current.
  const fingerprintByName = new Map<string, string>();
  let inFlight: Promise<void> | undefined;

  async function readAllowedOperations(): Promise<AllowedOperationWire[]> {
    const response = await options.kernelClient.call<{ items?: unknown } | null>(
      'list_allowed_operations',
      {},
      undefined,
      timeoutMs,
    );
    if (!response || !Array.isArray(response.items)) {
      // Not an authoritative "nothing is allowed" — an empty list is `{items: []}`.
      throw new Error('list_allowed_operations returned no items array');
    }
    return response.items.filter(isWellFormed);
  }

  function reconcile(operations: readonly AllowedOperationWire[], trigger: GateToolRefreshTrigger) {
    const activeBefore = pi.getActiveTools();
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const owned = new Set(nameByKey.values());

    // Names someone else registered (pi built-ins, the mode's static capability tools, another
    // extension) are reserved: an Operation whose `<gate>.<op>` would sanitize onto one of them
    // takes gateToolName's gatekeeperId fallback instead of silently replacing that tool.
    const usedNames = new Set<string>(registered);
    for (const name of owned) usedNames.add(name);

    const desired = new Map<string, { op: AllowedOperationWire; label: string }>();
    for (const op of operations) {
      if (!options.include(op)) continue;
      const key = operationKey(op);
      const label = `${op.gateName}.${op.name}`;
      let name = nameByKey.get(key);
      if (name === undefined) {
        name = gateToolName(op, usedNames).name;
        nameByKey.set(key, name);
        owned.add(name);
      }
      if (!desired.has(name)) desired.set(name, { op, label });
    }

    const redefined: string[] = [];
    for (const [name, { op, label }] of [...desired]) {
      const fingerprint = JSON.stringify(op);
      if (registered.has(name) && fingerprintByName.get(name) === fingerprint) continue;
      try {
        pi.registerTool(options.buildTool(op, name, label));
      } catch (error) {
        // One bad Operation (e.g. a schema pi refuses) must not take the rest of the set down.
        desired.delete(name);
        console.error(
          `${prefix} result=skipped tool=${name} reason=register_failed message=${JSON.stringify(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
        continue;
      }
      if (registered.has(name)) redefined.push(name);
      fingerprintByName.set(name, fingerprint);
    }

    // Keep the live order (built-ins, static tools, still-allowed gate tools), drop owned names no
    // longer allowed, append newly allowed ones — append-only keeps the declared tool prefix stable.
    const liveActive = pi.getActiveTools();
    const next = liveActive.filter((name) => !owned.has(name) || desired.has(name));
    for (const name of desired.keys()) {
      if (!next.includes(name)) next.push(name);
    }
    if (!sameOrderedNames(next, liveActive)) pi.setActiveTools(next);

    const before = new Set(activeBefore);
    const added = [...desired.keys()].filter((name) => !before.has(name));
    const removed = activeBefore.filter((name) => owned.has(name) && !desired.has(name));
    if (added.length > 0 || removed.length > 0 || redefined.length > 0) {
      console.log(
        `${prefix} result=changed trigger=${trigger.reason} turn_id=${trigger.turnId ?? '-'} ` +
          `added=${formatNames(added)} removed=${formatNames(removed)} ` +
          `redefined=${formatNames(redefined)} gate_tools=${desired.size}`,
      );
    }
  }

  async function run(trigger: GateToolRefreshTrigger): Promise<void> {
    let operations: AllowedOperationWire[];
    try {
      operations = await readAllowedOperations();
    } catch (error) {
      const kind = error instanceof KernelError ? error.kind : 'invalid_response';
      const code = error instanceof KernelError && error.code ? ` code=${error.code}` : '';
      // Never interpolates the capability Handle — KernelError's message never carries it.
      console.error(
        `${prefix} result=kept_previous trigger=${trigger.reason} turn_id=${trigger.turnId ?? '-'} ` +
          `reason=${kind}${code} message=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
      return;
    }
    try {
      reconcile(operations, trigger);
    } catch (error) {
      // pi API failure mid-reconcile: log and let the turn proceed with whatever set is active.
      console.error(
        `${prefix} result=error trigger=${trigger.reason} turn_id=${trigger.turnId ?? '-'} ` +
          `message=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  return {
    refresh(trigger) {
      if (inFlight) return inFlight;
      const current = run(trigger).finally(() => {
        inFlight = undefined;
      });
      inFlight = current;
      return current;
    },
  };
}
