import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KernelToAgentHostFrame } from '@nexttime/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelLink } from './kernel-link.js';
import { createAgentHostMetrics, handleMetricsRequest } from './metrics.js';

function startTurn(turnId: string): Extract<KernelToAgentHostFrame, { type: 'startTurn' }> {
  return {
    type: 'startTurn',
    workspaceId: 'ws-1',
    chatId: 'chat-1',
    turnId,
    principalId: 'p-1',
    prompt: 'hi',
    handle: 'never-logged-handle',
    kernelLlmUrl: 'http://llm-proxy:8082',
  };
}

function fakeLink(connected = true): KernelLink {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isConnected: () => connected,
    sendRuntimeEvent: vi.fn(),
    sendTurnAccepted: vi.fn(),
    sendTurnRejected: vi.fn(),
    sendTurnUnknown: vi.fn(),
  };
}

describe('createAgentHostMetrics (leftover 87)', () => {
  it('counts started / ended Turns by status, times them, and logs both ends with the Turn id', () => {
    const lines: string[] = [];
    let clock = 1_000;
    const metrics = createAgentHostMetrics({ log: (l) => lines.push(l), now: () => clock });
    const inner = fakeLink();
    const link = metrics.observe(inner);

    metrics.turnStarted(startTurn('turn-aaaa-0001'));
    metrics.turnStarted(startTurn('turn-aaaa-0002'));
    clock += 2_500;
    link.sendTurnAccepted('turn-aaaa-0001');
    link.sendRuntimeEvent({
      type: 'turnEnded',
      status: 'completed',
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      turnId: 'turn-aaaa-0001',
      principalId: 'p-1',
    });
    link.sendTurnRejected('turn-aaaa-0002', 'busy');
    // A second outcome for the same Turn is forwarded but never counted twice.
    link.sendTurnRejected('turn-aaaa-0002', 'busy');

    expect(inner.sendTurnAccepted).toHaveBeenCalledWith('turn-aaaa-0001');
    expect(inner.sendRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(inner.sendTurnRejected).toHaveBeenCalledTimes(2);

    const text = metrics.render();
    expect(text).toContain('nexttime_agent_host_turns_started_total 2');
    expect(text).toContain('nexttime_agent_host_turns_ended_total{status="completed"} 1');
    expect(text).toContain('nexttime_agent_host_turns_ended_total{status="rejected"} 1');
    expect(text).toContain('nexttime_agent_host_turn_duration_seconds_sum{status="completed"} 2.5');
    expect(text).toContain('nexttime_agent_host_active_turns 0');
    expect(text).toContain('nexttime_agent_host_kernel_link_up 1');

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.filter((l) => l.correlationId === 'turn-aaaa-0001').map((l) => l.msg)).toEqual([
      'agent-host: turn started',
      'agent-host: turn ended',
    ]);
    expect(lines.join('\n')).not.toContain('never-logged-handle');
  });

  it('reports the kernel link as down', () => {
    const metrics = createAgentHostMetrics({ log: () => {} });
    metrics.observe(fakeLink(false));
    expect(metrics.render()).toContain('nexttime_agent_host_kernel_link_up 0');
  });
});

describe('handleMetricsRequest (leftover 87)', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(): Promise<string> {
    server = http.createServer((req, res) => {
      if (
        handleMetricsRequest(req, res, { authorizationHeader: 'Bearer tok', render: () => 'x 1\n' })
      )
        return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('401s without the internal-plane token, 200s Prometheus text with it, ignores other paths', async () => {
    const base = await start();
    expect((await fetch(`${base}/internal/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${base}/internal/metrics`, { headers: { authorization: 'Bearer nope' } }))
        .status,
    ).toBe(401);
    const ok = await fetch(`${base}/internal/metrics`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('version=0.0.4');
    expect(await ok.text()).toBe('x 1\n');
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});
