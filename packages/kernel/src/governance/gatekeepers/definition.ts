import {
  canonicalJson,
  operationDefinition,
  operationDefinitionDigest,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';

/**
 * governance/gatekeepers/definition (legacy K): which definition of an Operation this workspace
 * approved, as the digest a gate checks on every call (`@nexttime/gatekeeper-base`'s
 * `operation-digest.ts` has the field list and why). The kernel computes it from its own copy, the
 * workspace's Operation Object, never from what a gate says it runs.
 *
 * A record whose stored definition does not parse has no digest. The call is refused here rather
 * than sent without one (`OperationDefinitionUnreadableError`).
 */

/** What this module reads of an `OperationRecord` (`manifest.ts`, which imports this module). */
export interface OperationDefinitionRecord {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly operation: unknown;
}

export class OperationDefinitionUnreadableError extends Error {
  readonly gatekeeperId: string;
  readonly operationName: string;
  constructor(gatekeeperId: string, operationName: string, cause: unknown) {
    super(
      `Operation "${operationName}" on gatekeeper ${gatekeeperId}: its stored definition is not a valid Operation, so there is no approved definition to hold the gate to — refused, nothing was sent. Publish a corrected revision of it.`,
      { cause },
    );
    this.name = 'OperationDefinitionUnreadableError';
    this.gatekeeperId = gatekeeperId;
    this.operationName = operationName;
  }
}

/** The digest of `record`'s definition — what a call made under it tells the gate was approved. */
export function operationRecordDigest(record: OperationDefinitionRecord): string {
  try {
    return operationDefinitionDigest(record.operation);
  } catch (err) {
    throw new OperationDefinitionUnreadableError(record.gatekeeperId, record.name, err);
  }
}

/** `operationRecordDigest`, or `null` when the stored definition does not parse — for a read
 *  model that reports such a record as refused (the call path refuses it before sending). */
export function operationRecordDigestOrNull(record: OperationDefinitionRecord): string | null {
  try {
    return operationRecordDigest(record);
  } catch (err) {
    if (err instanceof OperationDefinitionUnreadableError) return null;
    throw err;
  }
}

/** Whether `announced` (a gate's manifest entry) defines something other than `record`: `true`
 *  when the gate would refuse calls made under `record`, or when either side does not parse. */
export function operationDefinitionDiffers(
  record: OperationDefinitionRecord,
  announced: Operation,
): boolean {
  try {
    return operationDefinitionDigest(record.operation) !== operationDefinitionDigest(announced);
  } catch {
    return true;
  }
}

/** One param of an Operation's `params_schema`, as a person reviewing a revision reads it: where
 *  the gate sends it (`x-in`, lower-cased; absent = the request body) and whether it is required. */
export interface OperationParamSummary {
  readonly name: string;
  readonly in?: string;
  readonly required: boolean;
}

/** What publishing `after` over `before` changes in the definition a gate runs (the digest's
 *  fields — governance-only fields are `operationGovernanceChange`'s): which of those fields
 *  differ, and the params added, removed or changed (`after`'s side for a change). */
export interface OperationDefinitionChange {
  readonly changedFields: string[];
  readonly paramsAdded: OperationParamSummary[];
  readonly paramsRemoved: OperationParamSummary[];
  readonly paramsChanged: OperationParamSummary[];
}

function paramsOf(
  paramsSchema: unknown,
): Map<string, { readonly summary: OperationParamSummary; readonly canonical: string }> {
  const params = new Map<
    string,
    { readonly summary: OperationParamSummary; readonly canonical: string }
  >();
  if (paramsSchema === null || typeof paramsSchema !== 'object') return params;
  const { properties, required } = paramsSchema as { properties?: unknown; required?: unknown };
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return params;
  }
  const requiredNames = new Set(
    Array.isArray(required) ? required.filter((n): n is string => typeof n === 'string') : [],
  );
  for (const [name, schema] of Object.entries(properties as Record<string, unknown>)) {
    const location =
      schema !== null && typeof schema === 'object'
        ? (schema as Record<string, unknown>)['x-in']
        : undefined;
    const isRequired = requiredNames.has(name);
    params.set(name, {
      summary: {
        name,
        ...(typeof location === 'string' ? { in: location.toLowerCase() } : {}),
        required: isRequired,
      },
      canonical: canonicalJson({ schema, required: isRequired }),
    });
  }
  return params;
}

/** `undefined` when either side's definition does not parse — there is no reliable diff to show. */
export function operationDefinitionChange(
  before: unknown,
  after: unknown,
): OperationDefinitionChange | undefined {
  let previous: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    previous = operationDefinition(before) as Record<string, unknown>;
    next = operationDefinition(after) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const fields = [...new Set([...Object.keys(previous), ...Object.keys(next)])];
  const changedFields = fields
    .filter((key) => canonicalJson(previous[key]) !== canonicalJson(next[key]))
    .sort();
  const beforeParams = paramsOf(previous.params_schema);
  const afterParams = paramsOf(next.params_schema);
  const byName = (a: OperationParamSummary, b: OperationParamSummary) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const paramsAdded: OperationParamSummary[] = [];
  const paramsChanged: OperationParamSummary[] = [];
  for (const [name, param] of afterParams) {
    const old = beforeParams.get(name);
    if (!old) paramsAdded.push(param.summary);
    else if (old.canonical !== param.canonical) paramsChanged.push(param.summary);
  }
  const paramsRemoved = [...beforeParams]
    .filter(([name]) => !afterParams.has(name))
    .map(([, param]) => param.summary);
  return {
    changedFields,
    paramsAdded: paramsAdded.sort(byName),
    paramsRemoved: paramsRemoved.sort(byName),
    paramsChanged: paramsChanged.sort(byName),
  };
}
