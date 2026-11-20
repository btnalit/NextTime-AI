import {
  DEFAULT_TASK_TOOL_CALLS_LIMIT,
  MAX_TASK_TOOL_CALLS_LIMIT,
  MAX_WORKER_RUN_TOOL_CALL_RECORDS,
  type ToolCallMessageContent,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * application/task/tool-calls (legacy 155): the tool calls a Worker reported for its run
 * (`report_tool_calls`), kept in `worker_run_tool_calls` (migrations/task/0016) — one record per
 * call id per WorkerRun, the first write kept, at most {@link MAX_WORKER_RUN_TOOL_CALL_RECORDS} per
 * run, never changed after (the application role holds no update or delete grant on the table).
 * The records come here already built and redacted (application/gateway's
 * `reportToolCallsHandler`, with the chat module's `buildToolCallRecord`); this module only keeps
 * and reads them.
 */

export interface StoredToolCallCounts {
  /** Records written by this call. */
  readonly stored: number;
  /** Calls whose id the run already had a record for (or that came twice in this call): the first
   *  record is kept. */
  readonly alreadyStored: number;
  /** Calls not stored because the run already holds its bound of records. */
  readonly overLimit: number;
}

/**
 * Stores `records` (each a tool-call record, `content.toolCallId` its id) for `workerRunId`, in
 * order, numbering each after the run's last. One report at a time per run (an advisory lock on
 * the run, held to the end of the transaction), so the numbering and the bound hold however the
 * runtime's reports overlap.
 */
export async function storeWorkerToolCalls(
  client: PoolClient,
  workspaceId: string,
  workerRunId: string,
  records: readonly ToolCallMessageContent[],
): Promise<StoredToolCallCounts> {
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `worker_run_tool_calls:${workerRunId}`,
  ]);
  const held = await client.query<{ last: number }>(
    `select coalesce(max(sequence), 0)::int as last from worker_run_tool_calls
      where workspace_id = $1 and worker_run_id = $2`,
    [workspaceId, workerRunId],
  );
  const known = await client.query<{ tool_call_id: string }>(
    `select tool_call_id from worker_run_tool_calls
      where workspace_id = $1 and worker_run_id = $2 and tool_call_id = any($3::text[])`,
    [workspaceId, workerRunId, records.map((record) => record.toolCallId)],
  );
  const seen = new Set(known.rows.map((row) => row.tool_call_id));
  let next = (held.rows[0]?.last ?? 0) + 1;
  let stored = 0;
  let alreadyStored = 0;
  let overLimit = 0;
  for (const record of records) {
    if (seen.has(record.toolCallId)) {
      alreadyStored += 1;
      continue;
    }
    if (next > MAX_WORKER_RUN_TOOL_CALL_RECORDS) {
      overLimit += 1;
      continue;
    }
    await client.query(
      `insert into worker_run_tool_calls (workspace_id, worker_run_id, tool_call_id, sequence, content)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [workspaceId, workerRunId, record.toolCallId, next, JSON.stringify(record)],
    );
    seen.add(record.toolCallId);
    next += 1;
    stored += 1;
  }
  return { stored, alreadyStored, overLimit };
}

export interface WorkerToolCallRow {
  readonly workerRunId: string;
  readonly sequence: number;
  readonly reportedAt: Date;
  readonly content: ToolCallMessageContent;
}

export interface TaskToolCallsPage {
  readonly items: readonly WorkerToolCallRow[];
  /** Set when the Task has more records than this page holds. */
  readonly nextCursor?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(row: WorkerToolCallRow): string {
  return Buffer.from(`${row.workerRunId}|${row.sequence}`, 'utf8').toString('base64url');
}

/** The record a page starts after, or `null` — for a cursor this module did not make, too, which
 *  reads from the first record (as `list_tasks` treats one). */
function decodeCursor(
  cursor: string | undefined,
): { readonly workerRunId: string; readonly sequence: number } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [workerRunId, sequence, ...rest] = decoded.split('|');
  if (rest.length > 0 || !workerRunId || !UUID_PATTERN.test(workerRunId)) return null;
  const number = Number(sequence);
  if (!Number.isInteger(number) || number < 1) return null;
  return { workerRunId, sequence: number };
}

/**
 * A page of the records of every WorkerRun of `taskId`: the runs in the order they started, each
 * run's records in the order reported. Who may read the Task is the caller's to check first
 * (`getTaskVisibleTo`); this reads under the workspace's row security only.
 */
export async function listTaskToolCalls(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
  options: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<TaskToolCallsPage> {
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_TASK_TOOL_CALLS_LIMIT, 1),
    MAX_TASK_TOOL_CALLS_LIMIT,
  );
  const after = decodeCursor(options.cursor);
  const result = await client.query<{
    worker_run_id: string;
    sequence: number;
    reported_at: Date;
    content: ToolCallMessageContent;
  }>(
    `select c.worker_run_id, c.sequence, c.reported_at, c.content
       from worker_run_tool_calls c
       join worker_runs r on r.workspace_id = c.workspace_id and r.id = c.worker_run_id
      where c.workspace_id = $1 and r.task_id = $2
        and (
          $3::uuid is null
          or (r.started_at, r.id, c.sequence) > (
            select a.started_at, a.id, $4::int from worker_runs a
             where a.workspace_id = $1 and a.id = $3::uuid
          )
        )
      order by r.started_at, r.id, c.sequence
      limit $5`,
    [workspaceId, taskId, after?.workerRunId ?? null, after?.sequence ?? null, limit + 1],
  );
  const rows = result.rows.map(
    (row): WorkerToolCallRow => ({
      workerRunId: row.worker_run_id,
      sequence: row.sequence,
      reportedAt: row.reported_at,
      content: row.content,
    }),
  );
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return rows.length > limit && last ? { items, nextCursor: encodeCursor(last) } : { items };
}
