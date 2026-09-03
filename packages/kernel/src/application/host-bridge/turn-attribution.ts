import type { PoolClient } from 'pg';

/**
 * application/host-bridge/turn-attribution: the single "which Turn does this happen to belong
 * to" rule, extracted out of `egress-observations.ts` (S1.10) so `governance/llm-usage/service.ts`
 * (S1.7's `turn_id` gap; docs/development-tasks.md S1.7 补注, 2026-09) can reuse the exact same
 * rule instead of inventing a second one — the task brief for that gap is explicit: "reuse this
 * rule, do not invent a second one".
 *
 * The rule (unchanged from egress-observations.ts's original `findAttributionTurn`): prefer the
 * principal's currently `running` `agent_turn` Activity; else fall back to the most recent
 * `agent_turn` (any status) started within `recentTurnWindowMinutes` of `at`; else attribute to
 * nothing. `at` replaces the bare SQL `now()` the original egress-only version used directly in
 * its query — every caller passes `new Date()` at its own call site, which is the same instant
 * `now()` would have evaluated to (both call sites resolve one observation/report at a time, right
 * before querying), so this is a behavior-preserving generalization: making the "what is 'now'"
 * question an explicit input a caller could later override (e.g. to attribute a delayed report
 * against the time it actually happened) rather than always the moment this function runs.
 *
 * `findAttributableTurn` takes an already-resolved `principalId` (egress-observations.ts's own
 * call site parses one straight out of its `entry:<workspaceId>:<principalId>` sourceId).
 * `findAttributableTurnForSession` is the other shape a caller can start from: `llm-usage`'s usage
 * reports only ever carry a `sessionId` (design doc §9.2 `sessions`: `principal_id` is the column
 * that answers "whose Turn is this" — `on_behalf_of` is the I13 Handle-scoping anchor, a different
 * question), so this second function does the one extra `sessions` lookup and then delegates.
 *
 * Cross-module table access (same assumption egress-observations.ts's own doc comment already
 * makes and documents for `activities`): `sessions` is owned by `core`/identity, not
 * `application/host-bridge` — this file reads it directly with parameterized SQL rather than
 * adding a new `substrate`/`core` service method, matching the existing precedent.
 */

/** Default recency window (design doc S1.10 gap note default; docs/development-tasks.md S1.7
 *  补注 reuses the same default for `llm_usage.turn_id`). */
export const DEFAULT_RECENT_TURN_WINDOW_MINUTES = 5;

export interface AttributableTurn {
  readonly id: string;
  /** `true` when this was the principal's currently `running` Turn; `false` when it was the
   *  recency-window fallback. */
  readonly wasRunning: boolean;
}

export interface FindAttributableTurnInput {
  readonly workspaceId: string;
  readonly principalId: string;
  /** The instant to evaluate "recent" from — see module doc comment for why this replaced a bare
   *  `now()`. Callers pass `new Date()` at their own call site. */
  readonly at: Date;
  /** See `DEFAULT_RECENT_TURN_WINDOW_MINUTES`. */
  readonly recentTurnWindowMinutes?: number;
}

/**
 * Finds the Turn to attribute an observation/report to: the principal's currently `running`
 * `agent_turn` first, else the most recent `agent_turn` (any status) started within
 * `recentTurnWindowMinutes` of `at`. Returns `undefined` when neither exists — callers decide for
 * themselves whether that means "drop" (egress-observations.ts) or "record with `turn_id = null`"
 * (governance/llm-usage), never a thrown error; this function's job is only to answer the
 * attribution question, not to decide what "no answer" means for a given caller.
 */
export async function findAttributableTurn(
  client: PoolClient,
  input: FindAttributableTurnInput,
): Promise<AttributableTurn | undefined> {
  const {
    workspaceId,
    principalId,
    at,
    recentTurnWindowMinutes = DEFAULT_RECENT_TURN_WINDOW_MINUTES,
  } = input;

  const running = await client.query<{ id: string }>(
    `select id from activities
     where workspace_id = $1 and started_by = $2 and kind = 'agent_turn' and status = 'running'
     order by created_at desc
     limit 1`,
    [workspaceId, principalId],
  );
  const runningId = running.rows[0]?.id;
  if (runningId) return { id: runningId, wasRunning: true };

  const recent = await client.query<{ id: string }>(
    `select id from activities
     where workspace_id = $1 and started_by = $2 and kind = 'agent_turn'
       and created_at > $3::timestamptz - ($4 || ' minutes')::interval
     order by created_at desc
     limit 1`,
    [workspaceId, principalId, at.toISOString(), recentTurnWindowMinutes],
  );
  const recentId = recent.rows[0]?.id;
  return recentId ? { id: recentId, wasRunning: false } : undefined;
}

export interface FindAttributableTurnForSessionInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly at: Date;
  readonly recentTurnWindowMinutes?: number;
}

/**
 * `sessionId` → `sessions.principal_id` → `findAttributableTurn`. Returns `undefined` both when
 * `sessionId` does not resolve to a session in this workspace (e.g. it was deleted, or belongs to
 * a different workspace than claimed — RLS plus the explicit `workspace_id = $1` bind below both
 * guard against the latter) and when `findAttributableTurn` itself finds nothing — the caller
 * cannot distinguish these, and (per this module's contract above) does not need to: either way
 * there is no Turn to attribute to.
 */
export async function findAttributableTurnForSession(
  client: PoolClient,
  input: FindAttributableTurnForSessionInput,
): Promise<AttributableTurn | undefined> {
  const { workspaceId, sessionId, at, recentTurnWindowMinutes } = input;

  const session = await client.query<{ principal_id: string }>(
    'select principal_id from sessions where workspace_id = $1 and id = $2',
    [workspaceId, sessionId],
  );
  const principalId = session.rows[0]?.principal_id;
  if (!principalId) return undefined;

  // RLS: `activities_visibility` (migrations/core/0003_chat.sql) restricts visible `activities`
  // rows to Chats the transaction's `app.principal_id` owns (or that are workspace-visible) — a
  // real restriction, unlike `sessions`'/`llm_usage`'s workspace-only policies above/in the
  // caller. `client` here may have been opened (`withWorkspace`) under a *different* principalId
  // than the one this function just resolved — `interfaces/http/internal/llm-usage.ts` opens one
  // transaction per report *batch* (which can span several sessions/principals in one workspace),
  // using the batch's first record's `sessionId` as an inert placeholder (see that file's own doc
  // comment) rather than any one record's real principal. `set_config(..., true)` is transaction-
  // scoped (same mechanism `adapters/db/pool.ts`'s `withWorkspace` itself uses, see its own doc
  // comment) — re-pointing it here to the principal actually resolved makes `findAttributableTurn`
  // below see what *that* principal can see, and is safe to call repeatedly (once per session
  // resolved) within one transaction: nothing else this module's callers write in the same
  // transaction (`llm_usage`, `outbox`) has a principal-scoped RLS predicate for this to disturb.
  await client.query("select set_config('app.principal_id', $1, true)", [principalId]);

  return findAttributableTurn(client, { workspaceId, principalId, at, recentTurnWindowMinutes });
}
