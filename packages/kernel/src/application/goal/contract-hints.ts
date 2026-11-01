import { type GoalPlan, type PlanHint, validateOutput } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type WorkerContract, workerContractOf, workerRefKey } from '../task/index.js';
import { getWorkerDefinition } from '../worker/index.js';

/**
 * application/goal/contract-hints (S11 GO13; plan §4.12, forks F1 = A, F2 = A): what a plan's
 * steps leave out of, or do not meet in, the contracts their Workers declare (`inputSchema` /
 * `outputSchema` on a `worker` WorkerDefinition version, `@nexttime/shared` worker-definition.ts).
 *
 * Advice, never a refusal, and never what decides whether a step starts: only a step's own
 * `outputSchema` holds its output to a contract (the requester confirms what is in force — no
 * contract is inherited from the Worker), and a step's input is the plan's. So:
 *   - `step_output_contract_unused`: the Worker declares an output contract and the step sets no
 *     `outputSchema` — its output is not checked and no later step can bind to it;
 *   - `step_input_mismatch`: a step without `bindings` (its input is all in the plan; a bound one
 *     is assembled when an attempt starts) whose `input` does not match the Worker's
 *     `inputSchema` — the places, by the one validator a step's output is checked by, never the
 *     values.
 * A step's WorkerDefinition version is pinned and its content frozen, so these do not change while
 * the plan does not; a version not there or not `worker`-kind is another hint's
 * (`step_worker_unavailable`) or the plan's validation's. Not part of the confirmation card's
 * authority check (`precheck.ts`) nor of how a planner revision is classified
 * (`revision-class.ts`): a step a contract hint is about starts as any other.
 */
export async function planContractHints(
  client: PoolClient,
  workspaceId: string,
  plan: GoalPlan,
): Promise<readonly PlanHint[]> {
  const hints: PlanHint[] = [];
  const contracts = new Map<string, WorkerContract | null>();
  for (const step of plan.steps) {
    const key = workerRefKey(step.worker);
    let contract = contracts.get(key);
    if (contract === undefined) {
      // One client, one query at a time: each pinned version read once.
      const definition = await getWorkerDefinition(client, workspaceId, step.worker);
      contract =
        definition && definition.kind === 'worker' ? workerContractOf(definition.definition) : null;
      contracts.set(key, contract);
    }
    if (contract === null) continue;
    if (contract.outputSchema !== undefined && step.outputSchema === undefined) {
      hints.push({
        code: 'step_output_contract_unused',
        message: `step "${step.key}": its Worker declares an output contract the step does not set — its output is not checked and no later step can bind to it; to use it, set the step's outputSchema to the Worker's`,
        stepKey: step.key,
      });
    }
    if (contract.inputSchema !== undefined && (step.bindings ?? []).length === 0) {
      const { problems, problemCount } = validateOutput(contract.inputSchema, step.input, 'input');
      const first = problems[0];
      if (first !== undefined) {
        hints.push({
          code: 'step_input_mismatch',
          message: `step "${step.key}": its input does not match its Worker's input contract (${problemCount} ${problemCount === 1 ? 'place' : 'places'}, first at ${first.path}: ${first.message}) — the Worker may not do what the step asks`,
          stepKey: step.key,
          inputProblems: problems.map((problem) => ({ ...problem })),
          inputProblemCount: problemCount,
        });
      }
    }
  }
  return hints;
}
