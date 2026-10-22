import type { PoolClient } from 'pg';

/**
 * substrate/graph/type-usage: how much of the graph uses some ontology type names — what a change
 * that takes those types out of the ontology leaves without a declaration (S11 P1-B: rolling back a
 * ChangePlan segment, `application/change-plan`). The rows stay (S10 I-P4); a person deciding on
 * the change reads these counts first.
 *
 * Counts stop at `cap` (a dry run must stay cheap on a large graph — neither column is indexed);
 * `capped` says one of them reached it. Links are active Facts only (not superseded or
 * invalidated), the ones a reader still sees.
 */
export interface GraphTypeUsage {
  readonly objects: number;
  readonly links: number;
  readonly capped: boolean;
}

export async function countGraphTypeUsage(
  client: PoolClient,
  workspaceId: string,
  types: { readonly objectTypes: readonly string[]; readonly linkTypes: readonly string[] },
  cap: number,
): Promise<GraphTypeUsage> {
  const objects =
    types.objectTypes.length === 0
      ? 0
      : await countUpTo(
          client,
          `select 1 from objects
            where workspace_id = $1 and object_type = any($2::text[])
            limit $3`,
          [workspaceId, [...types.objectTypes], cap],
        );
  const links =
    types.linkTypes.length === 0
      ? 0
      : await countUpTo(
          client,
          `select 1 from links
            where workspace_id = $1 and link_type = any($2::text[])
              and superseded_at is null and invalidated_at is null
            limit $3`,
          [workspaceId, [...types.linkTypes], cap],
        );
  return { objects, links, capped: objects >= cap || links >= cap };
}

async function countUpTo(client: PoolClient, rows: string, params: unknown[]): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::bigint as count from (${rows}) counted`,
    params,
  );
  return Number(result.rows[0]?.count ?? 0);
}
