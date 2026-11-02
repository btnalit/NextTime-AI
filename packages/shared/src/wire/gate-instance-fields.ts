import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// wire/gate-instance-fields: connector names and what creating a gate-host instance takes — shared
// by `create_gate_instance` (wire/platform.ts re-exports all of it) and an admin proposal's
// `gate_instance` intent (wire/admin-proposal.ts, S11 AA3c). A module of its own so the admin
// proposal wire does not import wire/platform (which imports wire/change-plan, which imports the
// admin proposal wire).
// ---------------------------------------------------------------------------------------------

/** A connector name (`connectors.name`, core 0023's check): what a packaged gate announces as
 *  `GATE_CONNECTOR` and what `create_gate_instance` takes as `connector`. */
export const CONNECTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The four generic connectors core 0023 seeds, each named after its transport kind. Only these
 *  govern a workspace connecting a system itself (R-40: `create_connection` /
 *  `request_connection` read the connector named by the connection's kind), so only their mode
 *  reaches past the platform catalog. Every other connector — a packaged gate's, or one an
 *  administrator named for gate-host instances (`create_gate_instance` with `connector`) — governs
 *  the catalog alone. */
export const GENERIC_CONNECTOR_NAMES: readonly ('http' | 'mcp' | 'cli' | 'ssh')[] = [
  'http',
  'mcp',
  'cli',
  'ssh',
];

/** Whether `name` is one of the four generic connectors (`GENERIC_CONNECTOR_NAMES`). */
export function isGenericConnector(name: string): boolean {
  return (GENERIC_CONNECTOR_NAMES as readonly string[]).includes(name);
}

/** The longest `target` a gate-host instance is created with (S11 AA3c F-c8): the gate host
 *  announces the target, and an announce takes at most this many characters (the kernel's
 *  `AnnounceBodySchema`), so an instance with a longer one could never be announced. Only creating
 *  checks it: an instance stored with a longer target before 0.61.0 still reads
 *  (`GateHostedDefinitionWireSchema` has no limit) and can still be disabled. */
export const GATE_INSTANCE_TARGET_MAX_LENGTH = 500;

/** What creating a gate-host instance takes: `create_gate_instance`'s params, and an admin
 *  proposal's `gate_instance` intent (wire/admin-proposal.ts). Never a credential. */
export const gateInstanceCreateFields = {
  /** Stable id, becomes the instance’s `GATE_ID` and its path on the gate host (`/i/<gateId>`). */
  gateId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  displayName: z.string().min(1).max(120).optional(),
  /** S11 P1-F: create it from this connector preset (`list_connector_presets`). The preset
   *  fixes the transport kind, the credential mode, the Operations and the connector (its
   *  name), so `transportKind`, `credentialMode`, `manifestSource` and `connector` are left
   *  out; only `target` is typed. An unknown name refuses 404 `connector_preset_not_found`. */
  preset: z.string().regex(CONNECTOR_NAME_PATTERN).optional(),
  /** Required without `preset`. */
  transportKind: z.enum(['http', 'mcp']).optional(),
  target: z.string().url().max(GATE_INSTANCE_TARGET_MAX_LENGTH),
  /** Required without `preset`. */
  credentialMode: z.enum(['shared', 'connected_account']).optional(),
  /** http: the OpenAPI document URL the host imports Operations from (required without `preset` — without it the instance would have no Operations). mcp: omitted, tools are listed on the target. */
  manifestSource: z.string().url().max(2000).nullable().optional(),
  /** P1: the connector (接入包) the instance belongs to, named after the system it serves.
   *  Omitted: the generic connector of its transport kind (`http` / `mcp`), whose mode also
   *  decides whether workspaces may connect that kind themselves (R-40). A name no connector
   *  carries yet creates one for this kind, `platform_preset`, so the instance reaches the
   *  catalog once enabled without touching the generic one; an existing one must be of the
   *  same kind (409 `connector_kind_mismatch`) and not a packaged gate's (409
   *  `connector_packaged`). */
  connector: z.string().regex(CONNECTOR_NAME_PATTERN).optional(),
};

const GateInstanceCreateFieldsSchema = z.object(gateInstanceCreateFields);
type GateInstanceCreateFieldValues = z.infer<typeof GateInstanceCreateFieldsSchema>;

/** {@link gateInstanceCreateFields}' rules across fields: a preset fixes the kind, the mode, the
 *  manifest source and the connector; without one the kind and mode are required, and an http
 *  instance needs the OpenAPI document it imports its Operations from. */
export function refineGateInstanceCreate(
  value: GateInstanceCreateFieldValues,
  ctx: z.RefinementCtx,
): void {
  if (value.preset !== undefined) {
    for (const key of ['transportKind', 'credentialMode', 'manifestSource', 'connector'] as const) {
      if (value[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `the preset fixes ${key}; leave it out`,
        });
      }
    }
    return;
  }
  for (const key of ['transportKind', 'credentialMode'] as const) {
    if (value[key] === undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required without a preset` });
    }
  }
  if (value.transportKind === 'http' && !value.manifestSource) {
    ctx.addIssue({
      code: 'custom',
      path: ['manifestSource'],
      message: 'an http instance needs the OpenAPI document URL to import its Operations from',
    });
  }
}
