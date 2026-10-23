import type { PlanStep, StepBinding } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { findSuspectedSecrets, redactedPathsIn } from '../../governance/redaction/index.js';
import { selectPath } from '../../substrate/epistemic/index.js';
import { readStepAttemptOutput } from '../task/index.js';
import type { StepRunRow } from './types.js';

/**
 * application/goal/bindings (S11 GO5d-1; plan §4.5 "步骤之间的数据交接"): the input an attempt of a
 * step starts with — the plan entry's `input` with the values its `bindings` take put in, each from
 * the output the step it names reported with its accepted result (`report_task_result` held that
 * output to the step's `outputSchema`; the Task keeps it in `result.output`). The plan checked
 * the bindings when it was accepted (`plan.ts` `bindingProblems`): each names a step this one
 * depends on, so that step has succeeded or was skipped before this one is ready.
 *
 * Read from the database at the start of every attempt, never from a Worker's message: what an
 * attempt starts with is what the kernel accepted, and a rework (`advance.ts`) binds the same
 * values again. A binding that finds no value — the step it takes from was skipped, or reported no
 * output, or its path selects nothing (JMESPath's `null`) — stops the attempt from starting; so
 * does a value that the credential review counts where it would sit in the input (the call-argument
 * rule a written input is held to when the plan is accepted, `refusePlanCredentials`; a value
 * redacted when its step reported it included). The advancer then pauses the run for a person
 * (`needs_decision`), naming the binding and never the value: the step's Worker would otherwise
 * start without its input, or carry a credential no plan may.
 */

export type AssembledInput =
  | { readonly kind: 'ready'; readonly input: unknown }
  /** Why the attempt cannot start — the pause's detail, naming the binding, never a value. */
  | { readonly kind: 'blocked'; readonly detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A binding as a pause names it: `bindings[0] (input.host from step "a", hosts[0])`. */
function described(step: PlanStep, binding: StepBinding, index: number): string {
  return `step ${step.key}: bindings[${index}] (input.${binding.to} from step ${binding.from}, ${binding.path})`;
}

/** `target` with `value` at the dotted `to`, the objects on the way made (or copied) as needed.
 *  Own properties only, so no field name reaches a prototype (the plan refuses the reserved ones
 *  as well). */
function placeAt(
  target: Record<string, unknown>,
  to: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [field, ...rest] = to as [string, ...string[]];
  const inner = Object.hasOwn(target, field) ? target[field] : undefined;
  const placed = rest.length === 0 ? value : placeAt(isRecord(inner) ? inner : {}, rest, value);
  const copy: Record<string, unknown> = { ...target };
  Object.defineProperty(copy, field, {
    value: placed,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return copy;
}

/**
 * The input attempt of `entry`'s step starts with — see the module comment. `steps` are the run's
 * StepRuns (superseded ones included); the one a binding takes from is the live StepRun of its key.
 */
export async function assembleStepInput(
  client: PoolClient,
  workspaceId: string,
  entry: PlanStep,
  steps: readonly StepRunRow[],
): Promise<AssembledInput> {
  const bindings = entry.bindings ?? [];
  if (bindings.length === 0) return { kind: 'ready', input: entry.input };
  let input: Record<string, unknown> = isRecord(entry.input) ? entry.input : {};
  for (const [index, binding] of bindings.entries()) {
    const where = described(entry, binding, index);
    const from = steps.find(
      (step) => step.stepKey === binding.from && step.status !== 'superseded',
    );
    if (!from || from.status !== 'succeeded') {
      return {
        kind: 'blocked',
        detail: `${where}: step ${binding.from} ${from?.status === 'skipped' ? 'was skipped' : 'has not succeeded'}, so there is no output to take the value from — revise the plan or cancel`,
      };
    }
    const output = await readStepAttemptOutput(client, workspaceId, from.id, from.attemptCount);
    if (!output.found) {
      return {
        kind: 'blocked',
        detail: `${where}: attempt ${from.attemptCount} of step ${binding.from} reported no output — revise the plan or cancel`,
      };
    }
    const selected = selectPath(output.output, binding.path);
    if (!selected.found) {
      return {
        kind: 'blocked',
        detail: `${where}: selects nothing of the output of step ${binding.from}${selected.error ? ` (${selected.error})` : ''} — revise the plan or cancel`,
      };
    }
    // The value where it would sit in the input: under a field named like a secret, the
    // call-argument rule counts what it would not count bare.
    const placed = placeAt({}, binding.to.split('.'), selected.value);
    const suspected = findSuspectedSecrets(placed, { secretFields: true }).count;
    const redacted = redactedPathsIn(selected.value).length > 0;
    if (suspected > 0 || redacted) {
      const why = redacted
        ? `was redacted as a suspected credential when step ${binding.from} reported it`
        : `looks like a credential (${suspected} suspected)`;
      return {
        kind: 'blocked',
        detail: `${where}: the value ${why} — a step's input does not carry credentials; revise the plan or cancel`,
      };
    }
    input = placeAt(input, binding.to.split('.'), selected.value);
  }
  return { kind: 'ready', input };
}
