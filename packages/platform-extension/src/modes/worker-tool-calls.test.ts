import {
  MAX_SECRET_LITERALS,
  MAX_SECRET_LITERAL_CHARS,
  MAX_WORKER_RUN_TOOL_CALL_RECORDS,
  REPORT_TOOL_CALLS_MAX_BODY_BYTES,
  REPORT_TOOL_CALLS_MAX_CALLS,
  type ReportedToolCall,
  TOOL_CALL_PAYLOAD_LEFT_OUT,
  WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS,
} from '@nexttime/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelClient } from '../kernel-client.js';
import { type FakeKernel, startFakeKernel } from '../test-support/fake-kernel.js';
import { ToolCallReporter } from './worker-tool-calls.js';

/**
 * modes/worker-tool-calls (legacy 155): worker mode's report of its run's tool calls, against the
 * in-process fake kernel — when it reports (only once `get_task` says its Handle may), what it
 * sends (each call once, in order, bounded), how it batches, and what a refusal does.
 */

const AT = new Date('2026-11-20T08:00:00.000Z');

function reportedCalls(kernel: FakeKernel): ReportedToolCall[][] {
  return kernel.requests
    .filter((request) => request.capability === 'report_tool_calls')
    .map((request) => (request.params as { calls: ReportedToolCall[] }).calls);
}

function finish(
  reporter: ToolCallReporter,
  id: string,
  extra: { args?: unknown; result?: unknown; isError?: boolean } = {},
): void {
  reporter.started({ toolCallId: id, toolName: 'bash', args: extra.args ?? { command: id } });
  reporter.ended({
    toolCallId: id,
    toolName: 'bash',
    result: extra.result ?? { content: [{ type: 'text', text: `${id} ok` }] },
    isError: extra.isError ?? false,
  });
}

describe('ToolCallReporter', () => {
  let kernel: FakeKernel;
  let reporter: ToolCallReporter;
  let log: ReturnType<typeof vi.fn<(error: unknown, capabilityName: string) => void>>;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    kernel.setHandler('report_tool_calls', () => ({
      ok: true,
      result: { workerRunId: 'run-1', stored: 1, alreadyStored: 0, overLimit: 0 },
    }));
    log = vi.fn<(error: unknown, capabilityName: string) => void>();
    reporter = new ToolCallReporter(
      new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' }),
      log,
      () => AT,
    );
  });

  afterEach(async () => {
    await kernel.close();
  });

  it('holds the calls until get_task says the Handle may report them, then sends each once, in order', async () => {
    finish(reporter, 'call-1', { args: { command: 'uptime' } });
    finish(reporter, 'call-2', {
      isError: true,
      result: { content: [{ type: 'text', text: 'exit 1' }] },
    });
    await reporter.flush();
    expect(reportedCalls(kernel)).toEqual([]);

    reporter.setCallerCapabilities(['get_task', 'report_task_result', 'report_tool_calls']);
    await reporter.flush();
    expect(reportedCalls(kernel)).toEqual([
      [
        {
          toolCallId: 'call-1',
          name: 'bash',
          outcome: 'done',
          args: { command: 'uptime' },
          result: { content: [{ type: 'text', text: 'call-1 ok' }] },
          startedAt: AT.toISOString(),
          endedAt: AT.toISOString(),
        },
        {
          toolCallId: 'call-2',
          name: 'bash',
          outcome: 'failed',
          args: { command: 'call-2' },
          result: { content: [{ type: 'text', text: 'exit 1' }] },
          startedAt: AT.toISOString(),
          endedAt: AT.toISOString(),
        },
      ],
    ]);
    // Nothing is sent twice.
    await reporter.flush();
    expect(reportedCalls(kernel)).toHaveLength(1);
  });

  it('sends nothing, ever, when the Handle does not hold report_tool_calls (an older kernel, an evaluation run)', async () => {
    finish(reporter, 'call-1');
    reporter.setCallerCapabilities(['get_task', 'report_task_result']);
    finish(reporter, 'call-2');
    await reporter.settle('report_result');
    expect(reportedCalls(kernel)).toEqual([]);

    const older = new ToolCallReporter(
      new KernelClient({ kernelUrl: kernel.url, capabilityHandle: 'h' }),
      log,
    );
    finish(older, 'call-3');
    // A kernel that predates legacy 761 sends no list at all.
    older.setCallerCapabilities(undefined);
    await older.flush();
    expect(reportedCalls(kernel)).toEqual([]);
  });

  it('reports a call whose start it did not see without arguments or start time, and bounds what it sends', async () => {
    reporter.setCallerCapabilities(['report_tool_calls']);
    reporter.ended({
      toolCallId: 'x'.repeat(300),
      toolName: 'read',
      result: {
        content: [{ type: 'text', text: 'y'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS + 500) }],
        details: { path: '/a' },
      },
      isError: false,
    });
    await reporter.flush();
    const [call] = reportedCalls(kernel)[0] ?? [];
    expect(call?.toolCallId).toBe('x'.repeat(256));
    expect(call?.name).toBe('read');
    expect(call?.args).toBeUndefined();
    expect(call?.startedAt).toBeNull();
    expect(call?.result).toEqual({
      content: [{ type: 'text', text: 'y'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS) }],
    });
  });

  it("sends the arguments' secret values past the bound beside the result, so the kernel hides them in it (#501 F1)", async () => {
    reporter.setCallerCapabilities(['report_tool_calls']);
    const blob = 'b'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS + 10);
    finish(reporter, 'call-1', {
      args: { blob, note: 'left out', headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      result: { content: [{ type: 'text', text: 'refused: Basic dXNlcjpwYXNz' }] },
    });
    await reporter.flush();
    const [call] = reportedCalls(kernel)[0] ?? [];
    expect(call?.args).toEqual({
      blob: 'b'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS),
      [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(call?.result).toEqual({
      content: [{ type: 'text', text: 'refused: Basic dXNlcjpwYXNz' }],
    });
  });

  it('sends a call that those values would make too big for a report without its result, and then without them', async () => {
    reporter.setCallerCapabilities(['report_tool_calls']);
    // 64 values of 4 096 characters, each written as JSON six bytes a character: past 512 KiB.
    const secrets = Array.from(
      { length: MAX_SECRET_LITERALS },
      (_, i) => `${String(i).padStart(2, '0')}${'\u0001'.repeat(MAX_SECRET_LITERAL_CHARS - 2)}`,
    );
    finish(reporter, 'call-1', {
      args: { blob: 'b'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS), secrets },
      result: { content: [{ type: 'text', text: 'done' }] },
    });
    await reporter.flush();
    const [call] = reportedCalls(kernel)[0] ?? [];
    expect(call?.outcome).toBe('done');
    expect(call?.result).toBeUndefined();
    expect(call?.args).toEqual({
      blob: 'b'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS),
      [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
    });
    expect(Buffer.byteLength(JSON.stringify(call), 'utf8')).toBeLessThan(
      REPORT_TOOL_CALLS_MAX_BODY_BYTES,
    );
  });

  it(`sends at most ${REPORT_TOOL_CALLS_MAX_CALLS} calls and about ${REPORT_TOOL_CALLS_MAX_BODY_BYTES / 1024} KiB in one report`, async () => {
    for (let i = 0; i < 120; i += 1) finish(reporter, `call-${i}`);
    reporter.setCallerCapabilities(['report_tool_calls']);
    await reporter.flush();
    expect(reportedCalls(kernel).map((calls) => calls.length)).toEqual([50, 50, 20]);
    expect(
      reportedCalls(kernel)
        .flat()
        .map((call) => call.toolCallId),
    ).toEqual(Array.from({ length: 120 }, (_, i) => `call-${i}`));

    kernel.requests.length = 0;
    const big = 'z'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS);
    for (let i = 0; i < 20; i += 1) {
      finish(reporter, `big-${i}`, {
        args: { content: big },
        result: { content: [{ type: 'text', text: big }] },
      });
    }
    await reporter.flush();
    const bodies = kernel.requests
      .filter((request) => request.capability === 'report_tool_calls')
      .map((request) => Buffer.byteLength(JSON.stringify(request.params), 'utf8'));
    expect(bodies.length).toBeGreaterThan(1);
    for (const bytes of bodies)
      expect(bytes).toBeLessThanOrEqual(REPORT_TOOL_CALLS_MAX_BODY_BYTES + 100);
    expect(reportedCalls(kernel).flat()).toHaveLength(20);
  });

  it(`reports at most the ${MAX_WORKER_RUN_TOOL_CALL_RECORDS} calls a run's records hold`, async () => {
    reporter.setCallerCapabilities(['report_tool_calls']);
    for (let i = 0; i < MAX_WORKER_RUN_TOOL_CALL_RECORDS + 10; i += 1)
      finish(reporter, `call-${i}`);
    reporter.started({ toolCallId: 'open', toolName: 'bash', args: {} });
    await reporter.settle('report_result');
    expect(reportedCalls(kernel).flat()).toHaveLength(MAX_WORKER_RUN_TOOL_CALL_RECORDS);
  });

  it('one report at a time: calls that finish while one is out go in the next', async () => {
    let inFlight = 0;
    let most = 0;
    kernel.setHandler('report_tool_calls', async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return {
        ok: true,
        result: { workerRunId: 'run-1', stored: 1, alreadyStored: 0, overLimit: 0 },
      };
    });
    reporter.setCallerCapabilities(['report_tool_calls']);
    finish(reporter, 'call-1');
    finish(reporter, 'call-2');
    finish(reporter, 'call-3');
    await reporter.flush();
    expect(most).toBe(1);
    expect(
      reportedCalls(kernel)
        .flat()
        .map((call) => call.toolCallId),
    ).toEqual(['call-1', 'call-2', 'call-3']);
  });

  it('at settle, reports the calls still open as not finished — never the result tool’s own', async () => {
    reporter.setCallerCapabilities(['report_tool_calls']);
    reporter.started({ toolCallId: 'hung', toolName: 'bash', args: { command: 'sleep 999' } });
    reporter.started({ toolCallId: 'report', toolName: 'report_result', args: { summary: 's' } });
    await reporter.settle('report_result');
    expect(reportedCalls(kernel)).toEqual([
      [
        {
          toolCallId: 'hung',
          name: 'bash',
          outcome: 'not_finished',
          args: { command: 'sleep 999' },
          startedAt: AT.toISOString(),
          endedAt: AT.toISOString(),
        },
      ],
    ]);
  });

  it('sends nothing once closed (the result was accepted and the Handle revoked)', async () => {
    reporter.setCallerCapabilities(['report_tool_calls']);
    finish(reporter, 'call-1');
    await reporter.flush();
    reporter.close();
    finish(reporter, 'call-2');
    await reporter.settle('report_result');
    expect(
      reportedCalls(kernel)
        .flat()
        .map((call) => call.toolCallId),
    ).toEqual(['call-1']);
  });

  it('drops a report refused as malformed and goes on with the next', async () => {
    kernel.setHandler('report_tool_calls', (request) => {
      const [first] = (request.params as { calls: ReportedToolCall[] }).calls;
      return first?.toolCallId === 'call-0'
        ? { ok: false, error: { code: 'invalid_params', message: 'calls[0]: bad' } }
        : { ok: true, result: { workerRunId: 'run-1', stored: 1, alreadyStored: 0, overLimit: 0 } };
    });
    for (let i = 0; i < 60; i += 1) finish(reporter, `call-${i}`);
    reporter.setCallerCapabilities(['report_tool_calls']);
    await reporter.flush();
    // The first 50 were refused and dropped; the other 10 went on.
    expect(reportedCalls(kernel).map((calls) => calls.length)).toEqual([50, 10]);
    expect(log).toHaveBeenCalledTimes(1);
    await reporter.flush();
    expect(reportedCalls(kernel)).toHaveLength(2);
  });

  it('keeps a report the kernel could not take for now, and sends it again with the next', async () => {
    let refuse = true;
    kernel.setHandler('report_tool_calls', () =>
      refuse
        ? { ok: false, error: { code: 'service_unavailable', message: 'busy' } }
        : { ok: true, result: { workerRunId: 'run-1', stored: 1, alreadyStored: 0, overLimit: 0 } },
    );
    reporter.setCallerCapabilities(['report_tool_calls']);
    finish(reporter, 'call-1');
    await reporter.flush();
    refuse = false;
    finish(reporter, 'call-2');
    await reporter.flush();
    const sent = reportedCalls(kernel).map((calls) => calls.map((call) => call.toolCallId));
    // Each flush while refused tried call-1 again; once taken, it went with call-2, and that was it.
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.slice(0, -1)).toEqual(sent.slice(0, -1).map(() => ['call-1']));
    expect(sent.at(-1)).toEqual(['call-1', 'call-2']);
    await reporter.flush();
    expect(reportedCalls(kernel)).toHaveLength(sent.length);
  });

  it('keeps the calls when the kernel does not answer at all', async () => {
    const unreachable = new ToolCallReporter(
      // Nothing listens on port 9 of the loopback address.
      new KernelClient({ kernelUrl: 'http://127.0.0.1:9', capabilityHandle: 'h' }),
      log,
    );
    unreachable.setCallerCapabilities(['report_tool_calls']);
    finish(unreachable, 'call-1');
    await unreachable.flush();
    expect(log).toHaveBeenCalled();
  });

  it('stops reporting for the run on any other refusal (the Handle was revoked, the run ended)', async () => {
    kernel.setHandler('report_tool_calls', () => ({
      ok: false,
      error: { code: 'forbidden', message: 'not a WorkerRun' },
    }));
    reporter.setCallerCapabilities(['report_tool_calls']);
    finish(reporter, 'call-1');
    await reporter.flush();
    finish(reporter, 'call-2');
    await reporter.settle('report_result');
    expect(reportedCalls(kernel)).toHaveLength(1);
  });
});
