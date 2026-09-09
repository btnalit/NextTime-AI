import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS, getCapability } from '@nexttime/shared';
import { type KernelClient, KernelError } from '../kernel-client.js';
import { toToolParameters } from '../tool-schema.js';
import { type AllowedOperationWire, gateToolDescription, gateToolName } from './gate-tools.js';

/**
 * `interactive` mode (design doc §7.4 row "interactive | 你本机的 pi | 同 entry 或按 Handle | 同
 * entry | 默认不回传"; docs/development-tasks.md S3.6/W2-B): the pi extension registered for a
 * pi/Claude-Code-like client running *outside* the platform — a developer's own machine — holding
 * a Handle minted by the human-channel `issue_handle` capability (never a resident-container
 * Handle from `agent-host`).
 *
 * **Same tool set as `entry` mode, deliberately duplicated rather than imported.** This module
 * mirrors `modes/entry.ts`'s S1/S2 observe/find/propose capability list and its gate-observe-tool
 * projection (`session_start` → `list_allowed_operations` → `observe_operation`) verbatim — design
 * doc §7.4's own "同 entry" — but `entry.ts`'s tool list and helper functions are not exported
 * (`index.ts`'s public surface only re-exports `registerEntryMode`), and this task's own file
 * ownership is `modes/interactive.ts` (+ its test + the `index.ts` mode switch) only, not
 * `entry.ts` itself. Re-implementing the small, stable list here — rather than widening `entry.ts`'s
 * own exports to accommodate a second consumer — keeps this task's diff to files it actually owns;
 * `gate-tools.ts` (naming/sanitization) is already a shared module both modes import, so that part
 * is reused, not duplicated.
 *
 * **What "no resident-container assumptions" means in practice:** `entry.ts`'s own code never
 * touches the supervisor or egress proxy either (those are compose/infra concerns, not pi-
 * extension code) — the real difference is environmental: no `agent-host` RPC bridge sits in front
 * of this pi process feeding it `<!--nexttime:turn_id=...-->`-prefixed prompts
 * (`modes/entry.ts`'s own `TURN_ID_MARKER` mechanism, §7.2), so there is no platform Turn id to
 * correlate a run to, and therefore **no `report_turn` call, no `agent_start`/`agent_settled`
 * wiring, no `pi.appendEntry('nexttime_turn', ...)`** — this is the literal mechanism behind
 * "默认不回传" (the session-回传 column reads "默认不回传" for `interactive`, vs. "每轮回传 Turn 与
 * 决策" for `entry`): there is no Turn for a directly-connected interactive session to report
 * against in the first place (`report_turn`'s own handler resolves an existing Activity by
 * `turnId`; nothing here ever creates one via `send_chat_message`). `context` injection
 * (`get_entry_context`) is kept — it is purely per-Principal (pending approvals/tasks/facts,
 * `application/gateway/handlers.ts`'s `getEntryContextHandler` reads `currentPrincipalId`, never a
 * Turn or Chat), so it is exactly as meaningful for an interactive session as for the resident
 * entry agent.
 *
 * **Kernel transport: the HTTP capability route (`KernelClient`, `/api/cap/<name>`), not `/mcp`.**
 * `interactive` mode still runs *inside* pi's own extension mechanism, registering pi
 * `ToolDefinition`s exactly like `entry`/`worker` mode already do — each tool's `execute()` is a
 * single, already-known capability call with already-known params, the same shape `KernelClient`
 * exists for. Routing through `/mcp` here would mean this pi process acts as its own MCP client
 * calling into the kernel's MCP *gateway* only to unwrap the result back into a plain pi tool call
 * — a redundant protocol hop with no benefit, since nothing about MCP's own value (tool discovery
 * for an *external*, non-pi client, e.g. Claude Code talking to the kernel directly) applies when
 * the caller already *is* a pi extension. `/mcp` is for genuinely external MCP clients
 * (`docs/howto-connect-claude-code.md`); `interactive` mode is for a `pi`/Claude-Code-*like*
 * client that is itself the shared `platform-extension`, wired the same way `entry`/`worker` are.
 */

/** The same S1/S2 capability list `modes/entry.ts`'s own `ENTRY_TOOL_CAPABILITY_NAMES` registers
 *  (see this file's own module doc comment for why it is re-declared here rather than imported):
 *  the graph observe group, the S2 find/propose/invoke additions, `record_decision`. Deliberately
 *  excludes `get_entry_context`/`report_turn` (called internally on `context`/never called here at
 *  all, respectively — not pi tools in `entry.ts` either) and `observe_operation` (reached only
 *  through the projected `<gate>.<op>` tools below, same as `entry.ts`). */
const INTERACTIVE_TOOL_CAPABILITY_NAMES = [
  'get_object',
  'traverse',
  'search',
  'explain',
  'get_task',
  'state_at',
  'find_operations',
  'find_workers',
  'find_procedures',
  'invoke_worker',
  'request_connection',
  'record_decision',
  'propose_worker_definition',
  'propose_operation',
  'propose_skill',
  'propose_procedure',
  'propose_ontology_change',
] as const;

export interface InteractiveModeOptions {
  kernelClient: KernelClient;
}

function logKernelError(error: unknown, capabilityName: string): void {
  const message = error instanceof KernelError ? `${error.kind}: ${error.message}` : String(error);
  // Never interpolates the capability Handle — KernelError's message never carries it
  // (kernel-client.ts).
  console.error(`[nexttime:interactive] kernel call "${capabilityName}" failed: ${message}`);
}

/** Extra headroom (ms) layered on top of the kernel's own `invoke_worker(wait:true)` wait window —
 *  verbatim the same constant/reasoning `entry.ts`'s own `resolveInvokeWorkerCallPlan` uses (this
 *  file's own module doc comment on why it is re-declared rather than imported). */
const WAIT_TIMEOUT_HEADROOM_MS = 10_000;

interface InvokeWorkerCallPlan {
  readonly params: unknown;
  readonly timeoutMs?: number;
}

/** `invoke_worker`'s own `wait:true` window can exceed `KernelClient`'s flat default per-call
 *  timeout (`DEFAULT_KERNEL_CLIENT_TIMEOUT_MS`, 30s) — without this, a `wait:true` call would
 *  always abort client-side before the kernel's own wait could resolve. Verbatim the same rule
 *  `entry.ts`'s own `resolveInvokeWorkerCallPlan` implements (`wait` defaults to `false` when the
 *  caller omits it; an explicit `wait:true` gets a per-call timeout computed to always outlast the
 *  kernel's own wait). Every other capability's params pass through unmodified. */
function resolveInvokeWorkerCallPlan(
  capabilityName: string,
  params: unknown,
): InvokeWorkerCallPlan {
  if (capabilityName !== 'invoke_worker') return { params };
  const base = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  if (base.wait !== true) return { params: { ...base, wait: false } };

  const requestedTimeoutSeconds =
    typeof base.timeout === 'number' ? base.timeout : INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS;
  const clampedTimeoutSeconds = Math.min(
    requestedTimeoutSeconds,
    INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS,
  );
  return { params: base, timeoutMs: clampedTimeoutSeconds * 1000 + WAIT_TIMEOUT_HEADROOM_MS };
}

function buildCapabilityTool(
  name: (typeof INTERACTIVE_TOOL_CAPABILITY_NAMES)[number],
  kernelClient: KernelClient,
): ToolDefinition {
  const capability = getCapability(name);
  if (!capability) {
    throw new Error(
      `@nexttime/platform-extension: capability "${name}" is missing from the shared registry (interactive mode registers INTERACTIVE_TOOL_CAPABILITY_NAMES verbatim)`,
    );
  }
  return {
    name: capability.name,
    label: capability.name,
    description: capability.description,
    parameters: toToolParameters(capability.paramsSchema),
    // Deliberately does not catch KernelError — pi's agent loop treats a thrown execute() as the
    // tool result (isError:true), same convention entry.ts/worker.ts already rely on.
    async execute(_toolCallId, params) {
      const plan = resolveInvokeWorkerCallPlan(capability.name, params);
      const result = await kernelClient.call(
        capability.name,
        plan.params,
        undefined,
        plan.timeoutMs,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

/** An interactive session's projected observe tool — calls `observe_operation` directly (never
 *  `request_action`, which an `issue_handle`-minted Handle's entry-derived ceiling never holds
 *  either), verbatim the same as `entry.ts`'s own `buildGateObserveTool`. */
function buildGateObserveTool(
  op: AllowedOperationWire,
  kernelClient: KernelClient,
  usedNames: Set<string>,
): ToolDefinition {
  const { name, label } = gateToolName(op, usedNames);
  const paramsSchema = op.operation.params_schema ?? {};
  return {
    name,
    label,
    description: gateToolDescription(op, label),
    parameters: paramsSchema as ToolDefinition['parameters'],
    async execute(_toolCallId, params) {
      const result = await kernelClient.call<Record<string, unknown>>('observe_operation', {
        gatekeeperId: op.gatekeeperId,
        operation: op.name,
        params,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

/** Loose shape of a `get_entry_context` result (same defensive-read posture as `entry.ts`'s own
 *  `EntryContextResult` — an unexpected/missing field renders as an empty section, never throws). */
interface EntryContextResult {
  pendingApprovals?: unknown[];
  tasks?: unknown[];
  facts?: unknown[];
  precedents?: unknown[];
}

function renderSection(title: string, items: unknown[] | undefined): string | undefined {
  if (!items || items.length === 0) return undefined;
  return [`### ${title}`, ...items.map((item) => `- ${JSON.stringify(item)}`)].join('\n');
}

function renderEntryContext(context: EntryContextResult): string {
  const sections = [
    renderSection('Pending approvals', context.pendingApprovals),
    renderSection('Running tasks', context.tasks),
    renderSection('Relevant facts', context.facts),
    renderSection('Precedents', context.precedents),
  ].filter((section): section is string => section !== undefined);
  if (sections.length === 0) return '';
  return ['## NextTime interactive-session context', ...sections].join('\n\n');
}

export function registerInteractiveMode(pi: ExtensionAPI, options: InteractiveModeOptions): void {
  for (const name of INTERACTIVE_TOOL_CAPABILITY_NAMES) {
    pi.registerTool(buildCapabilityTool(name, options.kernelClient));
  }

  // Gate observe tools (§7.4 "同 entry"): one pi tool per published, observe-class Operation of
  // every Gatekeeper this Handle carries in `resources.gatekeeper` — identical mechanism to
  // `entry.ts`'s own `session_start` handler, reusing `gate-tools.ts`'s shared naming helpers.
  pi.on('session_start', async () => {
    const usedNames = new Set<string>();
    let operations: AllowedOperationWire[];
    try {
      const response = await options.kernelClient.call<{ items?: AllowedOperationWire[] }>(
        'list_allowed_operations',
        {},
      );
      operations = response.items ?? [];
    } catch (error) {
      logKernelError(error, 'list_allowed_operations');
      return;
    }
    for (const op of operations) {
      if (op.operation.mode !== 'observe') continue;
      pi.registerTool(buildGateObserveTool(op, options.kernelClient, usedNames));
    }
  });

  // context injection (§7.4 "同 entry") — no turn-id correlation, no report_turn: see this file's
  // own module doc comment for why interactive mode has neither.
  pi.on('context', async (event) => {
    let entryContext: EntryContextResult;
    try {
      entryContext = await options.kernelClient.call<EntryContextResult>('get_entry_context', {});
    } catch (error) {
      // context fires before every LLM call; a kernel outage must degrade to "no injected
      // context", never break the turn.
      logKernelError(error, 'get_entry_context');
      return undefined;
    }

    const text = renderEntryContext(entryContext);
    if (!text) return undefined;

    // Non-persisted per pi semantics (design doc §7.2): a `custom`-role message returned from
    // `context` is used for this LLM call only, never written back to the session file.
    const contextMessage: (typeof event.messages)[number] = {
      role: 'custom',
      customType: 'nexttime-interactive-context',
      content: text,
      display: false,
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, contextMessage] };
  });
}
