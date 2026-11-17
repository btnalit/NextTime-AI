import type { Writable } from 'node:stream';

/**
 * Legacy 161: hands a successful answer to the client that asked for it without ever waiting for
 * that client — proxy.ts reads the upstream answer to its end at the upstream's own pace whatever
 * the client does (module doc there). What the client has not taken yet waits in the response's
 * own buffer, bounded two ways; a client past either bound is cut off and not forwarded to again:
 *
 * - `bufferLimitBytes`: the backlog this process holds for the client (`writableLength`, which
 *   counts everything not yet accepted by the kernel's socket buffer);
 * - `stallTimeoutMs`: how long the client may leave a backlog untaken. The clock starts when the
 *   client first falls behind (a write past the response's high-water mark) and is not restarted
 *   by later writes; the client catching up (`drain`) stops it. Once the answer has ended, any of
 *   it not yet flushed is a backlog too, timed the same way, so {@link ClientDelivery.end} always
 *   settles.
 */
export interface ClientDeliveryOptions {
  readonly stallTimeoutMs: number;
  readonly bufferLimitBytes: number;
  /** Called once, just before a client that fell behind is cut off (`destroy()`). */
  readonly onCutOff: (cutOff: ClientCutOff) => void;
}

export type ClientCutOff =
  | { readonly reason: 'stalled'; readonly stallTimeoutMs: number }
  | {
      readonly reason: 'buffer_full';
      readonly bufferLimitBytes: number;
      readonly bufferedBytes: number;
    };

export interface ClientDelivery {
  /** Hands `chunk` to a client still there; never waits. Past the buffer limit, cuts it off. */
  forward(chunk: Uint8Array): void;
  /** Ends the answer; resolves once the client has taken all of it or is gone. */
  end(): Promise<void>;
  /** The client went away, or was cut off, before the whole answer reached it. */
  gone(): boolean;
}

export function deliverToClient(res: Writable, options: ClientDeliveryOptions): ClientDelivery {
  let closedEarly = false;
  res.once('close', () => {
    if (!res.writableFinished) closedEarly = true;
  });
  const gone = (): boolean => closedEarly || (res.destroyed && !res.writableFinished);

  let stallTimer: NodeJS.Timeout | undefined;
  const stopStallClock = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const cutOff = (detail: ClientCutOff): void => {
    stopStallClock();
    if (gone()) return;
    closedEarly = true;
    options.onCutOff(detail);
    res.destroy();
  };
  /** The client has a backlog: start its clock unless one is already running. */
  const startStallClock = (): void => {
    if (stallTimer || gone()) return;
    stallTimer = setTimeout(
      () => cutOff({ reason: 'stalled', stallTimeoutMs: options.stallTimeoutMs }),
      options.stallTimeoutMs,
    );
    stallTimer.unref?.();
  };
  /** While the answer streams, a client that caught up has no backlog left to time. */
  const caughtUp = (): void => stopStallClock();
  res.on('drain', caughtUp);

  return {
    forward(chunk) {
      if (gone()) return;
      if (res.writableLength + chunk.byteLength > options.bufferLimitBytes) {
        cutOff({
          reason: 'buffer_full',
          bufferLimitBytes: options.bufferLimitBytes,
          bufferedBytes: res.writableLength,
        });
        return;
      }
      if (!res.write(chunk)) startStallClock();
    },
    end() {
      // From here on only `finish` (all taken) or `close` (gone) ends the clock: a `drain` can
      // still come while the end of the answer sits unflushed.
      res.off('drain', caughtUp);
      if (!gone()) res.end();
      if (res.writableFinished || gone()) {
        stopStallClock();
        return Promise.resolve();
      }
      startStallClock();
      return new Promise<void>((resolve) => {
        const settle = (): void => {
          stopStallClock();
          res.off('finish', settle);
          res.off('close', settle);
          resolve();
        };
        res.on('finish', settle);
        res.on('close', settle);
      });
    },
    gone,
  };
}
