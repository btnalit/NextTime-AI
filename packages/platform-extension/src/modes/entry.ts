import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getCapability } from '@nexttime/shared';
import type { TSchema } from 'typebox';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { type KernelClient, KernelError } from '../kernel-client.js';

/**
 * `entry` mode (design doc §7.4, §7.2, S1 scope): the pi extension registered inside a user's
 * persistent entry container. S1 registers only the graph observe group of tools
 * (`find_workers`/`invoke_worker`/gate tools land in S2.7/S2.4); subscribes to pi's `context`
 * event to inject the entry-agent context bootstrap (`get_entry_context`); and subscribes to
 * `input`/`agent_start`/`agent_end` to correlate each pi agent run with a platform Turn and
 * report its outcome back to the kernel.
 */

/** The S1 graph observe group (design doc §9.3 "graph"), registered verbatim as pi tools. */
const OBSERVE_CAPABILITY_NAMES = [
  'get_object',
  'traverse',
  'search',
  'explain',
  'get_task',
] as const;

export interface EntryModeOptions {
  kernelClient: KernelClient;
  workspaceId: string;
  /** Seed value for the turn correlating the *next* `agent_start`, before any `input` event updates it. */
  initialTurnId?: string;
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

/** Converts a shared-registry capability's Zod paramsSchema into a pi tool parameter schema. pi's
 * `ToolDefinition.parameters` type (`TSchema`, from typebox) is used purely as a JSON-Schema-shaped
 * object at runtime (see PR body "假设" — pi never re-validates against typebox's `Kind` symbols;
 * it structurally clones/reads `.type`/`.properties`/`.required` when building the provider's tool
 * payload), so a plain `zod-to-json-schema` object cast to `TSchema` is sufficient and avoids
 * hand-duplicating the registry's Zod schemas as typebox schemas. */
function toToolParameters(paramsSchema: ZodTypeAny): TSchema {
  const jsonSchema = zodToJsonSchema(paramsSchema, { $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  jsonSchema.$schema = undefined;
  return jsonSchema as unknown as TSchema;
}

function buildObserveTool(
  name: (typeof OBSERVE_CAPABILITY_NAMES)[number],
  kernelClient: KernelClient,
): ToolDefinition {
  const capability = getCapability(name);
  if (!capability) {
    throw new Error(
      `@nexttime/platform-extension: capability "${name}" is missing from the shared registry (entry mode requires get_object/traverse/search/explain/get_task)`,
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
      const result = await kernelClient.call(capability.name, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
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

  for (const name of OBSERVE_CAPABILITY_NAMES) {
    pi.registerTool(buildObserveTool(name, options.kernelClient));
  }

  pi.on('input', (event) => {
    const match = TURN_ID_MARKER.exec(event.text);
    if (!match) return undefined;
    currentTurnId = match[1];
    return { action: 'transform' as const, text: event.text.slice(match[0].length) };
  });

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
