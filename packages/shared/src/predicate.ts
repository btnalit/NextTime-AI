import { z } from 'zod';

/**
 * predicate (S11 GO3d; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §4.6, §4.7): what
 * the platform expects to see in the result of an observation, written as data so a person can read
 * it on a card ("在 X 门上观察 Y，期望 Z") and the kernel can judge it without a model.
 *
 * A predicate is a tree:
 *   - a **leaf** reads one value out of the observation's result with a JMESPath `path` and tests
 *     it: `exists` (the path yields something other than null), or a comparison with `value` —
 *     `eq` / `ne` (JSON equality), `gt` / `gte` / `lt` / `lte` (both numbers, or both strings:
 *     ISO timestamps compare as text), `contains` (an array holding `value`, or a string holding
 *     the string `value`);
 *   - `all` / `any` / `not` combine predicates.
 *
 * This module is the shape only — what is stored in a plan and shown to people. The engine (JMESPath
 * evaluation, the three-valued result, the check that refuses a predicate that is true without
 * seeing anything) is the kernel's (`substrate/epistemic/predicate.ts`): the console and the wire
 * never evaluate one. The limits keep a predicate readable on a confirmation card and cheap to judge.
 *
 * {@link ObservationCheckSchema} pairs a predicate with the observation it judges — an observe-class
 * Operation on a Gatekeeper and its params, the same three fields `observe_operation` takes. A goal
 * step declares one per action it may need reconciled (GO3d); the acceptance checks reuse it (GO4,
 * `observe_predicate`).
 *
 * {@link FactCheckSchema} (S11 GO4c, `fact_predicate`) pairs an optional predicate with a Fact of
 * the graph instead: the Link of `linkType` from the `source` Object to the `target` one, each
 * named by id or by its ObjectType and identity, and what the Fact's own properties must satisfy
 * (none: the Fact being there is the check). Which Facts may serve as evidence — observed, recently, not
 * by the goal itself — is the kernel's (`application/goal/fact-check.ts`, goal/0007).
 */

export const PREDICATE_COMPARE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
export type PredicateCompareOp = (typeof PREDICATE_COMPARE_OPS)[number];
/** The comparisons that order their operands: both numbers, or both strings. */
export const PREDICATE_ORDER_OPS: readonly PredicateCompareOp[] = ['gt', 'gte', 'lt', 'lte'];

/** The longest JMESPath expression a leaf takes, in characters. */
export const PREDICATE_PATH_MAX = 512;
/** The largest `value` a leaf takes, serialized as JSON, in bytes. */
export const PREDICATE_VALUE_MAX_BYTES = 4096;
/** How deep `all` / `any` / `not` nest (a leaf alone is depth 0). */
export const PREDICATE_MAX_NESTING = 4;
/** How many leaves one predicate has at most. */
export const PREDICATE_MAX_LEAVES = 32;
/** How many predicates one `all` / `any` combines at most. */
export const PREDICATE_MAX_CHILDREN = 16;

export type PredicateJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PredicateJsonValue[]
  | { readonly [key: string]: PredicateJsonValue };

export type PredicateLeaf =
  | { readonly path: string; readonly op: 'exists' }
  | { readonly path: string; readonly op: PredicateCompareOp; readonly value: PredicateJsonValue };

export type Predicate =
  | PredicateLeaf
  | { readonly all: readonly Predicate[] }
  | { readonly any: readonly Predicate[] }
  | { readonly not: Predicate };

/** Whether `value` is plain JSON (what `JSON.parse` yields): no `undefined`, functions, non-finite
 *  numbers or class instances. */
export function isPredicateJsonValue(value: unknown): value is PredicateJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPredicateJsonValue);
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every(isPredicateJsonValue);
  }
  return false;
}

const PredicatePathSchema = z.string().trim().min(1).max(PREDICATE_PATH_MAX);

const PredicateValueSchema = z.custom<PredicateJsonValue>(
  (value) => value !== undefined && isPredicateJsonValue(value),
  { message: 'value must be a JSON value' },
);

const ExistsLeafSchema = z.object({ path: PredicatePathSchema, op: z.literal('exists') }).strict();

const CompareLeafSchema = z
  .object({
    path: PredicatePathSchema,
    op: z.enum(PREDICATE_COMPARE_OPS),
    value: PredicateValueSchema,
  })
  .strict()
  .superRefine((leaf, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(leaf.value)).length > PREDICATE_VALUE_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `value is larger than ${PREDICATE_VALUE_MAX_BYTES} bytes`,
      });
    }
    if (
      PREDICATE_ORDER_OPS.includes(leaf.op) &&
      typeof leaf.value !== 'number' &&
      typeof leaf.value !== 'string'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${leaf.op} compares with a number or a string`,
      });
    }
  });

const PredicateNodeSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    ExistsLeafSchema,
    CompareLeafSchema,
    z.object({ all: z.array(PredicateNodeSchema).min(1).max(PREDICATE_MAX_CHILDREN) }).strict(),
    z.object({ any: z.array(PredicateNodeSchema).min(1).max(PREDICATE_MAX_CHILDREN) }).strict(),
    z.object({ not: PredicateNodeSchema }).strict(),
  ]),
);

/** The leaves of `predicate`, in order. */
export function predicateLeaves(predicate: Predicate): readonly PredicateLeaf[] {
  if ('all' in predicate) return predicate.all.flatMap(predicateLeaves);
  if ('any' in predicate) return predicate.any.flatMap(predicateLeaves);
  if ('not' in predicate) return predicateLeaves(predicate.not);
  return [predicate];
}

function nesting(predicate: Predicate): number {
  if ('all' in predicate) return 1 + Math.max(...predicate.all.map(nesting));
  if ('any' in predicate) return 1 + Math.max(...predicate.any.map(nesting));
  if ('not' in predicate) return 1 + nesting(predicate.not);
  return 0;
}

export const PredicateSchema: z.ZodType<Predicate> = PredicateNodeSchema.superRefine(
  (predicate, ctx) => {
    if (nesting(predicate) > PREDICATE_MAX_NESTING) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `all / any / not nest at most ${PREDICATE_MAX_NESTING} deep`,
      });
    }
    if (predicateLeaves(predicate).length > PREDICATE_MAX_LEAVES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a predicate has at most ${PREDICATE_MAX_LEAVES} leaves`,
      });
    }
  },
);

/** An Operation name as `observe_operation` takes it. */
const OperationNameSchema = z.string().min(1).max(200);

/** An observe-class Operation on a Gatekeeper, its params, and what its result must satisfy. */
export const ObservationCheckSchema = z
  .object({
    gatekeeperId: z.guid(),
    operation: OperationNameSchema,
    params: z.record(z.string(), z.unknown()).optional(),
    expect: PredicateSchema,
  })
  .strict();
export type ObservationCheck = z.infer<typeof ObservationCheckSchema>;

/**
 * S11 「门确认不存在」 B: an observe-class Operation on a Gatekeeper and its params, asked to
 * confirm that what they name does not exist. Met only when the gate answers the call as absent —
 * the target gave an answer the published Operation declares means "does not exist"
 * (`operationAbsentAnswers`, `action-description.ts`) — never by anything in a result: there is no
 * predicate, because no result can say "not there".
 */
export const ObservationAbsenceCheckSchema = z
  .object({
    gatekeeperId: z.guid(),
    operation: OperationNameSchema,
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ObservationAbsenceCheck = z.infer<typeof ObservationAbsenceCheckSchema>;

/** A graph Object a {@link FactCheck} names: by id, or by its ObjectType and identity — the Object
 *  may not exist yet when the plan is written (the goal's work may be what creates it). */
export const FactObjectRefSchema = z.union([
  z.object({ objectId: z.guid() }).strict(),
  z
    .object({
      objectType: z.string().min(1).max(200),
      identity: z
        .record(z.string(), PredicateValueSchema)
        .refine((identity) => Object.keys(identity).length > 0, {
          message: 'an identity names at least one field',
        }),
    })
    .strict(),
]);
export type FactObjectRef = z.infer<typeof FactObjectRefSchema>;

/** A Fact of the graph — the Link of `linkType` from `source` to `target` — and what its own
 *  properties must satisfy (`expect`; without it, the Fact being there is the check). */
export const FactCheckSchema = z
  .object({
    linkType: z.string().min(1).max(200),
    source: FactObjectRefSchema,
    target: FactObjectRefSchema,
    expect: PredicateSchema.optional(),
  })
  .strict();
export type FactCheck = z.infer<typeof FactCheckSchema>;
