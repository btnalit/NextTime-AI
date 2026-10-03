import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS,
  INVOKE_WORKER_SPAWN_BUDGET_SECONDS,
  getCapability,
} from '@nexttime/shared';
import { type KernelClient, KernelError } from '../kernel-client.js';
import { gateToolParameters, toToolParameters } from '../tool-schema.js';
import { createGateToolProjector } from './gate-tool-projection.js';
import {
  type AllowedOperationWire,
  gateToolDescription,
  truncateToolResult,
} from './gate-tools.js';

/** An entry agent's projected observe tool — calls `observe_operation` (never `request_action`,
 *  which an entry Handle does not hold) and returns the observed data verbatim (truncated — S8
 *  W3-K1, leftover 75 first half, `gate-tools.ts`'s own `truncateToolResult` doc comment). The
 *  `name`/`label` come from the projector (`gate-tool-projection.ts`), which keeps them stable for
 *  the session (same `gateToolName` naming as worker mode). */
function buildGateObserveTool(
  op: AllowedOperationWire,
  name: string,
  label: string,
  kernelClient: KernelClient,
): ToolDefinition {
  return {
    name,
    label,
    description: gateToolDescription(op, label),
    // W7: normalized to an object schema — see tool-schema.ts `gateToolParameters`.
    parameters: gateToolParameters(op.operation.params_schema) as ToolDefinition['parameters'],
    async execute(_toolCallId, params) {
      const result = await kernelClient.call<Record<string, unknown>>('observe_operation', {
        gatekeeperId: op.gatekeeperId,
        operation: op.name,
        params,
      });
      return {
        content: [{ type: 'text', text: truncateToolResult(JSON.stringify(result, null, 2)) }],
        details: result,
      };
    },
  };
}

/**
 * `entry` mode (design doc §7.4, §7.2, S1 scope): the pi extension registered inside a user's
 * persistent entry container. S1 registers only the graph observe group of tools
 * (`find_workers`/`invoke_worker`/gate tools land in S2.7/S2.4); subscribes to pi's `context`
 * event to inject the entry-agent context bootstrap (`get_entry_context`); and subscribes to
 * `input`/`agent_start`/`agent_end` to correlate each pi agent run with a platform Turn and
 * report its outcome back to the kernel.
 */

/** The S1 graph observe group (design doc §9.3 "graph"), registered verbatim as pi tools. */
const ENTRY_TOOL_CAPABILITY_NAMES = [
  // S1 observe group (unchanged order — entry.test.ts pins it).
  'get_object',
  'traverse',
  'search',
  'explain',
  'get_task',
  // S2 (S2.12 fix): the rest of ontology/entry-agent.yaml's `capabilities`, minus the two the
  // extension calls itself (`get_entry_context` on `context`, `report_turn` on `agent_settled`)
  // and `observe_operation`, which is reached through the projected `<gate>.<op>` tools (projected
  // on `session_start` and refreshed every turn below) rather than exposed raw. Every name must be on
  // governance/capability/handles.ts's entry ceiling — a Handle-scope 403 on a registered tool
  // is a bug on that side, not something to hide here.
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

export interface EntryModeOptions {
  kernelClient: KernelClient;
  workspaceId: string;
  /** Seed value for the turn correlating the *next* `agent_start`, before any `input` event updates it. */
  initialTurnId?: string;
  /** Per-refresh budget for the gate tool projection's `list_allowed_operations` read
   *  (`GATE_TOOL_REFRESH_TIMEOUT_MS` by default; overridden in tests). */
  toolRefreshTimeoutMs?: number;
}

/**
 * Documented mechanism for delivering `NEXTTIME_TURN_ID` per prompt (index.ts's env var is only a
 * fallback for the very first turn): agent-host prefixes each RPC `prompt` message with this
 * marker as its first line. The `input` event strips it before the model ever sees it and updates
 * the turn id used by the next `agent_start`/`agent_end` pair. See PR body "假设" — the RPC
 * `prompt` command (docs/rpc.md) has no free-form metadata field, so the message text itself is
 * the only per-prompt channel available without changing pi.
 */
const TURN_ID_MARKER = /^<!--nexttime:turn_id=([A-Za-z0-9_-]+)-->\n?/;

function buildCapabilityTool(
  name: (typeof ENTRY_TOOL_CAPABILITY_NAMES)[number],
  kernelClient: KernelClient,
): ToolDefinition {
  const capability = getCapability(name);
  if (!capability) {
    throw new Error(
      `@nexttime/platform-extension: capability "${name}" is missing from the shared registry (entry mode registers ENTRY_TOOL_CAPABILITY_NAMES verbatim)`,
    );
  }
  return {
    name: capability.name,
    label: capability.name,
    description: capability.description,
    parameters: toToolParameters(capability.paramsSchema),
    // Deliberately does not catch KernelError: pi's agent loop treats a thrown execute() as the
    // tool result, marking isError=true with the error message as content — exactly the "errors
    // as isError" contract this tool needs, with no isError field to set by hand (AgentToolResult
    // has none; see kernel-client.ts and the S1.6 PR body "假设").
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

/** Extra headroom (ms) layered on top of the kernel's own spawn budget and wait window (see
 *  `resolveInvokeWorkerCallPlan` below) for this client's per-call HTTP timeout on an
 *  invoke_worker call — enough slack for the kernel's own database work and response
 *  transit/serialization, without making the client wait meaningfully longer than the kernel
 *  already promises to. */
const WAIT_TIMEOUT_HEADROOM_MS = 10_000;

interface InvokeWorkerCallPlan {
  readonly params: unknown;
  /** `KernelClient.call`'s per-call timeout override — set on every invoke_worker call so it
   *  outlasts the kernel's phase 1 plus its `wait:true` window; `undefined` otherwise (the
   *  client's own constructor default applies, same as every other capability). */
  readonly timeoutMs?: number;
}

/**
 * Lane-6 review P2-4 (fixed on both sides now — supersedes this function's own earlier "always
 * force wait:false" shape, see PR body): `invoke_worker`'s own `wait` param (`@nexttime/shared`'s
 * `capabilities.ts`) asks the kernel to hold the request open until the invoked Worker settles, up
 * to `params.timeout ?? 90` seconds (`INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS`, design doc §8.2
 * "默认 90 秒"). This `KernelClient`'s *default* per-call HTTP timeout is a flat 30s
 * (`DEFAULT_KERNEL_CLIENT_TIMEOUT_MS`, kernel-client.ts) — shorter than the kernel's own wait
 * window — so an unmodified `wait:true` call would always abort client-side before the kernel's
 * wait could ever resolve, and pi's own retry-on-tool-error behavior would then re-issue a
 * *second* `invoke_worker` for a Task that may already be running (duplicate invokes).
 *
 * Entry mode still *defaults* `wait` to `false` (chat is asynchronous — a Task card plus a
 * follow-up turn is the right UX for a blocking tool call, not blocking the whole turn on it; a
 * caller that wants completion status polls `get_task`), but an agent that explicitly asks for
 * `wait:true` now gets it, honoured with a per-call `KernelClient` timeout override
 * (`kernel-client.ts`'s `call()`) computed to always outlast the kernel's own wait — rather than
 * being silently downgraded to `wait:false`. Every other capability's params pass through
 * unmodified, no timeout override.
 *
 * 2026-10-02 review R-54: the override also counts the kernel's phase 1 — creating the Task and
 * waiting up to `INVOKE_WORKER_SPAWN_BUDGET_SECONDS` (30s) for worker-supervisor to start the
 * Worker — and applies to `wait:false` too: `30s + (wait ? min(params.timeout ?? 90, 90) : 0) +
 * 10s`. Before, a `wait:false` call used the flat 30s default and a `wait:true` call only the wait
 * window, so a slow spawn made the client give up while the kernel was still starting the Worker,
 * and the model's retry started a second one. (A retry that does happen now collapses onto the
 * running Task — the kernel's derived `idempotencyKey`, `capabilities.ts`.)
 */
function resolveInvokeWorkerCallPlan(
  capabilityName: string,
  params: unknown,
): InvokeWorkerCallPlan {
  if (capabilityName !== 'invoke_worker') return { params };
  const base = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const spawnBudgetMs = INVOKE_WORKER_SPAWN_BUDGET_SECONDS * 1000;
  if (base.wait !== true) {
    return {
      params: { ...base, wait: false },
      timeoutMs: spawnBudgetMs + WAIT_TIMEOUT_HEADROOM_MS,
    };
  }

  const requestedTimeoutSeconds =
    typeof base.timeout === 'number' ? base.timeout : INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS;
  const clampedTimeoutSeconds = Math.min(
    requestedTimeoutSeconds,
    INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS,
  );
  return {
    params: base,
    timeoutMs: spawnBudgetMs + clampedTimeoutSeconds * 1000 + WAIT_TIMEOUT_HEADROOM_MS,
  };
}

/** Loose shape of a `get_entry_context` result (§7.4 `context` column, S1 scope). The kernel side
 * (S1.3) is not built yet, so this is read defensively — an unexpected/missing field renders as an
 * empty section rather than throwing. */
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
  return ['## NextTime entry context', ...sections].join('\n\n');
}

function isInvalidParams(error: unknown): boolean {
  return (
    error instanceof KernelError &&
    error.kind === 'capability_error' &&
    error.code === 'invalid_params'
  );
}

function logKernelError(error: unknown, capabilityName: string): void {
  const message = error instanceof KernelError ? `${error.kind}: ${error.message}` : String(error);
  // Never interpolates the capability Handle — KernelError's message never carries it (kernel-client.ts).
  console.error(`[nexttime:entry] kernel call "${capabilityName}" failed: ${message}`);
}

/** Extracts the last assistant message's text, for the `report_turn` summary. Loosely typed on
 * purpose (see module doc): only `role`/`content` are read, so any AgentMessage shape works. */
function summarizeAgentEndMessages(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (!message || message.role !== 'assistant') continue;
    const text = extractAssistantText(message.content);
    if (text) return text;
  }
  return '';
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => {
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string';
    })
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function registerEntryMode(pi: ExtensionAPI, options: EntryModeOptions): void {
  let currentTurnId = options.initialTurnId;
  // Leftover 87: the entry agent's correlation id is its current Turn id — the id the kernel,
  // agent-host and worker-supervisor already know this Turn by — so every kernel call made while
  // serving a Turn (tools, `get_entry_context`, `report_turn`, `invoke_worker`) carries it, and a
  // Worker it delegates to inherits it. Reused, not invented (see @nexttime/shared correlation.ts).
  options.kernelClient.setCorrelationId(currentTurnId);

  for (const name of ENTRY_TOOL_CAPABILITY_NAMES) {
    pi.registerTool(buildCapabilityTool(name, options.kernelClient));
  }

  // Gate observe tools (S2.12 fix; design doc §7.4 "<gate>.<op>"): one pi tool per *published,
  // observe-class* Operation `list_allowed_operations` returns — every gate enabled in this
  // workspace that this user has not excluded (no Grant needed since design doc §11 "门上的观察",
  // D4 revoked 2026-09-27; the kernel applies the same predicate `observe_operation` enforces). Same
  // naming as worker mode (gate-tools.ts) so tool names are predictable from `<gateName>.<op>`;
  // execute-class Operations are never projected here — an entry agent delegates those through
  // `invoke_worker`.
  //
  // 收尾波次 C3 (per-turn projection): projected on `session_start` and refreshed at every turn
  // start (`before_agent_start`, one `list_allowed_operations` read with a short timeout), so a gate
  // enabled / an Operation published or deprecated after this container started shows up — or
  // disappears — on the next user message, without a restart. A failed or slow read keeps the
  // previous set. pi's built-ins and the static capability tools above are never touched. Changes
  // that rotate the entry Handle (Grant, AgentProfile / AgentPolicy, connector deny list) still
  // recreate the container on the next Turn (worker-supervisor jti rotation) — that is authority
  // delivery, not projection, and is unchanged here.
  const gateTools = createGateToolProjector(pi, {
    kernelClient: options.kernelClient,
    component: 'entry',
    include: (op) => op.operation.mode === 'observe',
    buildTool: (op, name, label) => buildGateObserveTool(op, name, label, options.kernelClient),
    timeoutMs: options.toolRefreshTimeoutMs,
  });

  pi.on('session_start', async () => {
    await gateTools.refresh({ reason: 'session_start', turnId: currentTurnId });
  });

  pi.on('input', (event) => {
    const match = TURN_ID_MARKER.exec(event.text);
    if (!match) return undefined;
    currentTurnId = match[1];
    options.kernelClient.setCorrelationId(currentTurnId);
    return { action: 'transform' as const, text: event.text.slice(match[0].length) };
  });

  // Runs after `input` (so `currentTurnId` is this prompt's Turn) and before pi builds the run's
  // first request — pi then takes the live loadout set here for the tool declarations it sends.
  // Once per prompt, not per LLM call: a queued follow-up / steer joins the running loop without
  // a new `before_agent_start`, and so keeps the set this run started with.
  pi.on('before_agent_start', async () => {
    await gateTools.refresh({ reason: 'turn', turnId: currentTurnId });
    return undefined;
  });

  // 2026-10-02 review R-57 (decision D-23): every call names the Turn it serves. The kernel returns
  // that Turn's chat's items on every LLM call of the Turn — a second call, a provider-error retry
  // — and drops them only once `report_turn` (agent_settled below) acknowledges the Turn. Without
  // a known Turn the call sends `{}` (the kernel then attributes it to the running Turn itself).
  // A kernel from before `turnId` existed (a rolled-back kernel with this runtime image still
  // active) rejects the param as `invalid_params`; this process then falls back to `{}`, the only
  // form that kernel accepts, for the rest of its life.
  let sendTurnIdToEntryContext = true;
  pi.on('context', async (event) => {
    let entryContext: EntryContextResult;
    try {
      const turnParams =
        sendTurnIdToEntryContext && currentTurnId ? { turnId: currentTurnId } : undefined;
      try {
        entryContext = await options.kernelClient.call<EntryContextResult>(
          'get_entry_context',
          turnParams ?? {},
        );
      } catch (error) {
        if (!turnParams || !isInvalidParams(error)) throw error;
        sendTurnIdToEntryContext = false;
        entryContext = await options.kernelClient.call<EntryContextResult>('get_entry_context', {});
      }
    } catch (error) {
      // context fires before every LLM call; a kernel outage must degrade to "no injected
      // context", never break the turn.
      logKernelError(error, 'get_entry_context');
      return undefined;
    }

    const text = renderEntryContext(entryContext);
    if (!text) return undefined;

    // Non-persisted per pi semantics (design doc §7.2): a `custom`-role message returned from
    // `context` is used for this LLM call only, never written back to the session file — which is
    // why the kernel keeps returning the same items for the Turn until it is reported (above).
    const contextMessage: (typeof event.messages)[number] = {
      role: 'custom',
      customType: 'nexttime-entry-context',
      content: text,
      display: false,
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, contextMessage] };
  });

  // §7.2 "扩展每轮把 turn_id 写入会话条目": one platform Turn = one pi agent run
  // (agent_start ... agent_settled), not pi's internal turn_start/turn_end (which can repeat
  // within one run across a tool-calling loop) — see PR body "假设".
  pi.on('agent_start', () => {
    pi.appendEntry('nexttime_turn', { turnId: currentTurnId, workspaceId: options.workspaceId });
  });

  // agent_end can fire more than once per platform Turn (auto-retry, auto-compaction retry, and
  // queued follow-ups each start a new low-level run before the session settles — docs/rpc.md
  // "agent_end"/"agent_settled"), so this handler only *records* the latest summary; report_turn
  // itself fires from agent_settled, exactly once per Turn (see PR body "假设": the task brief's
  // "at agent end" is the concept — report once the run has actually finished, not on every
  // retry).
  let latestTurnSummary = '';
  pi.on('agent_end', (event) => {
    const summary = summarizeAgentEndMessages(event.messages);
    if (summary) latestTurnSummary = summary;
  });

  pi.on('agent_settled', async (_event, ctx: ExtensionContext) => {
    const turnId = currentTurnId;
    if (!turnId) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          'nexttime: agent_settled with no known turn_id; report_turn skipped',
          'warning',
        );
      }
      return;
    }
    try {
      // `decisions` is omitted: S1 doesn't register `record_decision` as an entry tool (S2
      // scope), so there is nothing yet to correlate a Turn to.
      await options.kernelClient.call('report_turn', { turnId, summary: latestTurnSummary });
    } catch (error) {
      logKernelError(error, 'report_turn');
    }
  });
}
