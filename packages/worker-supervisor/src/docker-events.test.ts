import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerLifecycleEvent } from './docker-events.js';
import { subscribeToContainerEvents } from './docker-events.js';

/** A minimal `getContainerEvents`-only fake — `subscribeToContainerEvents` only depends on
 *  `Pick<DockerClient, 'getContainerEvents'>`, so this never needs the full `FakeDockerClient`
 *  (which stubs this method out — see its own doc comment for why). The returned EventEmitter
 *  stands in for the Node `ReadableStream` `dockerode.getEvents()` resolves to: tests drive it
 *  directly with `.emit('data'|'error'|'end'|'close', ...)`. */
function fakeDockerEvent(overrides: {
  action: string;
  containerId: string;
  type?: string;
}): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      Type: overrides.type ?? 'container',
      Action: overrides.action,
      Actor: { ID: overrides.containerId, Attributes: { 'nexttime.role': 'entry' } },
    })}\n`,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribeToContainerEvents', () => {
  it('parses a die event off the stream and calls onContainerEvent with {action, containerId}', async () => {
    const stream = new EventEmitter();
    const getContainerEvents = vi.fn().mockResolvedValue(stream);
    const onContainerEvent = vi.fn<(event: ContainerLifecycleEvent) => void>();
    const reconcile = vi.fn().mockResolvedValue(undefined);

    const subscriber = subscribeToContainerEvents({
      docker: { getContainerEvents },
      onContainerEvent,
      reconcile,
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(0); // let connect()'s await settle

    expect(getContainerEvents).toHaveBeenCalledWith({
      event: ['die', 'destroy', 'kill', 'stop'],
      label: ['nexttime.role'],
    });
    expect(reconcile).toHaveBeenCalledTimes(1); // startup: reconcile first, then subscribe

    stream.emit('data', fakeDockerEvent({ action: 'die', containerId: 'abc123' }));
    expect(onContainerEvent).toHaveBeenCalledWith({ action: 'die', containerId: 'abc123' });

    subscriber.stop();
  });

  it('handles multiple events split across chunks and buffers a partial trailing line', async () => {
    const stream = new EventEmitter();
    const getContainerEvents = vi.fn().mockResolvedValue(stream);
    const onContainerEvent = vi.fn<(event: ContainerLifecycleEvent) => void>();
    const subscriber = subscribeToContainerEvents({
      docker: { getContainerEvents },
      onContainerEvent,
      reconcile: vi.fn().mockResolvedValue(undefined),
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);

    const full = fakeDockerEvent({ action: 'die', containerId: 'one' }).toString();
    const [firstHalf, secondHalf] = [full.slice(0, 10), full.slice(10)];
    stream.emit('data', Buffer.from(firstHalf)); // no trailing newline yet — must not fire early
    expect(onContainerEvent).not.toHaveBeenCalled();
    stream.emit('data', Buffer.from(secondHalf));
    expect(onContainerEvent).toHaveBeenCalledWith({ action: 'die', containerId: 'one' });

    subscriber.stop();
  });

  it('ignores a non-container event and a malformed line, without throwing or calling onContainerEvent', async () => {
    const stream = new EventEmitter();
    const getContainerEvents = vi.fn().mockResolvedValue(stream);
    const onContainerEvent = vi.fn<(event: ContainerLifecycleEvent) => void>();
    const subscriber = subscribeToContainerEvents({
      docker: { getContainerEvents },
      onContainerEvent,
      reconcile: vi.fn().mockResolvedValue(undefined),
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(() => {
      stream.emit(
        'data',
        fakeDockerEvent({ action: 'connect', containerId: 'net-1', type: 'network' }),
      );
      stream.emit('data', Buffer.from('not json at all\n'));
      stream.emit('data', Buffer.from(`${JSON.stringify({ Type: 'container' })}\n`)); // no Action/Actor
    }).not.toThrow();
    expect(onContainerEvent).not.toHaveBeenCalled();

    subscriber.stop();
  });

  it('reconnects and runs another reconcile pass after the stream errors', async () => {
    const streamA = new EventEmitter();
    const streamB = new EventEmitter();
    const getContainerEvents = vi
      .fn()
      .mockResolvedValueOnce(streamA)
      .mockResolvedValueOnce(streamB);
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const logLines: Array<Record<string, unknown>> = [];

    const subscriber = subscribeToContainerEvents({
      docker: { getContainerEvents },
      onContainerEvent: () => {},
      reconcile,
      log: (line) => logLines.push(line),
      baseReconnectDelayMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    streamA.emit('error', new Error('socket hang up'));
    expect(getContainerEvents).toHaveBeenCalledTimes(1); // not yet — waiting on backoff

    await vi.advanceTimersByTimeAsync(1_000); // backoff elapses, reconnect fires
    expect(getContainerEvents).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(
      logLines.some(
        (l) =>
          l.level === 'warn' &&
          l.msg === 'docker events stream disconnected — reconnecting with backoff',
      ),
    ).toBe(true);

    subscriber.stop();
  });

  it('a redundant close immediately after error does not schedule a second reconnect', async () => {
    const streamA = new EventEmitter();
    const streamB = new EventEmitter();
    const getContainerEvents = vi
      .fn()
      .mockResolvedValueOnce(streamA)
      .mockResolvedValueOnce(streamB);
    const subscriber = subscribeToContainerEvents({
      docker: { getContainerEvents },
      onContainerEvent: () => {},
      reconcile: vi.fn().mockResolvedValue(undefined),
      log: () => {},
      baseReconnectDelayMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    streamA.emit('error', new Error('boom'));
    streamA.emit('close'); // Node commonly fires both for one disconnect

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getContainerEvents).toHaveBeenCalledTimes(2); // exactly one reconnect, not two

    subscriber.stop();
  });

  it('logs a single warning and keeps retrying in the background when the subscription cannot be established', async () => {
    const getContainerEvents = vi.fn().mockRejectedValue(new Error('EVENTS flag is off'));
    const logLines: Array<Record<string, unknown>> = [];

    const subscriber = subscribeToContainerEvents({
      docker: { getContainerEvents },
      onContainerEvent: () => {},
      reconcile: vi.fn().mockResolvedValue(undefined),
      log: (line) => logLines.push(line),
      baseReconnectDelayMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    const warnings = logLines.filter((l) => l.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(getContainerEvents).toHaveBeenCalledTimes(1);

    // Retries continue in the background (never crashes; the reaper stays the fallback) without
    // repeating the warning.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getContainerEvents).toHaveBeenCalledTimes(2);
    expect(logLines.filter((l) => l.level === 'warn')).toHaveLength(1);

    subscriber.stop();
  });

  it('caps the reconnect backoff at maxReconnectDelayMs', async () => {
    const getContainerEvents = vi.fn().mockRejectedValue(new Error('still down'));
    const subscriber = subscribeToContainerEvents({
      docker: { getContainerEvents },
      onContainerEvent: () => {},
      reconcile: vi.fn().mockResolvedValue(undefined),
      log: () => {},
      baseReconnectDelayMs: 1_000,
      maxReconnectDelayMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(0); // attempt 1 (fails)
    await vi.advanceTimersByTimeAsync(1_000); // attempt 2 (fails) — delay was 1000, now 2000
    await vi.advanceTimersByTimeAsync(2_000); // attempt 3 (fails) — delay was 2000, now capped 3000
    expect(getContainerEvents).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(getContainerEvents).toHaveBeenCalledTimes(3); // not yet — capped delay hasn't elapsed
    await vi.advanceTimersByTimeAsync(1);
    expect(getContainerEvents).toHaveBeenCalledTimes(4); // capped delay (3000) elapsed

    subscriber.stop();
  });

  it('stop() prevents any further reconnect attempts', async () => {
    const stream = new EventEmitter();
    const getContainerEvents = vi.fn().mockResolvedValue(stream);
    const subscriber = subscribeToContainerEvents({
      docker: { getContainerEvents },
      onContainerEvent: () => {},
      reconcile: vi.fn().mockResolvedValue(undefined),
      log: () => {},
      baseReconnectDelayMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    subscriber.stop();
    stream.emit('error', new Error('boom')); // fires after stop() — must not schedule a reconnect
    await vi.advanceTimersByTimeAsync(60_000);

    expect(getContainerEvents).toHaveBeenCalledTimes(1);
  });
});
