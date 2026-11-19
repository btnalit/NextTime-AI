import { createHash } from 'node:crypto';
import { BlastRadiusSchema, OperationFieldsSchema } from '@nexttime/shared';
import type { z } from 'zod';

/**
 * Legacy K: which definition of an Operation was approved, as one comparable string. The kernel
 * approves and publishes its own copy of an Operation; a gate runs the copy in its own manifest
 * (a gate-host instance re-imports it from the target on every handshake). Nothing tied the two
 * together, so a gate whose manifest changed after the Operation was published ran something
 * other than what was approved. Every observe / simulate / apply now carries the digest of the
 * kernel's copy, and the gate refuses the call when its own copy hashes differently.
 *
 * Both sides call this one function, so it is the one definition of "the same Operation".
 *
 * **Which fields.** Exactly the ones a gate acts on when it runs the Operation:
 *   - `name` and `binding` (where the call goes, and — S11 「门确认不存在」 — which of the target's
 *     answers to an observe call mean "does not exist": `absent_statuses` / `absent_exit_codes`);
 *   - `params_schema` (what is validated and, through `x-in`, where each param is sent);
 *   - `result_mapping` (which observed Facts it reports);
 *   - `mode` (which protocol call it answers);
 *   - `reversibility` (whether it accepts a revert);
 *   - `blast_radius`, for an ssh binding only, where the gate enforces it as a ceiling on the
 *     classified command.
 *
 * Governance-only fields (`auto_approvable`, `await_decision`, `reads`, `writes`, `target`, the MCP hints,
 * `description`, and `blast_radius` elsewhere) are left out. They change what the kernel decides,
 * not what the gate does, and the kernel revises them in place (`refresh_operation_governance`).
 *
 * **Canonical form.** The fields are parsed with the shared `OperationFieldsSchema` shapes, which drop
 * unknown keys. They are then serialized with sorted object keys, and `undefined` members are
 * left out. The kernel's copy comes back from jsonb with its keys reordered and its `undefined`s
 * gone, and still hashes the same as the gate's in-memory one.
 *
 * The answers an observe call reads as "does not exist" are a set, not a list: the gate checks
 * whether the target's answer is one of them, never where it stands (`operationAbsentAnswers`,
 * `isDeclaredAbsence`). So they are hashed in ascending order (`canonicalBinding`). A gate that
 * re-announces `[410, 404]` for `[404, 410]` runs the same Operation, and neither its manifest is
 * held for review nor its calls refused for it (UX acceptance of #1490). A base before this one
 * hashed them as written, so for an Operation that declares them out of ascending order the two
 * digests differ: listing them in ascending order hashes the same in every version.
 */

const OperationDefinitionSchema = OperationFieldsSchema.pick({
  name: true,
  binding: true,
  params_schema: true,
  result_mapping: true,
  mode: true,
  reversibility: true,
}).extend({ blast_radius: BlastRadiusSchema.optional() });

type OperationDefinition = z.infer<typeof OperationDefinitionSchema>;

/** JSON with object keys sorted and `undefined` members dropped (an `undefined` array element
 *  becomes `null`, as in `JSON.stringify`). The input is JSON data: no functions, no cycles. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

type OperationBinding = OperationDefinition['binding'];

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/** `binding` with the answers it reads as "does not exist" (`absent_statuses` /
 *  `absent_exit_codes`) in ascending order — the one canonical form of a declaration whose order
 *  carries no meaning (module comment). Everything else is left as it is. */
export function canonicalBinding<B extends OperationBinding>(binding: B): B {
  if (binding.kind === 'http' && binding.absent_statuses !== undefined) {
    return { ...binding, absent_statuses: ascending(binding.absent_statuses) };
  }
  if (
    (binding.kind === 'cli' || binding.kind === 'ssh') &&
    binding.absent_exit_codes !== undefined
  ) {
    return { ...binding, absent_exit_codes: ascending(binding.absent_exit_codes) };
  }
  return binding;
}

/** The fields the digest covers, from `operation` (see the module comment), its binding in
 *  canonical form. Throws a `ZodError` when one of them is missing or malformed. */
export function operationDefinition(operation: unknown): OperationDefinition {
  const parsed = OperationDefinitionSchema.parse(operation);
  return {
    name: parsed.name,
    binding: canonicalBinding(parsed.binding),
    params_schema: parsed.params_schema,
    ...(parsed.result_mapping !== undefined ? { result_mapping: parsed.result_mapping } : {}),
    mode: parsed.mode,
    reversibility: parsed.reversibility,
    ...(parsed.binding.kind === 'ssh' && parsed.blast_radius !== undefined
      ? { blast_radius: parsed.blast_radius }
      : {}),
  };
}

/** `sha256:<64 hex>` of `operation`'s definition. Throws a `ZodError` when the definition does
 *  not parse; a caller that cannot compute one must refuse the call, never send none. */
export function operationDefinitionDigest(operation: unknown): string {
  const hash = createHash('sha256').update(canonicalJson(operationDefinition(operation)));
  return `sha256:${hash.digest('hex')}`;
}

/** The first 12 hex characters, for messages. */
export function shortOperationDigest(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice(7, 19) : digest.slice(0, 12);
}
