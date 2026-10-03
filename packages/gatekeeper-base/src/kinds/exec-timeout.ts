import { TransportTimeoutError } from '../errors.js';

/**
 * R-51: the exec transports (`ssh`, `cli`) bound every command by an exec timeout. Without one, a
 * command that never returns (an ssh command waiting on stdin, a hung CLI) leaks its child process
 * and pins the call's idempotency key as pending forever; the kernel's apply budget
 * (`adapters/gatekeeper-client`'s 60 s) expires first and the call's outcome stays unknown.
 *
 * The default sits below that 60 s budget, so the gate answers — with `TransportTimeoutError`,
 * which `GatekeeperBase.apply` records as an outcome-unknown result for the key — before the
 * kernel gives up on the call.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 50_000;

/**
 * Runs `run`, aborting its `signal` (an exec impl kills the child on abort) and rejecting with
 * `TransportTimeoutError` once `timeoutMs` passes — whether or not `run` honours the signal.
 */
export async function runWithExecTimeout<T>(
  timeoutMs: number,
  what: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('exec timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TransportTimeoutError(
        `${what} timed out after ${timeoutMs} ms and was killed — it may have partially or fully run`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
