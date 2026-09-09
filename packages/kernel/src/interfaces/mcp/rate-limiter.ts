/**
 * interfaces/mcp/rate-limiter: a per-Handle request-rate limit for `/mcp` (docs/development-
 * tasks.md S3.6 "Per-Handle rate/size limits as the WS layer has").
 *
 * Honest note on that phrase: `interfaces/ws` (`server.ts`) and `@fastify/websocket`'s own
 * registration in this codebase carry no rate or payload-size limit today (grepped — neither
 * module defines one). `/mcp` is a genuinely new kind of surface for this kernel, though: unlike
 * `/ws` (one long-lived connection per human session, behind the same auth as everything else in
 * the web console) and `/api/cap/*` (already reachable by any Handle, but every existing caller is
 * a platform-managed agent process on the kernel's own compose network), `/mcp` is the first HTTP
 * endpoint explicitly designed for an arbitrary *external* process (Claude Code, a developer's
 * local `pi`) to hold a live, potentially long-lived Handle and hammer it over the public Caddy
 * front door. A minimal in-memory limiter here is a real, in-scope protection for that surface —
 * not an attempt to retrofit a mechanism the WS layer does not actually have.
 *
 * Fixed-window counter, keyed by the calling Handle's `jti` (unique per issued Handle — the same
 * identity `capability_handles`/revocation already key on). Deliberately not a token bucket: a
 * fixed window is simpler, and the "count resets to 0 exactly on the window boundary" imprecision
 * it is famous for is irrelevant here (an MCP client issuing tool calls is not a latency-sensitive
 * bursty stream). Entries are evicted lazily (on next access past their window) rather than by a
 * background timer — this module never starts anything the kernel process would need to `stop()`.
 */

export interface RateLimiterOptions {
  /** Requests allowed per window, per `jti`. Defaults to {@link DEFAULT_MCP_RATE_LIMIT}. */
  readonly limit?: number;
  /** Window length, in milliseconds. Defaults to {@link DEFAULT_MCP_RATE_WINDOW_MS}. */
  readonly windowMs?: number;
  /** Injectable clock — tests only. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface WindowState {
  windowStart: number;
  count: number;
}

/** 60 requests/minute/Handle — generous for interactive tool-call traffic (a human driving Claude
 *  Code or `pi`), well below anything a legitimate client would hit, while still bounding a
 *  runaway/misbehaving one. */
export const DEFAULT_MCP_RATE_LIMIT = 60;
export const DEFAULT_MCP_RATE_WINDOW_MS = 60_000;

export class PerHandleRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, WindowState>();

  constructor(options: RateLimiterOptions = {}) {
    this.limit = options.limit ?? DEFAULT_MCP_RATE_LIMIT;
    this.windowMs = options.windowMs ?? DEFAULT_MCP_RATE_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /** Records one request for `jti`; returns `true` if it is within the current window's limit,
   *  `false` if the caller has already exhausted it (the caller is responsible for rejecting the
   *  request — this method never throws). */
  tryConsume(jti: string): boolean {
    const nowMs = this.now();
    const existing = this.windows.get(jti);
    if (!existing || nowMs - existing.windowStart >= this.windowMs) {
      this.windows.set(jti, { windowStart: nowMs, count: 1 });
      return true;
    }
    if (existing.count >= this.limit) return false;
    existing.count += 1;
    return true;
  }

  /** Test/diagnostic helper — not used on the request path. */
  size(): number {
    return this.windows.size;
  }
}
