import { namesASecretField } from '@nexttime/shared';
import { redactSecrets } from '../redaction/index.js';

/**
 * The copy of a Fact's (or an observed Object's) properties the graph stores (review of #549, B2):
 * every value under a secret-named field and every secret-looking value replaced by `[redacted]`,
 * the shape kept. It is the rule a capability call's audit copy is kept under
 * (governance/redaction's `redactSuspectedSecrets` with `secretFields`) and the console masks by,
 * so what a person reads on a Fact is what was stored. Applied by `SqlGraphStore` where it writes,
 * so every writer — an agent's `assert_fact` / `supersede_fact`, a Worker's result, a gate's
 * observed facts, an ingest — gets it, including one added later. Idempotent: a second pass
 * replaces nothing.
 */
export function scrubGraphProperties(properties: Record<string, unknown>): {
  readonly properties: Record<string, unknown>;
  readonly redactedValues: number;
} {
  // Unbounded walk: params passed their schema (at most 1 MiB) before they got here, and the
  // scrubbed copy is what is written.
  const scrubbed = redactSecrets(properties, {
    isSecretKey: namesASecretField,
    schemaLiterals: true,
    maxNodes: Number.POSITIVE_INFINITY,
  });
  return {
    properties: scrubbed.value as Record<string, unknown>,
    redactedValues: scrubbed.redactedValues,
  };
}
