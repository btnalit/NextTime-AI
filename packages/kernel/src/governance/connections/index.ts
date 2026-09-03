/**
 * governance/connections: `request_connection` card → `create_connection` (this repo's
 * `complete_connection`, see service.ts's own doc comment) → registered Gatekeeper →
 * `connect_gatekeeper` Grant (design doc §5.1.4 Connection, §7.5, §9.3; docs/development-tasks.md
 * S2.13). Calls into `governance/gatekeepers` (Gatekeeper instance registration + manifest
 * import/publish, S2.4) and `governance/capability` (Grant, S2.3) through their own published
 * service interfaces, the same way `governance/approval` calls into `governance/policy`/
 * `governance/capability` — see service.ts's own doc comment for the full layering argument
 * (this module does no network I/O; that is `application/gateway/connection-handlers.ts`'s job).
 *
 * This module owns its own table (migrations/governance/0005_connection_requests.sql,
 * `connection_requests`) and exposes only this service interface — it must not be reached into
 * from another module's internal files, and other modules must not query its table directly;
 * cross-module coordination happens through domain events (`ConnectionRequested`/
 * `ConnectionCreated`, packages/shared/src/events.ts).
 */

export {
  requestConnection,
  getConnectionRequest,
  listConnectionRequests,
  completeConnection,
  connectGatekeeper,
  GatekeeperNotFoundError,
} from './service.js';
export type {
  RequestConnectionInput,
  ListConnectionRequestsInput,
  CompleteConnectionInput,
  CompleteConnectionResult,
  ConnectGatekeeperInput,
} from './service.js';

export { ConnectionRequestNotFoundError } from './types.js';
export type { ConnectionRequestKind, ConnectionRequestRow } from './types.js';
