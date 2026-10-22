import type { PoolClient } from 'pg';

/**
 * Serializes every change of which Skill or WorkerDefinition version is published in one workspace
 * until the transaction ends (S11 P1-D): `publishSkill` / `deprecateSkill`, `publishWorkerDefinition`
 * / `deprecateWorkerDefinition`, and a ChangePlan segment that installs or rolls back a pack's Skill
 * or Worker (`application/change-plan/family-item.ts`, which plans under it and writes in the same
 * transaction). So a head the plan read is still the head when its item writes, and two Skill
 * families published at once cannot both pass `assertSkillNameAvailable` with the same name.
 *
 * One lock per workspace, not one per family: a segment changes several families, and taking a
 * single lock means no two transactions can take the families' locks in opposite orders. Publishing
 * is a person's occasional act, so the coarser lock costs nothing that matters. Taken before any row
 * lock (`select … for update`) on `skills` / `worker_definitions`; a ChangePlan segment takes the
 * ontology locks (`lockOntologyFamily`) before this one, and nothing that holds this one takes
 * those. Same `pg_advisory_xact_lock(hashtext(...))` convention as `substrate/ontology/namespace.ts`.
 */
export async function lockWorkerRegistry(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `worker_registry:${workspaceId}`,
  ]);
}
