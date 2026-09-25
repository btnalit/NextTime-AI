import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { WorkerResultContractSchema } from '@nexttime/shared';
import type { WorkerResultCapabilityParams, WorkerResultContract } from '@nexttime/shared';
import { type KernelClient, KernelError } from '../kernel-client.js';
import { gateToolParameters, toToolParameters } from '../tool-schema.js';
import {
  type AllowedOperationWire,
  gateToolDescription,
  gateToolName,
  truncateToolResult,
} from './gate-tools.js';

/**
 * `worker` mode (design doc §7.3, §7.4, S2.9 scope): the pi extension registered inside a
 * one-shot Worker container. Unlike `entry` mode (RPC-driven — agent-host writes `prompt`
 * commands over stdio), a Worker has no driver attached to its stdin (`worker-supervisor`, S2.8,
 * only spawns the container and watches its exit status) — this mode drives its own single turn:
 * on `session_start`, it fetches the Handle's allowed Operations (`list_allowed_operations`) and
 * registers one pi tool per Operation, then calls `pi.sendUserMessage(...)` itself to kick the
 * turn off. `context` injects the Task's input and related Facts — published Skills reach pi
 * through its own default skills directory (S2.14/S3.13 mount them straight there), not through
 * this injection. An explicit `report_result` tool call posts the result contract to the kernel
 * (`report_task_result`) *synchronously*, so the model sees the kernel's answer (leftover 42,
 * docs/STATUS.md §4 row 42 — see `REPORT_RESULT_TOOL_NAME`'s `execute` below); when the turn
 * settles, the Worker posts whatever is still unposted (a contract the kernel could not be
 * reached for, or a synthesized fallback when the model never called the tool) and exits the
 * process — a Worker container runs exactly one Task and then is done, there is no second prompt
 * to wait for.
 *
 * S8 W3-K1 (leftover 75 first half, docs/STATUS.md §4 row 75): every gate tool result this mode
 * returns to the model goes through `gate-tools.ts`'s `truncateToolResult` — a real inventory-scan
 * Worker's own raw output alone burned ~120k token (59% of one Task's budget) with no cap.
 */

// -------------------------------------------------------------------------------------------
// Gate tool registration (`list_allowed_operations` → one pi tool per Operation, `<gate>.<op>`).
// -------------------------------------------------------------------------------------------

/** Appended to every `pending_approval` gate-tool result — the point-of-use half of
 *  ontology/ops-runner.yaml's "结果以 ActionRequest 状态为准" contract (leftover 43, see the
 *  `pending_approval` branch in `buildGateTool` below for why). */
const PENDING_APPROVAL_GUIDANCE =
  'not executed yet (the simulated effect above is not the real one). If approved, the ' +
  'platform executes it later without you, and you have no tool that reads its final status. ' +
  'When you call report_result, cite this actionRequestId and state that its outcome is ' +
  'determined by the ActionRequest\u2019s status — never report it as failed or not done, and ' +
  'do not re-request it.';

// Naming/sanitization lives in gate-tools.ts (shared with entry mode since the S2.12 fix).
function buildGateTool(
  op: AllowedOperationWire,
  kernelClient: KernelClient,
  usedNames: Set<string>,
): ToolDefinition {
  const { name, label } = gateToolName(op, usedNames);

  return {
    name,
    label,
    description: gateToolDescription(op, label),
    // An Operation's params_schema is already a JSON Schema object (imported from OpenAPI/MCP/
    // hand-written YAML, `@nexttime/shared`'s OperationSchema) — no zod-to-json-schema
    // conversion, only the W7 object-schema normalization (tool-schema.ts `gateToolParameters`).
    parameters: gateToolParameters(op.operation.params_schema) as ToolDefinition['parameters'],
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
        // Leftover 43 (docs/STATUS.md §4 row 43): the sentence after the id is the point-of-use
        // half of ontology/ops-runner.yaml's "结果以 ActionRequest 状态为准" contract — a real-model
        // Worker that re-observed right after this and saw "unchanged" reported the action as not
        // executed while the approval landed seconds later. A Worker Handle has no tool to read an
        // ActionRequest's later status (`get_action` is human-only, operator role), so the only
        // truthful summary cites the id and defers to the ActionRequest.
        const simulateText = truncateToolResult(
          result.simulate !== undefined
            ? JSON.stringify(result.simulate, null, 2)
            : '(no simulated effect reported)',
        );
        const actionRequestId = typeof result.id === 'string' ? result.id : 'unknown';
        return {
          content: [
            {
              type: 'text',
              text: `${simulateText}\n\npending approval, actionRequestId ${actionRequestId} — ${PENDING_APPROVAL_GUIDANCE}`,
            },
          ],
          details: result,
        };
      }

      return {
        content: [{ type: 'text', text: truncateToolResult(JSON.stringify(result, null, 2)) }],
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

/** What `report_task_result` answers on success (`ReportTaskResultWireSchema`, packages/shared/
 *  src/wire/task.ts) — only the fields this mode reads back; the wire shape is strict but this
 *  side stays tolerant, the kernel is the authority. */
interface ReportTaskResultOutcome {
  readonly id?: string;
  readonly status?: string;
  readonly factIds?: readonly string[];
}

/** The per-entry refusals `application/task/result.ts` records in `tasks.result` (S5.6 #208 /
 *  #211: `factsRejected[]` / `proposedOperationsRejected[]` / `evidenceDropped[]`) — read back
 *  through `get_task` (a Worker-infrastructure capability every Worker Handle carries) because
 *  `report_task_result`'s own wire result does not carry them. Shapes are loose on purpose: an
 *  unexpected field never breaks the echo, it just is not rendered. */
interface StoredResultRejections {
  readonly factsRejected: readonly Record<string, unknown>[];
  readonly proposedOperationsRejected: readonly Record<string, unknown>[];
  readonly evidenceDropped: readonly number[];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
}

function extractStoredRejections(taskResult: unknown): StoredResultRejections | undefined {
  if (typeof taskResult !== 'object' || taskResult === null) return undefined;
  const record = taskResult as Record<string, unknown>;
  return {
    factsRejected: recordArray(record.factsRejected),
    proposedOperationsRejected: recordArray(record.proposedOperationsRejected),
    evidenceDropped: Array.isArray(record.evidenceDropped)
      ? record.evidenceDropped.filter((entry): entry is number => typeof entry === 'number')
      : [],
  };
}

/** One line per refused entry, in the contract's own index space so the model can match them
 *  to what it sent. `reason` is the kernel's own enum (`ResultFactRejectionReason` — the S5.1
 *  ontology guard's reasons, `meta_ontology_type` for I16, `object_not_found`;
 *  `gatekeeper_not_found` for proposals); `detail` is its free-text explanation when present. */
function renderRejections(rejections: StoredResultRejections): string[] {
  const lines: string[] = [];
  for (const fact of rejections.factsRejected) {
    const where = `factsToAssert[${String(fact.index)}]`;
    const linkType = typeof fact.linkType === 'string' ? ` (${fact.linkType})` : '';
    const detail = typeof fact.detail === 'string' ? ` — ${fact.detail}` : '';
    const expected = Array.isArray(fact.expected)
      ? ` — expected ${JSON.stringify(fact.expected)}`
      : '';
    lines.push(`- ${where}${linkType}: ${String(fact.reason)}${detail}${expected}`);
  }
  for (const proposal of rejections.proposedOperationsRejected) {
    const gatekeeperId =
      typeof proposal.gatekeeperId === 'string' ? ` (gatekeeperId ${proposal.gatekeeperId})` : '';
    lines.push(
      `- proposedOperations[${String(proposal.index)}]${gatekeeperId}: ${String(proposal.reason)}`,
    );
  }
  for (const index of rejections.evidenceDropped) {
    lines.push(`- evidence[${index}]: dropped (its factIndex points outside factsToAssert)`);
  }
  return lines;
}

function renderAccepted(
  contract: WorkerResultContract,
  outcome: ReportTaskResultOutcome,
  rejections: StoredResultRejections | undefined,
): string {
  const taskLabel = outcome.id ? `Task ${outcome.id}` : 'the Task';
  const status = outcome.status ? ` is ${outcome.status}` : ' accepted the result';
  const attempted = contract.factsToAssert?.length ?? 0;
  const written = outcome.factIds?.length;
  const factsLine =
    attempted > 0 && written !== undefined
      ? ` ${written} of ${attempted} factsToAssert written as Facts.`
      : '';
  const rejectionLines = rejections ? renderRejections(rejections) : [];
  const rejectionText =
    rejectionLines.length > 0
      ? `\n\nRefused by the platform (recorded on the Task, never written — the Task still completed):\n${rejectionLines.join('\n')}`
      : '';
  return `Result contract accepted — ${taskLabel}${status}.${factsLine}${rejectionText}`;
}

/** `invalid_params` (400) is the one kernel rejection class the model can fix by re-sending a
 *  corrected contract; `forbidden` (403 — the Handle's session is not this Task's WorkerRun) and
 *  `illegal_transition` (409 — the Task is not in a state that accepts a result) are not fixable
 *  from inside the Worker, and re-sending the same contract would only repeat them. */
function isFixableByTheModel(error: KernelError): boolean {
  return error.code === 'invalid_params';
}

/** How many fixable rejections `report_result` surfaces as a retryable (`isError`) tool result
 *  before it ends the turn regardless. pi only sets `isError` on a throw, and a throw cannot
 *  `terminate` the tool batch — so a Worker that keeps re-sending a rejected contract (a
 *  scripted fake-llm Worker literally replays its last step; a real model can ignore the hint)
 *  would otherwise spin against the kernel until its duration limit. Two corrections is what a
 *  fixable 400 realistically needs. */
const MAX_FIXABLE_REJECTIONS_SURFACED = 2;

/** The message a kernel `{ok:false}` on `report_task_result` becomes for the model. Never
 *  interpolates the Handle — `KernelError.message` never carries it. */
function describeKernelRejection(error: KernelError, willAcceptRetry: boolean): string {
  const code = error.code ?? error.kind;
  const head = `report_result: the platform rejected this result contract — ${code}: ${error.message}.`;
  if (willAcceptRetry) {
    return `${head} Correct the contract and call report_result again.`;
  }
  if (isFixableByTheModel(error)) {
    return `${head} Rejected ${MAX_FIXABLE_REJECTIONS_SURFACED + 1} times — ending this turn; the last contract is re-sent as-is when the turn ends.`;
  }
  return `${head} This cannot be fixed from inside this Worker — ending this turn (the contract is re-sent once as-is when the turn ends; the platform records the Task outcome).`;
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
  /** The last contract the model gave `report_result` — what `agent_settled` re-sends if no
   *  post has succeeded by then (the kernel was unreachable, or it rejected it and the model
   *  never sent a corrected one). */
  let pendingResultContract: WorkerResultContract | undefined;
  let latestTurnSummary = '';
  /** A `report_task_result` call succeeded (from the tool or from `agent_settled`) — the Task is
   *  complete, nothing may be posted again. Distinct from `settled` below on purpose (leftover
   *  42): the tool now sets this, and `agent_settled` must still run its exit exactly once. */
  let resultPosted = false;
  /** `agent_settled` has run (the process exit is scheduled) — guards a double fire. */
  let settled = false;
  /** Fixable kernel rejections already thrown back to the model — see
   *  `MAX_FIXABLE_REJECTIONS_SURFACED`. */
  let fixableRejectionsSurfaced = 0;

  async function postResultContract(
    contract: WorkerResultContract,
    sessionJsonlPath: string | undefined,
  ): Promise<ReportTaskResultOutcome> {
    const payload: WorkerResultCapabilityParams = {
      ...contract,
      ...(sessionJsonlPath ? { sessionJsonlPath } : {}),
    };
    const outcome = await options.kernelClient.call<ReportTaskResultOutcome>(
      'report_task_result',
      payload,
    );
    resultPosted = true;
    console.log('nexttime-worker check=report_task_result result=ok');
    return outcome ?? {};
  }

  /** Best-effort read-back of the per-entry refusals the kernel recorded for this Task (see
   *  `StoredResultRejections`) — only worth a round trip when the contract carried anything the
   *  kernel could refuse per entry; never throws (the post already succeeded, a failed echo must
   *  not turn into a tool error the model would answer by re-posting into a 409). */
  async function readStoredRejections(
    contract: WorkerResultContract,
  ): Promise<StoredResultRejections | undefined> {
    const refusable =
      (contract.factsToAssert?.length ?? 0) +
      (contract.proposedOperations?.length ?? 0) +
      (contract.evidence?.length ?? 0);
    if (refusable === 0) return undefined;
    try {
      const task = await options.kernelClient.call<{ result?: unknown }>('get_task', {
        taskId: options.taskId,
      });
      return extractStoredRejections(task?.result);
    } catch (error) {
      logKernelError(error, 'get_task');
      return undefined;
    }
  }

  // report_result is static (its schema does not depend on any kernel round trip) — registered
  // eagerly, unlike the gate tools below (session_start, after list_allowed_operations resolves).
  pi.registerTool({
    name: REPORT_RESULT_TOOL_NAME,
    label: REPORT_RESULT_TOOL_NAME,
    description:
      'Report this Task’s final result contract back to the platform ' +
      '({summary, findings?, factsToAssert?, evidence?, artifacts?, proposedSkill?, ' +
      'proposedOperations?}). Call this once, when you are done — the platform answers ' +
      'immediately (accepted, or why it was rejected) and the agent loop ends after an ' +
      'accepted call.',
    parameters: toToolParameters(WorkerResultContractSchema),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = WorkerResultContractSchema.safeParse(params);
      if (!parsed.success) {
        // Thrown (not returned) so pi maps it to isError:true and the model can retry with
        // corrected params — never silently drops a malformed contract.
        throw new Error(
          `report_result: invalid contract — ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        );
      }
      pendingResultContract = parsed.data;

      if (resultPosted) {
        // A second call after an accepted one: the Task is already complete and the kernel would
        // answer 409 — say so rather than re-posting.
        return {
          content: [
            {
              type: 'text',
              text: 'Result contract already accepted by the platform — nothing more to report.',
            },
          ],
          details: parsed.data,
          terminate: true,
        };
      }

      // Leftover 42 (docs/STATUS.md §4 row 42): post *now*, inside the tool call, so a kernel
      // rejection reaches the model as this tool's own error instead of a log line it can never
      // see. Before this, the tool answered "recorded" and the real POST only happened in
      // agent_settled below — the 2026-09-18 real-model rounds lost whole results to 400s the
      // Worker had already exited on. `sessionJsonlPath` comes from this call's own ctx, the same
      // `getSessionFile()` agent_settled reads.
      const sessionJsonlPath = ctx?.sessionManager?.getSessionFile?.();
      let outcome: ReportTaskResultOutcome;
      try {
        outcome = await postResultContract(parsed.data, sessionJsonlPath);
      } catch (error) {
        logKernelError(error, 'report_task_result');
        if (error instanceof KernelError && error.kind === 'capability_error') {
          // The kernel's own `{ok:false}`. This never changes the S2.7 property "a kernel 4xx
          // must not trigger a requeue": pi catches a tool's throw into the tool *result* (the
          // process keeps running), a returned result ends the loop normally, and agent_settled
          // below still exits 0 unconditionally — the only exit code worker-supervisor ever sees
          // from this path is 0.
          const willAcceptRetry =
            isFixableByTheModel(error) &&
            fixableRejectionsSurfaced < MAX_FIXABLE_REJECTIONS_SURFACED;
          if (willAcceptRetry) {
            // 400 invalid_params: thrown, so pi maps it to isError:true and the model reads the
            // code + message and re-sends a corrected contract.
            fixableRejectionsSurfaced += 1;
            throw new Error(describeKernelRejection(error, true));
          }
          // 403 forbidden / 409 illegal_transition / anything else, or a fixable rejection the
          // model has already been shown MAX_FIXABLE_REJECTIONS_SURFACED times: nothing further
          // the model can do, so the turn ends here with the kernel's answer in the tool result
          // (see MAX_FIXABLE_REJECTIONS_SURFACED for why this is a return, not a throw).
          // agent_settled re-sends the pending contract once and exits 0.
          return {
            content: [{ type: 'text', text: describeKernelRejection(error, false) }],
            details: { rejected: { code: error.code, message: error.message } },
            terminate: true,
          };
        }
        // network / timeout / malformed response: nothing the model can act on. Keep the contract
        // recorded and let agent_settled re-send it once the turn ends (the pre-leftover-42
        // behaviour, now only for this class).
        return {
          content: [
            {
              type: 'text',
              text: 'Result contract recorded; the platform could not be reached right now — it will be re-sent when this turn ends.',
            },
          ],
          details: parsed.data,
          terminate: true,
        };
      }

      const rejections = await readStoredRejections(parsed.data);
      return {
        content: [{ type: 'text', text: renderAccepted(parsed.data, outcome, rejections) }],
        details: { ...outcome, ...(rejections ?? {}) },
        // Stops the agent loop after this tool batch (structured-output.ts's own pattern) —
        // agent_settled below only exits the process now that the POST already happened here.
        terminate: true,
      };
    },
  });

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    const usedNames = new Set<string>();
    try {
      const response = await options.kernelClient.call<{ items: AllowedOperationWire[] }>(
        'list_allowed_operations',
        {},
      );
      for (const op of response.items ?? []) {
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
          // S3.7 wire fix (docs/wire-contract-conventions.md §3): `search` now returns
          // `{items}`, same envelope every list-shaped capability uses (was a bare array).
          const searchResult = await options.kernelClient.call<{ items?: unknown[] }>('search', {
            query: toSearchQuery(task.input),
          });
          facts = searchResult.items ?? [];
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
    if (settled) return;
    settled = true;

    // Fallback post — only when nothing has been accepted yet: the model never called
    // report_result (synthesized contract from its final message), the kernel could not be
    // reached from the tool, or the kernel rejected the tool's contract and the model ended its
    // turn without a corrected one (re-sent as-is: a transient cause may have cleared; a
    // repeated rejection is logged and the reaper's `no_result` path handles the Task).
    if (!resultPosted) {
      const contract: WorkerResultContract = pendingResultContract ?? {
        summary:
          latestTurnSummary ||
          '(the Worker finished with no report_result call and no final message)',
        findings: [],
        factsToAssert: [],
        evidence: [],
        artifacts: [],
      };
      try {
        await postResultContract(contract, ctx.sessionManager?.getSessionFile?.());
      } catch (error) {
        // Never let a failed report turn into a non-zero exit — that would trigger the S2.7
        // requeue-once path (a fresh WorkerRun re-running whatever this one already did,
        // including any already-committed gate actions). The reaper's own `failed: no_result`
        // path already handles "exited 0 but the Task was never completed" cleanly.
        logKernelError(error, 'report_task_result');
        console.log('nexttime-worker check=report_task_result result=fail');
      }
    }

    // A Worker container runs exactly one Task, then exits — nothing else will ever drive a
    // second prompt over this session's (non-existent) stdin driver. setImmediate gives any
    // already-queued stdout writes (this session's own agent_settled RPC notification included) a
    // turn to flush before the process ends. Always reached, whichever path posted the result —
    // an accepted post from the tool must not leave the container waiting for a timeout.
    setImmediate(() => process.exit(0));
  });
}
