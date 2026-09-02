/**
 * substrate/audit: append-only AuditRecord; reconstruct; PROV-O export.
 *
 * This module owns its own table (`audit_records`, migrations/core/0004_audit.sql) and exposes
 * only a service interface here — it must not be reached into from another module's internal
 * files, and other modules must not query its table directly; cross-module coordination happens
 * through domain events (see packages/shared).
 *
 * `export_prov` (PROV-O export, design doc §7.1/§9.3 `audit` capability group) is not yet
 * implemented — out of S1.3 scope; the HTTP capability route for it returns 501 until then.
 */
export {
  DEFAULT_AUDIT_QUERY_LIMIT,
  MAX_AUDIT_QUERY_LIMIT,
  queryAudit,
  writeAudit,
} from './writer.js';
export type { AuditQueryFilter, AuditRecordInput, AuditRecordRow } from './writer.js';

export { reconstruct } from './reconstruct.js';
export type { ReconstructInput, ReconstructResult } from './reconstruct.js';
