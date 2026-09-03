import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { DEFAULT_RECENT_TURN_WINDOW_MINUTES, findAttributableTurn } from './turn-attribution.js';

/**
 * application/host-bridge/egress-observations: turns `packages/egress-proxy`'s batched egress
 * reports into per-Turn `activities.metadata.egress` entries and `EgressObserved` domain events
 * (design doc §7.9 "记录每个目标域名与字节数到该次 Activity 的 metadata", §7.10 `EgressObserved`;
 * docs/development-tasks.md S1.10 kernel gap — `POST /internal/egress` did not exist before this
 * task; S1.5/S1.11 note the wire shape lives in `packages/egress-proxy/src/report.ts`, unresolved
 * until now). `interfaces/http/internal/egress.ts` is this module's only caller.
 *
 * `sourceId` format (`entry:<workspaceId>:<principalId>`): fixed by `packages/worker-supervisor/
 * src/egress-map.ts`'s `entrySourceId()` (S1.5a), which is also what registers it into
 * `egress-proxy`'s `SOURCE_MAP_FILE` for every entry container it spawns. `egress-proxy` itself
 * treats the whole string as opaque (`report.ts`'s own doc comment: "turning a sourceId into a
 * WorkerRun/entry-session Activity is the kernel host-bridge's job") — this file is that job.
 * `worker`-run sourceIds (a distinct, not-yet-defined format — S2.8) are out of scope; the only
 * format recognized here is the `entry:` one, matching every sourceId `egress-proxy` can produce
 * in S1 (resident/entry spawns are the only kind `worker-supervisor` registers before S2).
 *
 * Cross-module table access (assumption — see PR body "假设与偏离", same deviation `application/
 * gateway/handlers.ts`'s `reportTurnHandler` and `substrate/epistemic/explain.ts` already make and
 * document): `activities` is owned by `substrate/epistemic`, but this task's ownership permits
 * adding to `application/host-bridge` only, not `substrate/epistemic/activities.ts` — so the
 * "find the principal's running Turn" read and the `metadata.egress` append below are direct,
 * parameterized SQL against `activities`, not a new substrate method. `outbox` writes still go
 * through the one sanctioned path, `substrate/outbox/enqueue()` (§7.10: "There must be exactly
 * one[write path]").
 *
 * Attribution when no Turn is currently running (task brief: "record it under the principal's
 * most recent agent_turn within the last N minutes, or drop with a log line — state the choice"):
 * this module attributes to the most recent `agent_turn` (any status) started within
 * `recentTurnWindowMinutes` (default 5) rather than dropping — see `turn-attribution.ts`'s
 * `findAttributableTurn` for the rule itself (extracted out to a sibling module, 2026-09,
 * docs/development-tasks.md S1.7 补注, so `governance/llm-usage` can reuse the identical rule for
 * `llm_usage.turn_id` rather than inventing a second one; purely a lift-and-shift, this module's
 * own behavior is unchanged). Rationale: `egress-proxy`'s
 * `EgressReporter` batches and backs off (report.ts: 2s base, up to 60s) before a decision ever
 * reaches this route, so a fast Turn (the fake-LLM path completes in well under a second) will
 * routinely have already ended by the time its own egress traffic is reported — dropping would
 * silently lose the one thing §7.9 exists to prove ("目标域名出现在 Activity"). Losing provenance
 * outright is a worse failure mode for an audit-adjacent feature than attributing to a
 * recently-ended Turn; the bounded window keeps this from ever reaching back to a stale,
 * unrelated one. A batch that still matches no Turn at all (nothing running or recent) is dropped
 * with a `warn` log line, never a thrown error — this is best-effort telemetry, not the primary
 * write path for anything (matches egress-proxy's own reporter: fire-and-log, never blocks a
 * caller).
 *
 * One `EgressObserved` event per attributed observation, not one per HTTP batch (assumption — the
 * task brief's "one ... event ... per observation batch" is read as "for each observation in the
 * batch", not "one combined event for the whole batch"): `packages/shared/src/events.ts`'s
 * `EgressObservedEvent` shape (`{workspaceId, activityId, domain, bytes?}`) has exactly one
 * `domain` and one `activityId` — it cannot represent several observations (possibly several
 * hostnames, possibly several Turns) folded into one event without inventing a new event shape,
 * which is out of this task's ownership (`packages/shared` is domain-layer, shared by every
 * consumer). An observation that is skipped (unrecognized `sourceId`, or no Turn to attribute to)
 * enqueues no event — there is no `activityId` to put in one.
 *
 * Bounded `metadata.egress` array (task brief: "keep the array bounded, e.g. last 200 entries"):
 * enforced inside the same `UPDATE` that appends, via `jsonb_array_elements(...) WITH ORDINALITY`
 * trimmed to the last `MAX_EGRESS_ENTRIES` — not read-then-trim-then-write in application code,
 * which would race against a concurrent append to the same running Turn (egress-proxy's own
 * batches can overlap in flight). A single `UPDATE ... SET metadata = ...` sees one consistent
 * "before" snapshot of the row for every expression in its `SET` list, and Postgres's normal
 * per-row write lock serializes two concurrent `UPDATE`s to the same Activity row — so this is
 * safe under concurrent flushes with no extra locking of its own.
 */

export interface EgressObservationInput {
  /** `entry:<workspaceId>:<principalId>` (or any other format — unrecognized ones are skipped,
   *  see `parseEntrySourceId`). */
  readonly sourceId: string;
  readonly hostname: string;
  readonly port: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly allowed: boolean;
  readonly reason?: string;
  /** ISO 8601 timestamp — `egress-proxy`'s own `observedAt` (`new Date().toISOString()`). */
  readonly at: string;
}

export interface RecordEgressObservationsDeps {
  readonly pool: PoolLike;
  /** See module doc "Attribution when no Turn is currently running". Default 5. */
  readonly recentTurnWindowMinutes?: number;
  /** Injectable for tests. Defaults to a structured `console.log`/`console.warn` line — never
   *  throws, never blocks. */
  readonly log?: (level: 'info' | 'warn', line: Record<string, unknown>) => void;
}

export interface RecordEgressObservationsResult {
  /** Observations that were appended to a running Turn's `metadata.egress`. */
  readonly attributedToRunningTurn: number;
  /** Observations that were appended to a recently-ended Turn (the fallback window). */
  readonly attributedToRecentTurn: number;
  /** `sourceId` did not match the recognized `entry:<workspaceId>:<principalId>` format. */
  readonly skippedUnknownSource: number;
  /** No running or recent-enough `agent_turn` Activity existed to attribute the observation to. */
  readonly skippedNoTurn: number;
}

/** Task brief: "keep the array bounded, e.g. last 200 entries". */
const MAX_EGRESS_ENTRIES = 200;

/** `entry:<workspaceId>:<principalId>` — both halves are UUIDs (every workspace/principal id in
 *  this codebase is `gen_random_uuid()`), so a plain UUID-shaped check is enough to reject
 *  garbage before ever opening a transaction, without hand-rolling a full UUID parser. */
const ENTRY_SOURCE_ID_PATTERN =
  /^entry:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface EntrySource {
  readonly workspaceId: string;
  readonly principalId: string;
}

function parseEntrySourceId(sourceId: string): EntrySource | undefined {
  const match = ENTRY_SOURCE_ID_PATTERN.exec(sourceId);
  const workspaceId = match?.[1];
  const principalId = match?.[2];
  if (!workspaceId || !principalId) return undefined;
  return { workspaceId, principalId };
}

/** Appends one entry to `activities.metadata.egress`, trimming to the last `MAX_EGRESS_ENTRIES`
 *  in the same statement (see module doc "Bounded metadata.egress array"). */
async function appendEgressEntry(
  client: PoolClient,
  workspaceId: string,
  activityId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `update activities
     set metadata = jsonb_set(
       metadata,
       '{egress}',
       coalesce(
         (
           select jsonb_agg(elem order by ord)
           from jsonb_array_elements(coalesce(metadata->'egress', '[]'::jsonb) || $3::jsonb)
             with ordinality as t(elem, ord)
           where ord > greatest(
             jsonb_array_length(coalesce(metadata->'egress', '[]'::jsonb) || $3::jsonb) - $4,
             0
           )
         ),
         '[]'::jsonb
       )
     )
     where workspace_id = $1 and id = $2`,
    [workspaceId, activityId, JSON.stringify([entry]), MAX_EGRESS_ENTRIES],
  );
}

function defaultLog(level: 'info' | 'warn', line: Record<string, unknown>): void {
  const payload = JSON.stringify({ level, msg: 'egress-observations', ...line });
  if (level === 'warn') console.warn(payload);
  else console.log(payload);
}

/**
 * Records one batch of egress observations: for each, resolves `sourceId` to a
 * `(workspaceId, principalId)`, finds the Turn to attribute it to, appends it to that Turn's
 * `metadata.egress`, and enqueues one `EgressObserved` domain event. Never throws for a
 * per-observation outcome that is a normal, expected case (unrecognized `sourceId`, no Turn to
 * attribute to) — those are counted and logged instead. A genuine failure (e.g. the database is
 * unreachable) *does* propagate, so the caller (the HTTP route) can 500 and let `egress-proxy`'s
 * own retry-with-backoff (report.ts) redeliver the whole batch — the same contract
 * `interfaces/http/internal/llm-usage.ts` already establishes for its own batch endpoint.
 */
export async function recordEgressObservations(
  deps: RecordEgressObservationsDeps,
  observations: readonly EgressObservationInput[],
): Promise<RecordEgressObservationsResult> {
  const log = deps.log ?? defaultLog;
  const recentTurnWindowMinutes =
    deps.recentTurnWindowMinutes ?? DEFAULT_RECENT_TURN_WINDOW_MINUTES;

  let attributedToRunningTurn = 0;
  let attributedToRecentTurn = 0;
  let skippedUnknownSource = 0;
  let skippedNoTurn = 0;

  for (const observation of observations) {
    const source = parseEntrySourceId(observation.sourceId);
    if (!source) {
      skippedUnknownSource++;
      log('warn', {
        msg: 'unrecognized egress sourceId format, skipping',
        sourceId: observation.sourceId,
      });
      continue;
    }
    const { workspaceId, principalId } = source;

    const turn = await withWorkspace(deps.pool, { workspaceId, principalId }, async (client) => {
      const attribution = await findAttributableTurn(client, {
        workspaceId,
        principalId,
        at: new Date(),
        recentTurnWindowMinutes,
      });
      if (!attribution) return undefined;

      const entry: Record<string, unknown> = {
        hostname: observation.hostname,
        port: observation.port,
        bytesIn: observation.bytesIn,
        bytesOut: observation.bytesOut,
        allowed: observation.allowed,
        reason: observation.reason,
        at: observation.at,
      };
      await appendEgressEntry(client, workspaceId, attribution.id, entry);
      await enqueue(client, {
        type: 'EgressObserved',
        workspaceId,
        activityId: attribution.id,
        domain: observation.hostname,
        bytes: observation.bytesIn + observation.bytesOut,
      });

      return attribution;
    });

    if (!turn) {
      skippedNoTurn++;
      log('warn', {
        msg: 'no running or recent agent_turn to attribute egress observation to, dropping',
        workspaceId,
        principalId,
        hostname: observation.hostname,
      });
      continue;
    }

    if (turn.wasRunning) attributedToRunningTurn++;
    else attributedToRecentTurn++;
  }

  return { attributedToRunningTurn, attributedToRecentTurn, skippedUnknownSource, skippedNoTurn };
}
