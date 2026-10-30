import type { PoolClient } from 'pg';

/**
 * The workspace's evaluation service Principal (S10 E3-2a; E3 fork 6 = a): what every evaluation
 * Task acts for — never a person, so no person's Grants, quotas or knowledge are involved in a
 * trial, and no person's agent sees an evaluation Task (`taskVisibleTo`: neither theirs nor
 * acting for them). One per workspace, `kind = 'service'`, `role = 'member'`, no API key and no
 * Grant; its `__…__` name marks it internal: off the Members page, and no service Handle is issued
 * for it (`service-handle-handler.ts`), so a Handle acting for it comes only from an evaluation
 * Task's spawn. migrations/task/0011 holds the other half: it acts in evaluation Tasks only.
 */
export const EVALUATION_PRINCIPAL_DISPLAY_NAME = '__evaluation_service__';

/** The evaluation Principal's id, created the first time a workspace runs an evaluation. Two
 *  first trials at once create one: the creation is serialized per workspace. */
export async function getOrCreateEvaluationPrincipal(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const find = async (): Promise<string | undefined> => {
    const found = await client.query<{ id: string }>(
      "select id from principals where workspace_id = $1 and kind = 'service' and display_name = $2 order by created_at limit 1",
      [workspaceId, EVALUATION_PRINCIPAL_DISPLAY_NAME],
    );
    return found.rows[0]?.id;
  };
  const existing = await find();
  if (existing) return existing;
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `evaluation-principal:${workspaceId}`,
  ]);
  const raced = await find();
  if (raced) return raced;
  const inserted = await client.query<{ id: string }>(
    `insert into principals (workspace_id, kind, role, display_name)
     values ($1, 'service', 'member', $2)
     returning id`,
    [workspaceId, EVALUATION_PRINCIPAL_DISPLAY_NAME],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('getOrCreateEvaluationPrincipal: INSERT ... RETURNING produced no row');
  return id;
}
