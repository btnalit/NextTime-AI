import { z } from 'zod';
import {
  CONNECTOR_NAME_PATTERN,
  ConnectorModeWireSchema,
  GateHealthWireSchema,
  GateInstanceStatusWireSchema,
  GateTransportKindWireSchema,
  GateTrustWireSchema,
} from './platform.js';

/**
 * wire/platform-state (S11 AA2; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §5.2,
 * §5.7): what an admin agent reads of the platform — the `platform_state_*` capabilities
 * (`adminAgentOnly`, group `platform_state`). Each is a projection of a platform read a platform
 * administrator has in the console, built field by field for an agent: no address of any system
 * (no URL, host, port, path or endpoint), no command, no credential or credential-shaped value, no
 * free text an administrator or a system wrote, no other workspace's id or name (counts instead),
 * no other person's login.
 *
 * Every string in these shapes carries a shape — an enum, a pattern, or an ISO timestamp — and the
 * kernel drops a value that does not fit it rather than pass it through; `capabilities.test.ts`
 * fails when a string field without one is added here. A field named like an address, a command or
 * a secret (`target`, `endpoint`, `url`, `detail`, `payload`, `login`, …) fails it too unless it is
 * an enum, a number or a boolean.
 */

/** A gate instance's id (`gate_instances.gate_id`, core 0023's check). */
export const PLATFORM_STATE_GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** An Operation name an agent is shown: letters, digits, `_`, `.` and `-` only — no `/`, `:` or
 *  space, so nothing shaped like an address or a command passes. Operation names are the gate's
 *  own (`OPERATION_NAME_MAX` long); one outside this shape is counted, never shown. */
export const PLATFORM_STATE_OPERATION_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** An audit action: a capability name or a dotted platform event (`workspace.created`). */
export const PLATFORM_STATE_AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_.]{0,79}$/;

/** An audit row's resource type (`user`, `workspace`, `gate_instance`). */
export const PLATFORM_STATE_RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The most gate instances `platform_state_gates` lists (`truncated` says when there are more). */
export const PLATFORM_STATE_GATES_LIMIT = 200;

/** The most disabled Operation names `platform_state_connectors` lists per connector. */
export const PLATFORM_STATE_DISABLED_OPERATIONS_LIMIT = 500;

/** How far back `platform_state_audit` looks, and the most writes it looks through. */
export const PLATFORM_STATE_AUDIT_WINDOW_HOURS = 168;
export const PLATFORM_STATE_AUDIT_SCAN_ROWS = 1000;

/** The most recent platform writes `platform_state_audit` lists. */
export const PLATFORM_STATE_AUDIT_RECENT_LIMIT = 20;

const IsoTimestampSchema = z.string().datetime();
const CountSchema = z.number().int().nonnegative();

/** A pending manifest, as counts: what the administrator is asked to confirm, without the
 *  Operations' definitions (`PendingGateManifestWire` carries those for the console). */
export const PlatformStatePendingManifestWireSchema = z
  .object({
    announcedAt: IsoTimestampSchema,
    operationCount: CountSchema,
    addedCount: CountSchema,
    removedCount: CountSchema,
    changedCount: CountSchema,
    /** Operations the gate refuses until the announcement is adopted (`refusedOperations`). */
    refusedOperationCount: CountSchema,
  })
  .strict();
export type PlatformStatePendingManifestWire = z.infer<
  typeof PlatformStatePendingManifestWireSchema
>;

/** One gate instance (`GateInstanceWire` without its addresses, display name, enabling workspaces,
 *  Operations or definition beyond its preset and credential mode). */
export const PlatformStateGateWireSchema = z
  .object({
    gateId: z.string().regex(PLATFORM_STATE_GATE_ID_PATTERN),
    /** The connector it belongs to; `null` if its name is outside the connector-name shape. */
    connector: z.string().regex(CONNECTOR_NAME_PATTERN).nullable(),
    transportKind: GateTransportKindWireSchema,
    /** Served by the generic gate host (created by an administrator), not a packaged gate. */
    hosted: z.boolean(),
    /** The connector preset a hosted instance was made from; `null` otherwise. */
    preset: z.string().regex(CONNECTOR_NAME_PATTERN).nullable(),
    /** A hosted instance's credential mode; `null` for a packaged gate. Which kind of credential,
     *  never the credential. */
    credentialMode: z.enum(['shared', 'connected_account']).nullable(),
    status: GateInstanceStatusWireSchema,
    trust: GateTrustWireSchema,
    health: GateHealthWireSchema,
    lastSeenAt: IsoTimestampSchema.nullable(),
    lastCheckedAt: IsoTimestampSchema.nullable(),
    operationCount: CountSchema,
    /** How many workspaces enabled it — never which. */
    enabledWorkspaceCount: CountSchema,
    pendingManifest: PlatformStatePendingManifestWireSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateGateWire = z.infer<typeof PlatformStateGateWireSchema>;

export const PlatformStateGatesWireSchema = z
  .object({
    instances: z.array(PlatformStateGateWireSchema).max(PLATFORM_STATE_GATES_LIMIT),
    /** Every gate instance, including any past the list's limit. */
    total: CountSchema,
    truncated: z.boolean(),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateGatesWire = z.infer<typeof PlatformStateGatesWireSchema>;

/** One connector (`ConnectorWire`, with its disabled Operations shape-checked). */
export const PlatformStateConnectorWireSchema = z
  .object({
    name: z.string().regex(CONNECTOR_NAME_PATTERN),
    kind: GateTransportKindWireSchema,
    packaged: z.boolean(),
    /** One of the four generic connectors (`GENERIC_CONNECTOR_NAMES`). */
    generic: z.boolean(),
    mode: ConnectorModeWireSchema,
    /** Every Operation refused for all its instances, however named. */
    disabledOperationCount: CountSchema,
    /** Those of them that one of the connector's instances announces, in
     *  `PLATFORM_STATE_OPERATION_NAME_PATTERN`'s shape, at most
     *  `PLATFORM_STATE_DISABLED_OPERATIONS_LIMIT`. An administrator can disable any string, and a
     *  bare host name fits the shape too; a name no instance announces is only counted. */
    disabledOperations: z
      .array(z.string().regex(PLATFORM_STATE_OPERATION_NAME_PATTERN))
      .max(PLATFORM_STATE_DISABLED_OPERATIONS_LIMIT),
    operationCount: CountSchema,
    instanceCount: CountSchema,
    /** Gates workspaces connected themselves through it, across every workspace — counts only. */
    selfConnectionCount: CountSchema,
    suspendedSelfConnectionCount: CountSchema,
    updatedAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type PlatformStateConnectorWire = z.infer<typeof PlatformStateConnectorWireSchema>;

export const PlatformStateConnectorsWireSchema = z
  .object({
    connectors: z.array(PlatformStateConnectorWireSchema),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateConnectorsWire = z.infer<typeof PlatformStateConnectorsWireSchema>;

/** Who made a platform change, as the admin agent may know it: its own administrator, another one,
 *  or nobody recorded (an operator CLI run that named no administrator). Never a login. */
export const PlatformStateAuditActorWireSchema = z.enum([
  'self',
  'another_administrator',
  'unattributed',
]);
export type PlatformStateAuditActorWire = z.infer<typeof PlatformStateAuditActorWireSchema>;

export const PlatformStateAuditWriteWireSchema = z
  .object({
    action: z.string().regex(PLATFORM_STATE_AUDIT_ACTION_PATTERN),
    createdAt: IsoTimestampSchema,
    resourceType: z.string().regex(PLATFORM_STATE_RESOURCE_TYPE_PATTERN).nullable(),
    actor: PlatformStateAuditActorWireSchema,
  })
  .strict();
export type PlatformStateAuditWriteWire = z.infer<typeof PlatformStateAuditWriteWireSchema>;

/** The platform's recent changes: the writes among its newest audit rows, never a row's params,
 *  resource id or actor login. */
export const PlatformStateAuditWireSchema = z
  .object({
    windowHours: z.literal(PLATFORM_STATE_AUDIT_WINDOW_HOURS),
    /** Platform audit rows looked through: the newest writes within the window, at most
     *  `PLATFORM_STATE_AUDIT_SCAN_ROWS`. Reads — this capability's own platform audit rows among
     *  them — are left out before the limit, so frequent reads never push a write out. */
    scannedRows: CountSchema,
    /** The window holds more writes than were looked through. */
    truncated: z.boolean(),
    /** Writes per action among the rows looked through, most first. */
    writesByAction: z
      .array(
        z
          .object({
            action: z.string().regex(PLATFORM_STATE_AUDIT_ACTION_PATTERN),
            count: CountSchema,
          })
          .strict(),
      )
      .max(PLATFORM_STATE_AUDIT_SCAN_ROWS),
    /** Writes whose action is outside the action shape — counted, never shown. */
    unrecognizedWrites: CountSchema,
    /** The newest writes, newest first. */
    recent: z.array(PlatformStateAuditWriteWireSchema).max(PLATFORM_STATE_AUDIT_RECENT_LIMIT),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type PlatformStateAuditWire = z.infer<typeof PlatformStateAuditWireSchema>;
