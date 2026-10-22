import { type FactCheck, type FactObjectRef, type Role, getCapability } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { roleMayUseCapability } from '../../governance/capability/index.js';
import { redactSuspectedSecrets } from '../../governance/redaction/index.js';
import {
  type PredicateEvaluation,
  evaluatePredicate,
  lintPredicate,
} from '../../substrate/epistemic/index.js';
import { factSelectorProblems, predicateCredentialProblems } from './plan.js';

/**
 * application/goal/fact-check (S11 GO4c; plan §4.6, I-G5): an acceptance check the platform judges
 * on a Fact of the graph (`fact_predicate`, `@nexttime/shared` `FactCheck`) — the goal's or a
 * step's. No gate is called: the platform reads the graph for the requester, and the rows, the
 * claim and what a settled check means are `acceptance-check.ts`'s, as for an observation. This
 * module owns the three steps such a check takes, all in the requester's workspace context:
 *
 *   1. {@link prepareFactCheck} — the predicate passes the plan's lint and credential review again
 *      and the Objects it names carry no credential (either may have learned more since the plan
 *      was confirmed), and the requester is enabled and their role may still read Facts
 *      (`list_facts`).
 *   2. {@link readFactEvidence} — the Fact the check may rest on: of the Link it names (its type,
 *      and its two ends — by id, or by ObjectType and identity), one the database takes as
 *      evidence for this goal run and this round (`goal_fact_admissible`, goal/0007: active,
 *      `observed`, last confirmed at or after the round opened through a Source the requester does
 *      not own, by a gate observe no Task of this goal triggered, a gate apply of a request not
 *      raised in this goal, or a collector's submission), the most recently confirmed first.
 *      Read under RLS as the requester: a Fact they cannot see is no evidence.
 *   3. {@link judgeFact} — the predicate over the Fact's own properties, judged on them with
 *      suspected secrets redacted as an observation's result is (`platform-observation.ts`): a
 *      predicate is never an oracle for a value the credential review hides. No predicate: the
 *      Fact being there is the check. A gate's observed Facts carry no properties.
 *
 * The evidence a settled check rests on is the Fact itself (`fact_id`): its content never changes,
 * so the judgement can be made again from the row; the audit row records the outcome.
 */

/** Why a fact check is not made — nothing a retry could change. */
export type FactCheckRefusal =
  | 'predicate_refused'
  | 'credentials_in_predicate'
  | 'credentials_in_fact_selector'
  | 'requester_may_not_read_facts';

/** Step 1 — see the module comment. `null`: the check may be made. */
export async function prepareFactCheck(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  fact: FactCheck,
): Promise<FactCheckRefusal | null> {
  if (fact.expect) {
    if (lintPredicate(fact.expect).length > 0) return 'predicate_refused';
    if (predicateCredentialProblems(fact.expect).length > 0) return 'credentials_in_predicate';
  }
  if (factSelectorProblems(fact).length > 0) return 'credentials_in_fact_selector';
  const principal = await client.query<{ role: Role; disabled: boolean }>(
    `select role, disabled_at is not null as disabled from principals
      where workspace_id = $1 and id = $2`,
    [workspaceId, requesterId],
  );
  const requester = principal.rows[0];
  if (
    !requester ||
    requester.disabled ||
    !roleMayUseCapability(requester.role, getCapability('list_facts'))
  ) {
    return 'requester_may_not_read_facts';
  }
  return null;
}

/** The Fact a check may rest on, and its properties. */
export interface FactEvidence {
  readonly factId: string;
  readonly properties: Record<string, unknown>;
}

/** The Object `ref` names, if it exists and the caller can see it. */
async function resolveObject(
  client: PoolClient,
  workspaceId: string,
  ref: FactObjectRef,
): Promise<string | null> {
  const result =
    'objectId' in ref
      ? await client.query<{ id: string }>(
          'select id from objects where workspace_id = $1 and id = $2',
          [workspaceId, ref.objectId],
        )
      : await client.query<{ id: string }>(
          `select id from objects
            where workspace_id = $1 and object_type = $2 and identity_key = $3::jsonb`,
          [workspaceId, ref.objectType, JSON.stringify(ref.identity)],
        );
  return result.rows[0]?.id ?? null;
}

/** Step 2 — see the module comment. `since`: when the check's round opened (the row's
 *  `created_at`). `null`: no Fact that may serve as evidence. */
export async function readFactEvidence(
  client: PoolClient,
  workspaceId: string,
  input: { readonly goalRunId: string; readonly fact: FactCheck; readonly since: Date },
): Promise<FactEvidence | null> {
  const source = await resolveObject(client, workspaceId, input.fact.source);
  const target = source ? await resolveObject(client, workspaceId, input.fact.target) : null;
  if (!source || !target) return null;
  const result = await client.query<{ id: string; properties: Record<string, unknown> | null }>(
    `select l.id, l.properties
       from links l
       join observations o
         on o.workspace_id = l.workspace_id
        and o.id = coalesce(l.last_observation_id, l.observation_id)
      where l.workspace_id = $1 and l.link_type = $2
        and l.source_object_id = $3 and l.target_object_id = $4
        and l.superseded_at is null and l.invalidated_at is null
        and goal_fact_admissible($1, $5, l.id, $6::jsonb, $7)
      order by o.created_at desc, l.id desc
      limit 1`,
    [
      workspaceId,
      input.fact.linkType,
      source,
      target,
      input.goalRunId,
      JSON.stringify(input.fact),
      input.since,
    ],
  );
  const row = result.rows[0];
  return row ? { factId: row.id, properties: row.properties ?? {} } : null;
}

/** Step 3 — see the module comment. */
export function judgeFact(fact: FactCheck, evidence: FactEvidence): PredicateEvaluation {
  if (!fact.expect) return { outcome: 'satisfied', undetermined: [] };
  const redacted = redactSuspectedSecrets(evidence.properties, { secretFields: true }).value;
  return evaluatePredicate(fact.expect, redacted);
}
