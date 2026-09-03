import type { ConnectionRequestStatus } from '@nexttime/shared';

/**
 * governance/connections/types: the `ConnectionRequestRow` shape (migrations/governance/
 * 0005_connection_requests.sql) plus the DB-row mapper and this module's error classes. Split out
 * of service.ts per the design doc's own file-size guidance (§7.10 "单文件 ≤ 600 行"), mirroring
 * governance/approval/types.ts's own precedent.
 */

/** Matches `governance/gatekeepers/registry.ts`'s own `RegisterGatekeeperInput['transportKind']`
 *  — no shared named type exists for this union anywhere in the codebase yet (every call site
 *  inlines it), so this module does the same rather than inventing one unilaterally. */
export type ConnectionRequestKind = 'http' | 'mcp' | 'cli' | 'ssh';

export interface ConnectionRequestRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly status: ConnectionRequestStatus;
  readonly kind: ConnectionRequestKind;
  readonly target: string;
  readonly requestedBy: string;
  readonly gatekeeperId: string | null;
  readonly completedBy: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
}

interface ConnectionRequestDbRow {
  workspace_id: string;
  id: string;
  status: ConnectionRequestStatus;
  kind: ConnectionRequestKind;
  target: string;
  requested_by: string;
  gatekeeper_id: string | null;
  completed_by: string | null;
  requested_at: Date;
  completed_at: Date | null;
}

export function mapConnectionRequestRow(row: ConnectionRequestDbRow): ConnectionRequestRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    status: row.status,
    kind: row.kind,
    target: row.target,
    requestedBy: row.requested_by,
    gatekeeperId: row.gatekeeper_id,
    completedBy: row.completed_by,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
  };
}

export const CONNECTION_REQUEST_ROW_COLUMNS =
  'workspace_id, id, status, kind, target, requested_by, gatekeeper_id, completed_by, ' +
  'requested_at, completed_at';

export class ConnectionRequestNotFoundError extends Error {
  constructor(workspaceId: string, connectionRequestId: string) {
    super(`ConnectionRequest not found: workspace ${workspaceId}, id ${connectionRequestId}`);
    this.name = 'ConnectionRequestNotFoundError';
  }
}
