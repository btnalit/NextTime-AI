import {
  MAX_WORKER_RUN_TOOL_CALL_RECORDS,
  REPORT_TOOL_CALLS_MAX_BODY_BYTES,
  REPORT_TOOL_CALLS_MAX_CALLS,
  type ReportedToolCall,
  WORKER_TOOL_CALL_ID_MAX_CHARS,
  WORKER_TOOL_CALL_NAME_MAX_CHARS,
  boundToolCallArgs,
  boundToolCallResult,
  sliceKeepingPairs,
  toolCallSecretKeyRule,
} from '@nexttime/shared';
import { type KernelClient, KernelError } from '../kernel-client.js';

/**
 * modes/worker-tool-calls (legacy 155): worker mode's report of the tool calls its run makes. A
 * chat Turn's tool calls reach the kernel through agent-host's event stream (#520); a Worker has no
 * such driver, so this collects pi's `tool_execution_start` / `tool_execution_end` events and posts
 * each finished call to `report_tool_calls` (packages/shared/src/worker-tool-calls.ts), in order,
 * one report at a time — calls that finish while one is out go together in the next.
 *
 * - **Only when the Handle holds it.** `get_task`'s `callerCapabilities` (legacy 761) must list
 *   `report_tool_calls`; until it is read, calls wait; a kernel or Handle without it (an older
 *   kernel, a Handle issued before the capability existed, an evaluation run's closed Handle) gets
 *   none — nothing is sent that would only be refused.
 * - **Before the result.** Accepting the run's result ends the run and revokes its Handle, so
 *   `report_result` sends every finished call first (`flush`) and nothing is sent after the result
 *   is accepted (`close`): the `report_result` call that was accepted is not among the records — the
 *   Task's result is its record. When the turn settles, calls still open are reported
 *   `not_finished` (`settle`), before the fallback report.
 * - **Bounded.** Each payload is sent only as far as the kernel reads it (`boundToolCallArgs`,
 *   `boundToolCallResult`), with every secret value of the arguments the kernel hides in the
 *   result; a report holds at most 50 calls and 512 KiB, and a call that alone would not fit is
 *   sent without its result (then nothing needs those values); a run reports at most the 200 its
 *   records hold.
 * - **Never in the way.** A report that fails is logged; one the kernel could not take for now (no
 *   answer, a 5xx) is sent again with the next, one it refused as malformed is dropped, and any
 *   other refusal stops reporting for the run. The Worker's work and its result never wait on it
 *   beyond `flush` before the result.
 *
 * Not redaction: the kernel redacts what it stores (application/chat/tool-call-record.ts).
 */

interface OpenCall {
  readonly name: string | null;
  readonly args: unknown;
  readonly startedAt: Date;
}

export interface ToolCallStart {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface ToolCallEnd {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
  readonly isError: boolean;
}

/** A kernel refusal that leaves the rest of the run's reports worth sending: this report was
 *  malformed (so it is dropped), or the kernel could not take it for now (so it is sent again). */
const DROPPED_REPORT_CODES: ReadonlySet<string> = new Set(['invalid_params']);
const RETRIED_REPORT_CODES: ReadonlySet<string> = new Set([
  'internal_error',
  'service_unavailable',
]);

function cut(text: string, max: number): string {
  return text.length <= max ? text : sliceKeepingPairs(text, max);
}

function bodyBytes(call: ReportedToolCall): number {
  return Buffer.byteLength(JSON.stringify(call), 'utf8');
}

export class ToolCallReporter {
  /** `get_task`'s word on whether this Handle may report: unknown until it is read. */
  private allowed: boolean | undefined;
  /** The result was accepted or a refusal stopped reporting: nothing more is collected or sent. */
  private closed = false;
  private readonly open = new Map<string, OpenCall>();
  private readonly pending: ReportedToolCall[] = [];
  /** Calls queued or sent for this run, against `MAX_WORKER_RUN_TOOL_CALL_RECORDS`. */
  private admitted = 0;
  private chain: Promise<void> = Promise.resolve();

  private readonly kernelClient: KernelClient;
  private readonly log: (error: unknown, capabilityName: string) => void;
  private readonly now: () => Date;

  constructor(
    kernelClient: KernelClient,
    log: (error: unknown, capabilityName: string) => void,
    now: () => Date = () => new Date(),
  ) {
    this.kernelClient = kernelClient;
    this.log = log;
    this.now = now;
  }

  /** What `get_task`'s `callerCapabilities` says. A kernel that sends no list does not hold the
   *  capability either (it predates it). */
  setCallerCapabilities(callerCapabilities: unknown): void {
    if (this.allowed !== undefined) return;
    this.allowed =
      Array.isArray(callerCapabilities) && callerCapabilities.includes('report_tool_calls');
    if (!this.allowed) this.stop();
    else void this.flush();
  }

  started(event: ToolCallStart): void {
    if (this.closed || this.open.size >= MAX_WORKER_RUN_TOOL_CALL_RECORDS) return;
    this.open.set(event.toolCallId, {
      name: event.toolName || null,
      args: event.args,
      startedAt: this.now(),
    });
  }

  ended(event: ToolCallEnd): void {
    if (this.closed) return;
    const opened = this.open.get(event.toolCallId);
    this.open.delete(event.toolCallId);
    if (!this.admit()) return;
    this.pending.push(
      this.reported(event.toolCallId, opened, event.toolName, {
        outcome: event.isError ? 'failed' : 'done',
        result: event.result,
        endedAt: this.now(),
      }),
    );
    void this.flush();
  }

  /** Sends every finished call not sent yet; resolves when that is done, and never rejects. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.sendPending());
    return this.chain;
  }

  /** The turn settled: calls still open (other than `exceptToolName`, the result's own) did not
   *  finish; they are reported so, and everything is sent. */
  settle(exceptToolName: string): Promise<void> {
    if (!this.closed) {
      const endedAt = this.now();
      for (const [toolCallId, opened] of this.open) {
        if (opened.name === exceptToolName) continue;
        if (!this.admit()) break;
        this.pending.push(
          this.reported(toolCallId, opened, opened.name, { outcome: 'not_finished', endedAt }),
        );
      }
      this.open.clear();
    }
    return this.flush();
  }

  /** The run's result was accepted: its Handle is revoked, so nothing more is sent. */
  close(): void {
    this.stop();
  }

  private stop(): void {
    this.closed = true;
    this.open.clear();
    this.pending.length = 0;
  }

  private admit(): boolean {
    if (this.admitted >= MAX_WORKER_RUN_TOOL_CALL_RECORDS) return false;
    this.admitted += 1;
    return true;
  }

  private reported(
    toolCallId: string,
    opened: OpenCall | undefined,
    toolName: string | null,
    end: {
      readonly outcome: ReportedToolCall['outcome'];
      readonly result?: unknown;
      readonly endedAt: Date;
    },
  ): ReportedToolCall {
    const named = opened?.name ?? (toolName || null);
    const name = named === null ? null : cut(named, WORKER_TOOL_CALL_NAME_MAX_CHARS);
    const args = opened?.args;
    const call = (withResult: boolean): ReportedToolCall => ({
      toolCallId: cut(toolCallId, WORKER_TOOL_CALL_ID_MAX_CHARS) || '(no id)',
      name,
      outcome: end.outcome,
      ...(args !== undefined
        ? {
            // The values the kernel hides in the result are needed only beside it — and the rule
            // is the kernel's own, by the tool's name as sent.
            args: boundToolCallArgs(
              args,
              withResult ? { isSecretKey: toolCallSecretKeyRule(name) } : {},
            ),
          }
        : {}),
      ...(withResult && end.result !== undefined
        ? { result: boundToolCallResult(end.result) }
        : {}),
      startedAt: opened?.startedAt.toISOString() ?? null,
      endedAt: end.endedAt.toISOString(),
    });
    const whole = call(true);
    // Only the kept secret values can make one call outgrow a report (64 of up to 4 096
    // characters, written as JSON); without its result the call needs none of them.
    return bodyBytes(whole) <= REPORT_TOOL_CALLS_MAX_BODY_BYTES ? whole : call(false);
  }

  /** The longest run of pending calls that fits one report. */
  private nextBatch(): ReportedToolCall[] {
    const batch: ReportedToolCall[] = [];
    let bytes = 0;
    for (const call of this.pending) {
      if (batch.length >= REPORT_TOOL_CALLS_MAX_CALLS) break;
      const size = bodyBytes(call);
      if (batch.length > 0 && bytes + size > REPORT_TOOL_CALLS_MAX_BODY_BYTES) break;
      batch.push(call);
      bytes += size;
    }
    return batch;
  }

  private async sendPending(): Promise<void> {
    while (!this.closed && this.allowed === true && this.pending.length > 0) {
      const batch = this.nextBatch();
      try {
        await this.kernelClient.call('report_tool_calls', { calls: batch });
      } catch (error) {
        this.log(error, 'report_tool_calls');
        const code = error instanceof KernelError ? error.code : undefined;
        const refused = error instanceof KernelError && error.kind === 'capability_error';
        if (refused && code !== undefined && DROPPED_REPORT_CODES.has(code)) {
          this.pending.splice(0, batch.length);
          continue;
        }
        if (refused && !(code !== undefined && RETRIED_REPORT_CODES.has(code))) {
          this.stop();
        }
        // Not answered, or not now: kept for the next report.
        return;
      }
      this.pending.splice(0, batch.length);
    }
  }
}
