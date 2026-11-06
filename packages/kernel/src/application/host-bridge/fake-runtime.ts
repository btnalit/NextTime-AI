import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeEventFields,
  AgentRuntimeEventSink,
  StartTurnInput,
  TurnEndStatus,
} from './agent-runtime.js';

/**
 * application/host-bridge/fake-runtime: `FakeAgentRuntime` (docs/development-tasks.md S1.4
 * deliverable 5) — the `AgentRuntime` implementation `index.ts`'s `main()` wires when
 * `AGENT_RUNTIME=fake` (the default until S1.5 lands the real one over agent-host). Streams a
 * canned reply that echoes the prompt back, chunked into `textDelta` events, then emits one
 * persisted assistant `message` and ends the Turn — enough for `application/chat` and
 * `interfaces/ws` to be exercised end-to-end with no real pi/agent-host in the loop.
 */

/**
 * STATUS leftover 83 (CI `invoke_worker` path): a prompt containing this exact substring, when
 * `FakeAgentRuntimeOptions.onDelegate` is wired, makes `run()` call that hook instead of echoing —
 * see `onDelegate`'s own doc comment. A plain substring check, not a regex, and deliberately ugly
 * enough that no real user prompt would ever contain it by accident. Exported so the composition
 * root (`packages/kernel/src/fake-invoke-worker.ts`, CI-only) and e2e specs share the exact same
 * literal.
 */
export const FAKE_DELEGATE_MARKER = '__nexttime_fake_delegate__';

/**
 * S11 AA4d (AA4 plan F9, CI only): a prompt containing this exact substring, in an **admin agent**
 * Turn (`input.agentKind === 'admin_agent'`) and when `FakeAgentRuntimeOptions.onAdminPropose` is
 * wired, makes `run()` call that hook instead of echoing — a scripted "the admin agent decided to
 * call propose_admin_proposal" Turn. The same guard as {@link FAKE_DELEGATE_MARKER}: only this fake
 * runtime reads it. An entry Turn carrying it is echoed like any other prompt, and the real runtime
 * (agent-host, pi) has no code that looks for it — `fake-runtime.test.ts` and the platform
 * extension's own guard test say so. Exported so the composition root
 * (`packages/kernel/src/fake-admin-propose.ts`, CI-only) and the e2e journey share the literal.
 */
export const FAKE_ADMIN_PROPOSE_MARKER = '__nexttime_fake_admin_propose__';

/**
 * S11 AA5g (CI only): the same as {@link FAKE_ADMIN_PROPOSE_MARKER} for
 * `FakeAgentRuntimeOptions.onAdminProposePack` — a scripted "the admin agent called
 * propose_pack_install" Turn. Not a substring of the other marker, nor it of this one: a prompt
 * carries one or the other.
 */
export const FAKE_ADMIN_PROPOSE_PACK_MARKER = '__nexttime_fake_admin_pack__';

/** What `onAdminPropose` resolves with: the proposal as the admin agent reads it back, reduced to
 *  what the scripted reply names. */
export interface FakeAdminProposeOutcome {
  readonly proposalId: string;
  readonly title: string;
  readonly status: string;
}

/** What `onDelegate` resolves with — structurally the shape of `application/task`'s own
 *  `InvokeWorkerResult` (`status` widened to plain `string`, `result`/`failureReason` kept
 *  optional) without this file importing anything from `application/task` at all (host-bridge
 *  must never import that module — `.dependency-cruiser.cjs`
 *  `chat-and-host-bridge-must-not-import-approval-or-task`). The composition root's own
 *  `onDelegate` implementation returns its real `InvokeWorkerResult` directly; TypeScript's
 *  structural typing accepts it here with no cast. */
export interface FakeDelegateOutcome {
  readonly taskId: string;
  readonly workerRunId: string;
  readonly status: string;
  readonly result?: unknown;
  readonly failureReason?: string | null;
}

export interface FakeAgentRuntimeOptions {
  readonly sink: AgentRuntimeEventSink;
  /** Delay, in milliseconds, before each emitted event (including the first). `0` (default) emits
   *  every event on its own microtask tick — fast enough for unit/integration tests that don't
   *  care about timing, but still asynchronous (never emits synchronously inside `startTurn`
   *  itself), matching the real runtime's async-by-construction contract. */
  readonly chunkDelayMs?: number;
  /** Approximate chunk size (characters) `textDelta` splits the echoed reply into. Default 8. */
  readonly chunkSize?: number;
  /** Called once per Turn, after the echoed reply would normally be emitted, to decide whether
   *  this Turn ends `completed` or `failed` — e.g. a test that wants to exercise the `failed`
   *  path without wiring a whole different runtime. Defaults to always `completed`. */
  readonly shouldFail?: (input: StartTurnInput) => boolean;
  /**
   * STATUS leftover 83 (CI `invoke_worker` path): when set, and `input.prompt` contains
   * {@link FAKE_DELEGATE_MARKER}, `run()` calls this instead of echoing — a scripted "the entry
   * agent decided to call invoke_worker" turn. Emits a `toolCallStarted`/`toolCallEnded` pair
   * naming `invoke_worker` around the call, then one assistant `message` reporting the outcome
   * (or the error), then ends the Turn `completed` (or `failed` if the hook rejects) — never both
   * the scripted delegate and the plain echo for the same Turn. `undefined` (the default, and
   * always true in production — `AGENT_RUNTIME` defaults to `agent-host` there, and this option
   * is additionally its own opt-in even under `fake`) keeps every prompt, marker or not, on the
   * plain echo path exactly as before this option existed. Wired only by
   * `packages/kernel/src/fake-invoke-worker.ts` (CI-only glue, see that file's own doc comment) —
   * this module itself never imports `application/task`, matching every other `AgentRuntime`
   * implementation's own layering.
   */
  readonly onDelegate?: (input: StartTurnInput) => Promise<FakeDelegateOutcome>;
  /**
   * S11 AA4d (AA4 plan F9): when set, an admin agent Turn whose prompt contains
   * {@link FAKE_ADMIN_PROPOSE_MARKER} calls this instead of echoing — a scripted "the admin agent
   * called propose_admin_proposal" Turn, with the same `toolCallStarted`/`toolCallEnded` pair, one
   * assistant `message` and one `turnEnded` as `onDelegate`. Only an admin agent Turn reaches it;
   * an entry Turn with the marker is echoed. `undefined` (the default, and always in production)
   * keeps every prompt on the echo path. Wired only by `packages/kernel/src/fake-admin-propose.ts`
   * (CI-only glue) under the same `FAKE_INVOKE_WORKER=1` gate as `onDelegate`.
   */
  readonly onAdminPropose?: (input: StartTurnInput) => Promise<FakeAdminProposeOutcome>;
  /**
   * S11 AA5g: {@link onAdminPropose}'s twin for {@link FAKE_ADMIN_PROPOSE_PACK_MARKER} — a scripted
   * "the admin agent called propose_pack_install" Turn, the same events. Wired only by
   * `packages/kernel/src/fake-admin-propose.ts` under the same gate.
   */
  readonly onAdminProposePack?: (input: StartTurnInput) => Promise<FakeAdminProposeOutcome>;
}

const DEFAULT_CHUNK_SIZE = 8;

function chunkText(text: string, size: number): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeAgentRuntime implements AgentRuntime {
  private readonly sink: AgentRuntimeEventSink;
  private readonly chunkDelayMs: number;
  private readonly chunkSize: number;
  private readonly shouldFail: (input: StartTurnInput) => boolean;
  private readonly onDelegate?: (input: StartTurnInput) => Promise<FakeDelegateOutcome>;
  private readonly onAdminPropose?: (input: StartTurnInput) => Promise<FakeAdminProposeOutcome>;
  private readonly onAdminProposePack?: (input: StartTurnInput) => Promise<FakeAdminProposeOutcome>;
  /** turnId -> stop requested. Checked between emitted chunks so a `stopTurn` mid-stream ends the
   *  Turn with `status: 'interrupted'` instead of running to completion. */
  private readonly stopRequested = new Set<string>();
  /** turnId -> currently running (lane-4 P1/P2 fix: `stopTurn`'s `AgentRuntime` port contract
   *  needs to report whether *this* runtime has any record of `turnId` — see agent-runtime.ts's
   *  own doc comment). Populated at the start of `run()`, cleared once `endTurn()` emits the
   *  terminal `turnEnded`. */
  private readonly runningTurnIds = new Set<string>();

  constructor(options: FakeAgentRuntimeOptions) {
    this.sink = options.sink;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.shouldFail = options.shouldFail ?? (() => false);
    this.onDelegate = options.onDelegate;
    this.onAdminPropose = options.onAdminPropose;
    this.onAdminProposePack = options.onAdminProposePack;
  }

  async startTurn(input: StartTurnInput): Promise<void> {
    // "Accepted" happens synchronously (nothing to reject on); the run itself is fire-and-forget,
    // reported entirely through the sink (agent-runtime.ts's own contract).
    void this.run(input);
  }

  async stopTurn(turnId: string): Promise<boolean> {
    if (!this.runningTurnIds.has(turnId)) return false;
    this.stopRequested.add(turnId);
    return true;
  }

  /** `fields` is the event-specific part of one `AgentRuntimeEvent` variant; the four correlation
   *  fields every variant shares come from `input`. */
  private async emit(input: StartTurnInput, fields: AgentRuntimeEventFields): Promise<void> {
    await sleep(this.chunkDelayMs);
    const event: AgentRuntimeEvent = {
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnId: input.turnId,
      principalId: input.principalId,
      ...fields,
    };
    await this.sink.handle(event);
  }

  private async endTurn(input: StartTurnInput, status: TurnEndStatus): Promise<void> {
    this.stopRequested.delete(input.turnId);
    this.runningTurnIds.delete(input.turnId);
    await this.emit(input, { type: 'turnEnded', status });
  }

  private async run(input: StartTurnInput): Promise<void> {
    this.runningTurnIds.add(input.turnId);

    // Each scripted path belongs to one kind of agent: an admin agent never calls invoke_worker
    // (it is outside its ceiling), and only an admin agent proposes an admin proposal. A marker in
    // the other kind's Turn is just text, echoed.
    if (input.agentKind === 'admin_agent') {
      if (this.onAdminPropose && input.prompt.includes(FAKE_ADMIN_PROPOSE_MARKER)) {
        await this.runAdminPropose(input, this.onAdminPropose, 'propose_admin_proposal');
        return;
      }
      if (this.onAdminProposePack && input.prompt.includes(FAKE_ADMIN_PROPOSE_PACK_MARKER)) {
        await this.runAdminPropose(input, this.onAdminProposePack, 'propose_pack_install');
        return;
      }
    } else if (this.onDelegate && input.prompt.includes(FAKE_DELEGATE_MARKER)) {
      await this.runDelegate(input, this.onDelegate);
      return;
    }

    const reply = `echo: ${input.prompt}`;
    const chunks = chunkText(reply, this.chunkSize);

    for (const chunk of chunks) {
      if (this.stopRequested.has(input.turnId)) {
        await this.endTurn(input, 'interrupted');
        return;
      }
      await this.emit(input, { type: 'textDelta', delta: chunk });
    }

    if (this.stopRequested.has(input.turnId)) {
      await this.endTurn(input, 'interrupted');
      return;
    }

    await this.emit(input, { type: 'message', role: 'assistant', content: { text: reply } });
    await this.endTurn(input, this.shouldFail(input) ? 'failed' : 'completed');
  }

  /** STATUS leftover 83: the scripted "call invoke_worker" path `run()` dispatches to on a marker
   *  match — never both this and the plain echo for the same Turn. `onDelegate` rejecting (e.g.
   *  no delegable WorkerDefinition published yet, `invoke_worker`'s own quota/attenuation checks)
   *  ends the Turn `failed` with the error's own message, the same "a runtime-level failure is
   *  still exactly one `turnEnded` event" contract `agent-runtime.ts`'s own doc comment describes
   *  for the real runtime. */
  private async runDelegate(
    input: StartTurnInput,
    onDelegate: (input: StartTurnInput) => Promise<FakeDelegateOutcome>,
  ): Promise<void> {
    const toolCallId = `fake-delegate-${input.turnId}`;
    await this.emit(input, {
      type: 'toolCallStarted',
      toolCallId,
      name: 'invoke_worker',
      args: { prompt: input.prompt },
    });

    let outcome: FakeDelegateOutcome;
    try {
      outcome = await onDelegate(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emit(input, {
        type: 'toolCallEnded',
        toolCallId,
        result: { error: message },
        isError: true,
      });
      await this.emit(input, {
        type: 'message',
        role: 'assistant',
        content: { text: `invoke_worker failed: ${message}` },
      });
      await this.endTurn(input, 'failed');
      return;
    }

    await this.emit(input, { type: 'toolCallEnded', toolCallId, result: outcome });
    await this.emit(input, {
      type: 'message',
      role: 'assistant',
      content: {
        text: `invoke_worker: task ${outcome.taskId} (worker run ${outcome.workerRunId}) ended ${outcome.status}.`,
      },
    });

    if (this.stopRequested.has(input.turnId)) {
      await this.endTurn(input, 'interrupted');
      return;
    }
    await this.endTurn(input, this.shouldFail(input) ? 'failed' : 'completed');
  }
  /** S11 AA4d: the scripted "call propose_admin_proposal" path `run()` dispatches an admin agent
   *  Turn to on a marker match (S11 AA5g: and "call propose_pack_install", `tool` naming which). `onAdminPropose` rejecting (no target chosen, the switch off, a
   *  refusal of the proposal itself) ends the Turn `failed` with the error's message, as
   *  {@link runDelegate} does. */
  private async runAdminPropose(
    input: StartTurnInput,
    onAdminPropose: (input: StartTurnInput) => Promise<FakeAdminProposeOutcome>,
    tool: 'propose_admin_proposal' | 'propose_pack_install',
  ): Promise<void> {
    const toolCallId = `fake-admin-propose-${input.turnId}`;
    await this.emit(input, {
      type: 'toolCallStarted',
      toolCallId,
      name: tool,
      args: {},
    });

    let outcome: FakeAdminProposeOutcome;
    try {
      outcome = await onAdminPropose(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emit(input, {
        type: 'toolCallEnded',
        toolCallId,
        result: { error: message },
        isError: true,
      });
      await this.emit(input, {
        type: 'message',
        role: 'assistant',
        content: { text: `${tool} failed: ${message}` },
      });
      await this.endTurn(input, 'failed');
      return;
    }

    await this.emit(input, { type: 'toolCallEnded', toolCallId, result: outcome });
    await this.emit(input, {
      type: 'message',
      role: 'assistant',
      content: {
        text: `${tool}: proposed "${outcome.title}" (${outcome.proposalId}), now ${outcome.status}.`,
      },
    });

    if (this.stopRequested.has(input.turnId)) {
      await this.endTurn(input, 'interrupted');
      return;
    }
    await this.endTurn(input, this.shouldFail(input) ? 'failed' : 'completed');
  }
}
