/**
 * admin-limits: a per-administrator bound on the admin routes that call an upstream provider —
 * `POST /providers/:id/test`, `POST /model-discovery` and `POST /model-probe` (admin-api.ts).
 * Each of those spends the provider key on real upstream calls (`/model-probe`: up to three per
 * model, six models per request), and the console fires them automatically as the administrator
 * ticks models — so a stuck key, a scripted loop or a stolen five-minute token could otherwise
 * run up the provider bill or get the key rate-limited upstream.
 *
 * Two limits per actor (the token's `sub`):
 *   - concurrency: at most `maxConcurrent` such requests run at once; up to `maxQueued` more wait
 *     their turn in order (the console's back-to-back ticks queue instead of failing); beyond
 *     that the request is refused as `busy`;
 *   - budget: at most `budget` upstream calls are started within any `windowMs`. A request is
 *     charged its worst-case call count when it starts; one that would exceed the window's
 *     budget is refused as `budget` with the seconds until enough of it frees up.
 * A refused request never reaches the upstream. Nothing is shared across actors, and the state is
 * in memory only — a restart clears it, which is the same as the window passing.
 */

export interface UpstreamCallLimits {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly budget: number;
  readonly windowMs: number;
}

/** The defaults: one console session checks two things at a time, queues a few more, and starts
 *  at most sixty upstream calls a minute — a discovery, ten models probed one by one, a full
 *  six-model probe and a save-and-test fit with room to spare. */
export const DEFAULT_UPSTREAM_CALL_LIMITS: UpstreamCallLimits = {
  maxConcurrent: 2,
  maxQueued: 4,
  budget: 60,
  windowMs: 60_000,
};

export class UpstreamCallLimitError extends Error {
  readonly reason: 'busy' | 'budget';
  readonly retryAfterSeconds: number;

  constructor(reason: 'busy' | 'budget', retryAfterSeconds: number, message: string) {
    super(message);
    this.name = 'UpstreamCallLimitError';
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface ActorState {
  running: number;
  readonly waiting: Array<() => void>;
  /** Start time and cost of each charge still inside the window, oldest first. */
  readonly charges: Array<{ at: number; cost: number }>;
}

export interface UpstreamCallLimiter {
  /** Runs `fn` under `actor`'s limits, charging `cost` upstream calls. Throws
   *  {@link UpstreamCallLimitError} (without calling `fn`) when the actor is over either limit. */
  run<T>(actor: string, cost: number, fn: () => Promise<T>): Promise<T>;
}

export function createUpstreamCallLimiter(
  limits: UpstreamCallLimits = DEFAULT_UPSTREAM_CALL_LIMITS,
  now: () => number = Date.now,
): UpstreamCallLimiter {
  const actors = new Map<string, ActorState>();

  function stateOf(actor: string): ActorState {
    let state = actors.get(actor);
    if (!state) {
      state = { running: 0, waiting: [], charges: [] };
      actors.set(actor, state);
    }
    return state;
  }

  function forgetIfIdle(actor: string, state: ActorState): void {
    if (state.running === 0 && state.waiting.length === 0 && state.charges.length === 0) {
      actors.delete(actor);
    }
  }

  /** Charges `cost` now, or throws when the window cannot take it. */
  function charge(state: ActorState, cost: number): void {
    const at = now();
    while (state.charges.length > 0 && (state.charges[0]?.at ?? 0) <= at - limits.windowMs) {
      state.charges.shift();
    }
    const spent = state.charges.reduce((sum, c) => sum + c.cost, 0);
    if (spent + cost > limits.budget) {
      // The earliest moment enough of the window has rolled off for this request to fit.
      let freed = limits.budget - spent;
      let retryAt = at + limits.windowMs;
      for (const c of state.charges) {
        freed += c.cost;
        if (freed >= cost) {
          retryAt = c.at + limits.windowMs;
          break;
        }
      }
      throw new UpstreamCallLimitError(
        'budget',
        Math.max(1, Math.ceil((retryAt - at) / 1000)),
        `too many provider checks in the last ${Math.round(limits.windowMs / 1000)} s — at most ${limits.budget} upstream calls per administrator`,
      );
    }
    state.charges.push({ at, cost });
  }

  return {
    async run<T>(actor: string, cost: number, fn: () => Promise<T>): Promise<T> {
      const state = stateOf(actor);
      if (state.running >= limits.maxConcurrent) {
        if (state.waiting.length >= limits.maxQueued) {
          throw new UpstreamCallLimitError(
            'busy',
            5,
            `${limits.maxConcurrent + limits.maxQueued} provider checks are already running or waiting for this administrator`,
          );
        }
        await new Promise<void>((resolve) => state.waiting.push(resolve));
      } else {
        state.running += 1;
      }
      // Here this request holds a running slot (taken above, or handed over by the one before).
      try {
        charge(state, cost);
        return await fn();
      } finally {
        const next = state.waiting.shift();
        if (next) next();
        else state.running -= 1;
        forgetIfIdle(actor, state);
      }
    },
  };
}
