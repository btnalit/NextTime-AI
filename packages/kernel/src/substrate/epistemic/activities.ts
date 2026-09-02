import type { PoolClient } from 'pg';

/**
 * substrate/epistemic/activities: minimal Activity start/end so callers elsewhere in this PR
 * (the graph module's integration tests, and eventually chat/task) can obtain an `activity_id`
 * to satisfy I3 ("Fact must have activity_id") before calling `GraphStore.assertFact`
 * (docs/development-tasks.md S1.2: "minimal startActivity/endActivity ... so callers can satisfy
 * I3 (full epistemic module is S1.3)"). Deliberately thin — Observation/Evidence/Conflict/
 * Decision, `explain`, and visibility are S1.3 scope (design doc §7.1 epistemic module).
 *
 * Table: `activities` (migrations/core/0002_substrate.sql, extended by 0003_chat.sql for the
 * `chat_id` FK). `kind`/`status` are intentionally unconstrained by a DB CHECK (see that
 * migration's comment) — this module does not invent an enum for them either, to avoid
 * conflicting with whatever S1.3 settles on.
 *
 * Both functions take an explicit `workspaceId` (not shown in the terse dispatch signature) —
 * see PR body "假设": kept consistent with substrate/graph/sql-store.ts's explicit
 * workspace-binding convention ("RLS already enforces, but still bind workspace_id explicitly")
 * rather than relying only on the `app_workspace()` RLS session GUC.
 */

export interface StartActivityInput {
  readonly kind: string;
  /** `activities.started_by`. */
  readonly principalId?: string;
  /**
   * Not a column on `activities` (no `source_id` FK exists on this table — PROV-O "Activity used
   * Source" is represented by `observations.source_id` + `observations.activity_id`, not here).
   * Recorded under `metadata.sourceId` for now; a full Observation write is S1.3 scope.
   */
  readonly sourceId?: string;
  readonly chatId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ActivityRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly kind: string;
  readonly chatId: string | null;
  readonly sequence: number | null;
  readonly status: string;
  readonly metadata: Record<string, unknown>;
  readonly startedBy: string | null;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

export class ActivityNotFoundError extends Error {
  constructor(workspaceId: string, activityId: string) {
    super(`Activity not found: workspace ${workspaceId}, id ${activityId}`);
    this.name = 'ActivityNotFoundError';
  }
}

interface ActivityDbRow {
  workspace_id: string;
  id: string;
  kind: string;
  chat_id: string | null;
  sequence: number | null;
  status: string;
  metadata: Record<string, unknown>;
  started_by: string | null;
  created_at: Date;
  ended_at: Date | null;
}

function mapActivityRow(row: ActivityDbRow): ActivityRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    kind: row.kind,
    chatId: row.chat_id,
    sequence: row.sequence,
    status: row.status,
    metadata: row.metadata,
    startedBy: row.started_by,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

/** Starts an Activity (`status = 'running'`). */
export async function startActivity(
  client: PoolClient,
  workspaceId: string,
  input: StartActivityInput,
): Promise<ActivityRow> {
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (input.sourceId !== undefined) metadata.sourceId = input.sourceId;

  const result = await client.query<ActivityDbRow>(
    `insert into activities (workspace_id, kind, chat_id, status, metadata, started_by)
     values ($1, $2, $3, 'running', $4::jsonb, $5)
     returning workspace_id, id, kind, chat_id, sequence, status, metadata, started_by, created_at, ended_at`,
    [
      workspaceId,
      input.kind,
      input.chatId ?? null,
      JSON.stringify(metadata),
      input.principalId ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('startActivity: INSERT ... RETURNING produced no row');
  return mapActivityRow(row);
}

/** Ends an Activity: sets `status` (caller-chosen, e.g. `'completed'`/`'failed'`) and `ended_at`. */
export async function endActivity(
  client: PoolClient,
  workspaceId: string,
  id: string,
  status: string,
): Promise<ActivityRow> {
  const result = await client.query<ActivityDbRow>(
    `update activities set status = $3, ended_at = now()
     where workspace_id = $1 and id = $2
     returning workspace_id, id, kind, chat_id, sequence, status, metadata, started_by, created_at, ended_at`,
    [workspaceId, id, status],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ActivityNotFoundError(workspaceId, id);
  return mapActivityRow(row);
}
