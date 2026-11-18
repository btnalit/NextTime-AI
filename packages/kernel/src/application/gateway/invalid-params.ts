import { boundedEcho } from '@nexttime/shared';
import type { z } from 'zod';

/** A capability's params that do not fit what it takes: 400 `invalid_params` (HTTP) or
 *  `INVALID_PARAMS` (WS), before anything is written. Re-exported by `dispatch.ts`, which throws it
 *  for the registered `paramsSchema`; this leaf module lets a handler throw it too
 *  ({@link parseOpaqueParam}) without importing the dispatcher that imports it. */
export class InvalidCapabilityParamsError extends Error {
  readonly issues: unknown;
  /** `reason`, when given, is appended to the message: Zod's issues stay in the kernel, so a refusal
   *  the caller could not otherwise explain (the value budget) says why in the message itself. */
  constructor(name: string, issues: unknown, reason?: string) {
    const message = `invalid params for capability "${name}"`;
    super(reason === undefined ? message : `${message}: ${reason}`);
    this.name = 'InvalidCapabilityParamsError';
    this.issues = issues;
  }
}

/** The most code points of one key in the place a refusal names: a payload's keys are the
 *  caller's own text (a record's keys sit in the path), cut as `outputPath` cuts an output's
 *  (`@nexttime/shared` output-schema.ts). */
const PLACE_KEY_MAX = 64;

/** `path` as the refusal names it: each key clipped and made visible (`boundedEcho`), so a long
 *  key cannot fill the message and an unseen one (a bidi override, a line break) shows as
 *  `\u{XXXX}`, as the message after it does. */
function placeOf(path: readonly PropertyKey[]): string {
  return path
    .map((step) =>
      typeof step === 'number' ? String(step) : boundedEcho(String(step), PLACE_KEY_MAX),
    )
    .join('.');
}

/**
 * The {@link InvalidCapabilityParamsError} for a payload a capability's `paramsSchema` leaves
 * opaque (`propose_skill`'s `skill`, `propose_procedure`'s `procedure`, `propose_operation`'s
 * `operation`) and its handler parses: the issues sit under `field`, and the first one's place and
 * Zod's message are the reason, since the registered schema shows the caller only an object there.
 * Before this, the handler's `ZodError` reached the interfaces unmapped, a 500.
 */
export function invalidOpaqueParamError(
  capability: string,
  field: string,
  issues: readonly z.core.$ZodIssue[],
): InvalidCapabilityParamsError {
  const placed = issues.map((issue) => ({ ...issue, path: [field, ...issue.path] }));
  const first = placed[0];
  const reason =
    first === undefined
      ? undefined
      : `${placeOf(first.path)}: ${boundedEcho(first.message, 300)}${
          placed.length > 1 ? ` (and ${placed.length - 1} more)` : ''
        }`;
  return new InvalidCapabilityParamsError(capability, placed, reason);
}

/** `value` parsed by `schema`, or {@link invalidOpaqueParamError}. */
export function parseOpaqueParam<S extends z.ZodType>(
  capability: string,
  field: string,
  schema: S,
  value: unknown,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalidOpaqueParamError(capability, field, parsed.error.issues);
}
