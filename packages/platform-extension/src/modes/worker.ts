import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { WorkerResultContractSchema } from '@nexttime/shared';
import type { WorkerResultCapabilityParams, WorkerResultContract } from '@nexttime/shared';
import { type KernelClient, KernelError } from '../kernel-client.js';
import { toToolParameters } from '../tool-schema.js';

/**
 * `worker` mode (design doc §7.3, §7.4, S2.9 scope): the pi extension registered inside a
 * one-shot Worker container. Unlike `entry` mode (RPC-driven — agent-host writes `prompt`
 * commands over stdio), a Worker has no driver attached to its stdin (`worker-supervisor`, S2.8,
 * only spawns the container and watches its exit status) — this mode drives its own single turn:
 * on `session_start`, it fetches the Handle's allowed Operations (`list_allowed_operations`) and
 * registers one pi tool per Operation, then calls `pi.sendUserMessage(...)` itself to kick the
 * turn off. `context` injects the Task's input, related Facts, and a Skills placeholder (S2.14).
 * When the turn settles (explicit `report_result` tool call, or none at all), the Worker posts its
 * result contract to the kernel (`report_task_result`) and exits the process — a Worker container
 * runs exactly one Task and then is done, there is no second prompt to wait for.
 */

// -------------------------------------------------------------------------------------------
// Gate tool registration (`list_allowed_operations` → one pi tool per Operation, `<gate>.<op>`).
// -------------------------------------------------------------------------------------------

interface AllowedOperationWire {
  readonly gatekeeperId: string;
  readonly gateName: string;
  readonly name: string;
  readonly operation: {
    readonly params_schema?: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
}

/** provider tool-name charset every major LLM API restricts function/tool names to
 *  (`^[a-zA-Z0-9_-]{1,64}$` — no dots) — verified against the vendored provider adapters in
 *  `@earendil-works/pi-coding-agent`'s own bundle (anthropic-messages/openai-completions/bedrock-
 *  converse all sanitize against this exact character class). §7.4's own `<gate>.<op>` naming is
 *  therefore a *display* convention, not a literal wire tool name — `<gate>.<op>` (unsanitized) is
 *  kept as each tool's `label`; the registered `name` below is the sanitized form, with a
 *  gatekeeperId-based fallback on collision (two Gatekeepers sharing a `gateName`). Documented
 *  deviation — see docs/development-tasks.md S2.9 "实现说明".
 */
function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function buildGateTool(
  op: AllowedOperationWire,
  kernelClient: KernelClient,
  usedNames: Set<string>,
): ToolDefinition {
  const label = `${op.gateName}.${op.name}`;
  let name = sanitizeToolName(label);
  if (usedNames.has(name)) {
    name = sanitizeToolName(`${op.gatekeeperId}.${op.name}`);
  }
  usedNames.add(name);

  const paramsSchema = op.operation.params_schema ?? {};

  return {
    name,
    label,
    description:
      typeof op.operation.description === 'string'
        ? op.operation.description
        : `Gatekeeper Operation "${label}" (§7.4/§9.3 gate projection).`,
    // An Operation's params_schema is already a JSON Schema object (imported from OpenAPI/MCP/
    // hand-written YAML, `@nexttime/shared`'s OperationSchema) — passed straight through, no
    // zod-to-json-schema conversion (see tool-schema.ts's own doc comment for why that helper is
    // reserved for report_result's Zod-schema-backed tool instead).
    parameters: paramsSchema as ToolDefinition['parameters'],
    // Both observe- and execute-class Operations call request_action uniformly (task brief: "the
    // kernel runs the gate's observe directly" for observe-class); the kernel resolves mode from
    // the published Operation itself (application/gateway/request-action-handler.ts), so this tool
    // never branches on op.operation.mode. Deliberately does not catch KernelError — a thrown
    // execute() becomes isError:true, same convention modes/entry.ts's observe tools use.
    async execute(_toolCallId, params) {
      const result = await kernelClient.call<Record<string, unknown>>('request_action', {
        gatekeeperId: op.gatekeeperId,
        operation: op.name,
        params,
      });

      if (result.status === 'pending_approval') {
        // S2.9 acceptance: "fake kernel 返回 pending_approval 时工具结果带 simulate 且循环不阻塞" —
        // returned (never thrown), so the agent loop is not blocked waiting on a human decision.
        const simulateText =
          result.simulate !== undefined
            ? JSON.stringify(result.simulate, null, 2)
            : '(no simulated effect reported)';
        const actionRequestId =
          typeof result.actionRequestId === 'string' ? result.actionRequestId : 'unknown';
        return {
          content: [
            {
              type: 'text',
              text: `${simulateText}\n\npending approval, actionRequestId ${actionRequestId}`,
            },
          ],
          details: result,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

// -------------------------------------------------------------------------------------------
// context injection: Task input, related Facts, Skills placeholder (S2.14).
// -------------------------------------------------------------------------------------------

interface WorkerTaskContext {
  readonly taskInput?: unknown;
  readonly facts: readonly unknown[];
}

function renderTaskInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === undefined || input === null) return '(no input)';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function toSearchQuery(input: unknown): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  return text.slice(0, 200);
}

function renderWorkerContext(ctx: WorkerTaskContext): string {
  const sections = [
    `### Task input\n${renderTaskInput(ctx.taskInput)}`,
    ctx.facts.length > 0
      ? `### Relevant facts\n${ctx.facts.map((fact) => `- ${JSON.stringify(fact)}`).join('\n')}`
      : undefined,
    // S2.14 seam (task brief: "the loaded Skills placeholder") — no Skill-mounting mechanism
    // exists yet; this line is deliberately static, not a kernel round trip.
    '### Skills\nNo Skills are loaded yet for this container (S2.14 will mount published Skills here).',
  ].filter((section): section is string => section !== undefined);
  return ['## NextTime worker context', ...sections].join('\n\n');
}

function logKernelError(error: unknown, capabilityName: string): void {
  const message = error instanceof KernelError ? `${error.kind}: ${error.message}` : String(error);
  // Never interpolates the capability Handle — KernelError's message never carries it.
  console.error(`[nexttime:worker] kernel call "${capabilityName}" failed: ${message}`);
}

// -------------------------------------------------------------------------------------------
// result contract posting.
// -------------------------------------------------------------------------------------------

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

function latestAssistantSummary(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (!message || message.role !== 'assistant') continue;
    const text = extractAssistantText(message.content);
    if (text) return text;
  }
  return '';
}

export interface WorkerModeOptions {
  readonly kernelClient: KernelClient;
  readonly workspaceId: string;
  readonly taskId: string;
}

const REPORT_RESULT_TOOL_NAME = 'report_result';

const KICKOFF_MESSAGE =
  'Begin working on your assigned Task now — see "Task input" under "## NextTime worker context" ' +
  'above for what you were asked to do.';

export function registerWorkerMode(pi: ExtensionAPI, options: WorkerModeOptions): void {
  let taskContext: WorkerTaskContext | undefined;
  let pendingResultContract: WorkerResultContract | undefined;
  let latestTurnSummary = '';
  let resultAlreadyPosted = false;

  // report_result is static (its schema does not depend on any kernel round trip) — registered
  // eagerly, unlike the gate tools below (session_start, after list_allowed_operations resolves).
  pi.registerTool({
    name: REPORT_RESULT_TOOL_NAME,
    label: REPORT_RESULT_TOOL_NAME,
    description:
      'Report this Task’s final result contract back to the platform ' +
      '({summary, findings?, factsToAssert?, evidence?, artifacts?, proposedSkill?, ' +
      'proposedOperations?}). Call this once, when you are done — the agent loop ends ' +
      'immediately after a valid call.',
    parameters: toToolParameters(WorkerResultContractSchema),
    async execute(_toolCallId, params) {
      const parsed = WorkerResultContractSchema.safeParse(params);
      if (!parsed.success) {
        // Thrown (not returned) so pi maps it to isError:true and the model can retry with
        // corrected params — never silently drops a malformed contract.
        throw new Error(
          `report_result: invalid contract — ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        );
      }
      pendingResultContract = parsed.data;
      return {
        content: [{ type: 'text', text: 'Result contract recorded.' }],
        details: parsed.data,
        // Stops the agent loop after this tool batch (structured-output.ts's own pattern) —
        // agent_settled below does the actual kernel POST + process exit.
        terminate: true,
      };
    },
  });

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    const usedNames = new Set<string>();
    try {
      const response = await options.kernelClient.call<{ operations: AllowedOperationWire[] }>(
        'list_allowed_operations',
        {},
      );
      for (const op of response.operations ?? []) {
        pi.registerTool(buildGateTool(op, options.kernelClient, usedNames));
      }
    } catch (error) {
      // A Worker with zero gate tools can still observe via context and report a result — degrade,
      // never crash the whole container over a transient kernel outage at startup.
      logKernelError(error, 'list_allowed_operations');
    }

    try {
      pi.sendUserMessage(KICKOFF_MESSAGE);
    } catch (error) {
      // Nothing else will ever drive this session's first turn (no RPC `prompt` driver, S2.8) — if
      // this fails, the container should not just hang until worker-supervisor's timeout.
      console.error(
        `[nexttime:worker] sendUserMessage failed at session_start: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (ctx.hasUI) ctx.ui.notify('nexttime: failed to start the Worker turn', 'error');
    }
  });

  pi.on('context', async (event) => {
    if (!taskContext) {
      try {
        const task = await options.kernelClient.call<{ input?: unknown }>('get_task', {
          taskId: options.taskId,
        });
        let facts: readonly unknown[] = [];
        try {
          const searchResult = await options.kernelClient.call<
            { objects?: unknown[] } | unknown[]
          >('search', { query: toSearchQuery(task.input) });
          facts = Array.isArray(searchResult) ? searchResult : (searchResult.objects ?? []);
        } catch (error) {
          logKernelError(error, 'search');
        }
        taskContext = { taskInput: task.input, facts };
      } catch (error) {
        // A failed get_task must degrade to "no injected context", never break the turn — and
        // must not be cached, so the next context call (if any) retries.
        logKernelError(error, 'get_task');
        return undefined;
      }
    }

    const text = renderWorkerContext(taskContext);
    const contextMessage: (typeof event.messages)[number] = {
      role: 'custom',
      customType: 'nexttime-worker-context',
      content: text,
      display: false,
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, contextMessage] };
  });

  pi.on('agent_end', (event) => {
    const summary = latestAssistantSummary(event.messages);
    if (summary) latestTurnSummary = summary;
  });

  pi.on('agent_settled', async (_event, ctx: ExtensionContext) => {
    if (resultAlreadyPosted) return;
    resultAlreadyPosted = true;

    const contract: WorkerResultContract = pendingResultContract ?? {
      summary: latestTurnSummary || '(the Worker finished with no report_result call and no final message)',
      findings: [],
      factsToAssert: [],
      evidence: [],
      artifacts: [],
    };

    const sessionJsonlPath = ctx.sessionManager?.getSessionFile?.();
    const payload: WorkerResultCapabilityParams = {
      ...contract,
      ...(sessionJsonlPath ? { sessionJsonlPath } : {}),
    };

    try {
      await options.kernelClient.call('report_task_result', payload);
      console.log('nexttime-worker check=report_task_result result=ok');
    } catch (error) {
      // Never let a failed report turn into a non-zero exit — that would trigger the S2.7
      // requeue-once path (a fresh WorkerRun re-running whatever this one already did, including
      // any already-committed gate actions). The reaper's own `failed: no_result` path already
      // handles "exited 0 but the Task was never completed" cleanly.
      logKernelError(error, 'report_task_result');
      console.log('nexttime-worker check=report_task_result result=fail');
    }

    // A Worker container runs exactly one Task, then exits — nothing else will ever drive a
    // second prompt over this session's (non-existent) stdin driver. setImmediate gives any
    // already-queued stdout writes (this session's own agent_settled RPC notification included) a
    // turn to flush before the process ends.
    setImmediate(() => process.exit(0));
  });
}
