import type { ConnectionRequestCancelReason, ConnectionRequestStatus } from '@nexttime/shared';

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
  /** The system a self connection (`request_connection`) names; `null` on a gate instance enable
   *  request (legacy 254, governance 0047 — exactly one of `target` and `gateInstanceId`). */
  readonly target: string | null;
  /** Legacy 254 (governance 0047): the platform gate instance (`gate_instances.gate_id`) a
   *  `request_gate_instance_enable` request asks the owner to enable; `null` on a self connection. */
  readonly gateInstanceId: string | null;
  readonly requestedBy: string;
  readonly gatekeeperId: string | null;
  readonly completedBy: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
  /** S11 AA5a-1 (governance 0037): the admin agent session that made the request, when an admin
   *  agent did (in its trial workspace); `null` for every other request. */
  readonly adminAgentSessionId: string | null;
  /** Legacy 254 (governance 0047): why and when a `cancelled` request ended — `null` on every other
   *  status, and on a request cancelled before 0047 (no backfill). */
  readonly cancelReason: ConnectionRequestCancelReason | null;
  readonly cancelledAt: Date | null;
}

interface ConnectionRequestDbRow {
  workspace_id: string;
  id: string;
  status: ConnectionRequestStatus;
  kind: ConnectionRequestKind;
  target: string | null;
  gate_instance_id: string | null;
  requested_by: string;
  gatekeeper_id: string | null;
  completed_by: string | null;
  requested_at: Date;
  completed_at: Date | null;
  admin_agent_session_id: string | null;
  cancel_reason: ConnectionRequestCancelReason | null;
  cancelled_at: Date | null;
}

export function mapConnectionRequestRow(row: ConnectionRequestDbRow): ConnectionRequestRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    status: row.status,
    kind: row.kind,
    target: row.target,
    gateInstanceId: row.gate_instance_id,
    requestedBy: row.requested_by,
    gatekeeperId: row.gatekeeper_id,
    completedBy: row.completed_by,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    adminAgentSessionId: row.admin_agent_session_id,
    cancelReason: row.cancel_reason,
    cancelledAt: row.cancelled_at,
  };
}

export const CONNECTION_REQUEST_ROW_COLUMNS =
  'workspace_id, id, status, kind, target, gate_instance_id, requested_by, gatekeeper_id, ' +
  'completed_by, requested_at, completed_at, admin_agent_session_id, cancel_reason, cancelled_at';

export class ConnectionRequestNotFoundError extends Error {
  constructor(workspaceId: string, connectionRequestId: string) {
    super(`ConnectionRequest not found: workspace ${workspaceId}, id ${connectionRequestId}`);
    this.name = 'ConnectionRequestNotFoundError';
  }
}

/** Legacy 254: `create_connection` was given a gate instance enable request — it names a platform
 *  gate instance, not a system, and only `enable_gate_instance` completes it (409
 *  `connection_request_is_gate_enable`). */
export class ConnectionRequestIsGateEnableError extends Error {
  readonly gateId: string;
  constructor(connectionRequestId: string, gateId: string) {
    super(
      `ConnectionRequest ${connectionRequestId} asks for platform gate instance ${gateId} to be enabled — complete it with enable_gate_instance, not create_connection`,
    );
    this.name = 'ConnectionRequestIsGateEnableError';
    this.gateId = gateId;
  }
}
