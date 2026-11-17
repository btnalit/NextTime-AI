import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ClientCutOff, deliverToClient } from './client-delivery.js';

/**
 * A client whose connection takes bytes only while `taking` is on — a stand-in for the response a
 * client reads (or stops reading). Nothing is accepted until then, so the backlog, `drain` and
 * `finish` are all under the test's control.
 */
function fakeClient(highWaterMark: number): {
  readonly res: Writable;
  take(): void;
  stop(): void;
} {
  let taking = false;
  const pending: Array<() => void> = [];
  const res = new Writable({
    highWaterMark,
    write(_chunk, _encoding, callback) {
      if (taking) callback();
      else pending.push(() => callback());
    },
  });
  return {
    res,
    take() {
      taking = true;
      for (const accept of pending.splice(0)) accept();
    },
    stop() {
      taking = false;
    },
  };
}

const bytes = (count: number): Uint8Array => new Uint8Array(count);
/** Lets the stream's own next-tick bookkeeping (`drain`, `finish`, `close`) run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => process.nextTick(resolve));
};

describe('deliverToClient (legacy 161)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const STALL_MS = 1000;
  const start = (client: ReturnType<typeof fakeClient>, bufferLimitBytes = 1024 * 1024) => {
    const cutOffs: ClientCutOff[] = [];
    const delivery = deliverToClient(client.res, {
      stallTimeoutMs: STALL_MS,
      bufferLimitBytes,
      onCutOff: (cutOff) => cutOffs.push(cutOff),
    });
    return { delivery, cutOffs };
  };

  it('a client that falls behind and catches up is never cut off, however long the answer runs', async () => {
    const client = fakeClient(16);
    const { delivery, cutOffs } = start(client);

    delivery.forward(bytes(64)); // past the high-water mark: the stall clock starts
    await vi.advanceTimersByTimeAsync(STALL_MS / 2);
    client.take(); // caught up (`drain`): the clock stops
    await settle();
    client.stop();
    await vi.advanceTimersByTimeAsync(STALL_MS * 3);
    expect(cutOffs).toEqual([]);
    expect(delivery.gone()).toBe(false);

    client.take();
    await delivery.end();
    expect(delivery.gone()).toBe(false);
    expect(client.res.writableFinished).toBe(true);
  });

  it('the stall clock runs from when the client first fell behind; later writes do not restart it', async () => {
    const client = fakeClient(16);
    const { delivery, cutOffs } = start(client);

    delivery.forward(bytes(64));
    await vi.advanceTimersByTimeAsync(STALL_MS * 0.6);
    delivery.forward(bytes(64)); // still behind
    await vi.advanceTimersByTimeAsync(STALL_MS * 0.5);
    expect(cutOffs).toEqual([{ reason: 'stalled', stallTimeoutMs: STALL_MS }]);
    expect(delivery.gone()).toBe(true);
    expect(client.res.destroyed).toBe(true);
  });

  it('an answer that ends while the client has stopped taking it is still timed: end() settles with the client cut off', async () => {
    // A high-water mark above everything written: no write ever reports a backlog, so no clock
    // runs before the end — only the end itself can start one.
    const client = fakeClient(1024);
    const { delivery, cutOffs } = start(client);

    delivery.forward(bytes(64));
    let ended = false;
    void delivery.end().then(() => {
      ended = true;
    });
    await settle();
    expect(ended).toBe(false);

    await vi.advanceTimersByTimeAsync(STALL_MS);
    await settle();
    expect(ended).toBe(true);
    expect(cutOffs).toEqual([{ reason: 'stalled', stallTimeoutMs: STALL_MS }]);
    expect(delivery.gone()).toBe(true);
  });

  it('once the answer has ended, a drain does not stop the clock: the end can still sit unflushed', async () => {
    const client = fakeClient(16);
    const { delivery, cutOffs } = start(client);

    delivery.forward(bytes(64)); // behind: the clock starts
    let ended = false;
    void delivery.end().then(() => {
      ended = true;
    });
    // An http.ServerResponse emits `drain` whenever its socket drains, even after end() — while
    // the end of the answer itself may not have reached the client.
    client.res.emit('drain');
    await vi.advanceTimersByTimeAsync(STALL_MS);
    await settle();
    expect(ended).toBe(true);
    expect(cutOffs).toEqual([{ reason: 'stalled', stallTimeoutMs: STALL_MS }]);
  });

  it('a backlog past the buffer limit cuts the client off at once, and nothing more is written to it', async () => {
    const client = fakeClient(16);
    const { delivery, cutOffs } = start(client, 100);

    delivery.forward(bytes(60));
    expect(cutOffs).toEqual([]);
    delivery.forward(bytes(60));
    expect(cutOffs).toEqual([{ reason: 'buffer_full', bufferLimitBytes: 100, bufferedBytes: 60 }]);
    expect(delivery.gone()).toBe(true);
    delivery.forward(bytes(60));
    expect(cutOffs).toHaveLength(1);
    await delivery.end();
  });

  it('a client that goes away on its own is gone, is not written to, and end() settles at once', async () => {
    const client = fakeClient(16);
    const { delivery, cutOffs } = start(client);
    const write = vi.spyOn(client.res, 'write');

    client.res.destroy();
    await settle();
    expect(delivery.gone()).toBe(true);
    delivery.forward(bytes(8));
    expect(write).not.toHaveBeenCalled();
    await delivery.end();
    expect(cutOffs).toEqual([]);
  });

  it('a client that took the whole answer is not gone', async () => {
    const client = fakeClient(16);
    client.take();
    const { delivery } = start(client);
    delivery.forward(bytes(64));
    await delivery.end();
    client.res.destroy();
    await settle();
    expect(delivery.gone()).toBe(false);
  });
});
