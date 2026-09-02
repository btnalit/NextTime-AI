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
  /** turnId -> stop requested. Checked between emitted chunks so a `stopTurn` mid-stream ends the
   *  Turn with `status: 'interrupted'` instead of running to completion. */
  private readonly stopRequested = new Set<string>();

  constructor(options: FakeAgentRuntimeOptions) {
    this.sink = options.sink;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.shouldFail = options.shouldFail ?? (() => false);
  }

  async startTurn(input: StartTurnInput): Promise<void> {
    // "Accepted" happens synchronously (nothing to reject on); the run itself is fire-and-forget,
    // reported entirely through the sink (agent-runtime.ts's own contract).
    void this.run(input);
  }

  async stopTurn(turnId: string): Promise<void> {
    this.stopRequested.add(turnId);
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
    await this.emit(input, { type: 'turnEnded', status });
  }

  private async run(input: StartTurnInput): Promise<void> {
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
}
