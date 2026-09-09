/**
 * substrate/audit: append-only AuditRecord; reconstruct; PROV-O export; invariant monitoring.
 *
 * This module owns its own table (`audit_records`, migrations/core/0004_audit.sql) and exposes
 * only a service interface here — it must not be reached into from another module's internal
 * files, and other modules must not query its table directly; cross-module coordination happens
 * through domain events (see packages/shared).
 *
 * `export_prov` (PROV-O export, design doc §7.1/§9.3 `audit` capability group) is not yet
 * implemented — out of S1.3 scope; the HTTP capability route for it returns 501 until then.
 *
 * `invariant-checks.ts` (S3.8) is the one deliberate, documented exception to "reads only its own
 * table": periodic cross-workspace scans for design doc §5.4's I1–I16 span several modules' own
 * tables by necessity (see that file's own doc comment for the full reasoning) — everything else
 * exported from here still only ever touches `audit_records`.
 */
export {
  DEFAULT_AUDIT_ACTION_STATS_DAYS,
  DEFAULT_AUDIT_QUERY_LIMIT,
  MAX_AUDIT_ACTION_STATS_DAYS,
  MAX_AUDIT_QUERY_LIMIT,
  queryAudit,
  queryAuditActionOperationStats,
  writeAudit,
} from './writer.js';
export type {
  AuditActionOperationStatsFilter,
  AuditActionOperationStatsRow,
  AuditQueryFilter,
  AuditRecordInput,
  AuditRecordRow,
} from './writer.js';

export { reconstruct } from './reconstruct.js';
export type { ReconstructInput, ReconstructResult } from './reconstruct.js';

export {
  DEFAULT_OUTBOX_STUCK_THRESHOLD_MS,
  INVARIANT_CHECK_IDS,
  renderInvariantMetricsPrometheus,
  runInvariantChecks,
} from './invariant-checks.js';
export type {
  InvariantCheckResult,
  MinimalPool as InvariantCheckPool,
  RunInvariantChecksOptions,
} from './invariant-checks.js';
