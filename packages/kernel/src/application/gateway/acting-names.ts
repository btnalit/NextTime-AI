import type { PoolClient } from 'pg';
import type { AuditRecordRow } from '../../substrate/audit/index.js';

/**
 * application/gateway/acting-names (legacy 666): the name of what an audit row's act came through,
 * where that has one a person would know it by — the Worker a Worker run's Handle ran (its Task's
 * WorkerDefinition, at the version the Task pinned) and the service account a service Handle
 * belongs to (its Principal's `display_name`). Every other channel names no one but the person
 * the row's actor already is (their own session, their entry agent, their admin agent, their own
 * client's Handle) or no one at all (the platform's background work), so it has no name here.
 *
 * One query for a whole page, never one per row, read inside the caller's workspace transaction
 * (the same RLS every table it reads already has). A session it cannot place — gone, or another
 * workspace's — has no name, and the row still says what it came through.
 */
export async function actingNamesOf(
  client: PoolClient,
  workspaceId: string,
  rows: readonly AuditRecordRow[],
): Promise<ReadonlyMap<string, string>> {
  const sessionIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.actingSessionId !== null &&
        (row.actingThrough === 'worker_handle' || row.actingThrough === 'service_handle')
          ? [row.actingSessionId]
          : [],
      ),
    ),
  ];
  if (sessionIds.length === 0) return new Map();
  const result = await client.query<{ id: string; name: string | null }>(
    `select s.id::text as id,
            case s.kind
              when 'worker_run' then (
                select wd.definition ->> 'name'
                  from worker_runs wr
                  join tasks t on t.workspace_id = wr.workspace_id and t.id = wr.task_id
                  join worker_definitions wd
                    on wd.workspace_id = t.workspace_id
                   and wd.id = t.worker_definition_id
                   and wd.version = t.worker_definition_version
                 where wr.workspace_id = s.workspace_id and wr.session_id = s.id
                 limit 1
              )
              when 'service' then (
                select p.display_name
                  from principals p
                 where p.workspace_id = s.workspace_id and p.id = s.principal_id
              )
            end as name
       from sessions s
      where s.workspace_id = $1 and s.id = any($2::uuid[])`,
    [workspaceId, sessionIds],
  );
  const names = new Map<string, string>();
  for (const row of result.rows) {
    if (typeof row.name === 'string' && row.name.trim() !== '') names.set(row.id, row.name);
  }
  return names;
}

/** The name {@link actingNamesOf} found for `row`, or `null`. */
export function actingNameOf(
  names: ReadonlyMap<string, string>,
  row: AuditRecordRow,
): string | null {
  return row.actingSessionId === null ? null : (names.get(row.actingSessionId) ?? null);
}
