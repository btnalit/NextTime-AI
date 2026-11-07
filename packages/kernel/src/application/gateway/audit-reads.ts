import { CAPABILITY_REGISTRY, capabilityHasSideEffects } from '@nexttime/shared';

/**
 * application/gateway/audit-reads: registry capabilities with no side effects
 * (`capabilityHasSideEffects`). A dispatched call is audited under its own name, so these are the
 * pure-read audit rows — the same test the console's audit view uses for its "writes and
 * decisions" default (`web/src/lib/audit.ts` `isReadAuditAction`). An action the registry does not
 * know is never a read. Both audit streams leave these out on request (legacy 669:
 * `audit_query{filter.excludeReads}`, `platform_audit_query{excludeReads}`), except a refused one,
 * and the platform overview's recent changes never show them.
 */
export const READ_AUDIT_ACTIONS: readonly string[] = CAPABILITY_REGISTRY.filter(
  (capability) => !capabilityHasSideEffects(capability),
).map((capability) => capability.name);
