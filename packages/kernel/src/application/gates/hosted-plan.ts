import { type GateHostedDefinitionWire, isGenericConnector } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { ConnectorPreset } from './presets.js';
import type { ConnectorMode, GateTransportKind } from './store.js';

/**
 * application/gates/hosted-plan: what creating a gate-host instance would do, without doing it —
 * the definition a request stores and whether the platform would take it now. `create_gate_instance`
 * resolves its definition here, and an admin proposal's platform segment (S11 AA3c,
 * `application/change-plan/platform-segments.ts`) dry-runs each `gate_instance` item with both
 * before a platform administrator applies it, which then creates the instance exactly as
 * `create_gate_instance` does (`createHostedGateInstance`).
 */

/** What `create_gate_instance` takes (and an admin proposal's `gate_instance` item). */
export interface HostedGateRequest {
  readonly gateId: string;
  readonly displayName?: string;
  readonly preset?: string;
  readonly transportKind?: 'http' | 'mcp';
  readonly target: string;
  readonly credentialMode?: 'shared' | 'connected_account';
  readonly manifestSource?: string | null;
  readonly connector?: string;
}

/** The definition a request stores and the connector its instance joins, or why there is none. */
export type HostedDefinitionResolution =
  | {
      readonly refused: null;
      readonly definition: GateHostedDefinitionWire;
      readonly connector: string;
    }
  | { readonly refused: 'connector_preset_not_found' };

/** The definition `create_gate_instance` stores, and the connector the instance joins: the
 *  preset's (S11 P1-F) when one is named — its transport, credential mode and name, with only the
 *  administrator's address — else exactly what was typed. The params schema already refused a
 *  preset call that also names any of those, and a plain one missing the kind or mode. */
export function resolveHostedDefinition(
  input: HostedGateRequest,
  presets: readonly ConnectorPreset[],
): HostedDefinitionResolution {
  if (input.preset !== undefined) {
    const preset = presets.find((candidate) => candidate.name === input.preset);
    if (!preset) return { refused: 'connector_preset_not_found' };
    return {
      refused: null,
      definition: {
        transportKind: preset.transportKind,
        target: input.target,
        credentialMode: preset.credentialMode,
        manifestSource: null,
        preset: preset.name,
      },
      connector: preset.name,
    };
  }
  const transportKind = input.transportKind;
  const credentialMode = input.credentialMode;
  if (transportKind === undefined || credentialMode === undefined) {
    throw new Error(
      'resolveHostedDefinition: transportKind and credentialMode passed the schema unset',
    );
  }
  return {
    refused: null,
    definition: {
      transportKind,
      target: input.target,
      credentialMode,
      manifestSource: transportKind === 'http' ? (input.manifestSource ?? null) : null,
    },
    connector: input.connector ?? transportKind,
  };
}

/** Why the platform would not take an instance now: the gate id is taken, or the connector does
 *  not fit — of another kind, a packaged gate's, or (an admin proposal's only) not in the catalog
 *  (`platform_preset`), so no workspace could enable the instance from it. */
export type HostedGatePlanRefusal =
  | 'gate_id_taken'
  | 'connector_kind_mismatch'
  | 'connector_packaged'
  | 'connector_not_offerable';

export type HostedGatePlan =
  | { readonly refused: HostedGatePlanRefusal }
  | { readonly refused: null; readonly connectorCreated: boolean };

/**
 * Whether `createHostedGateInstance` would create an instance `gateId` under `connector` now, and
 * whether that would create the connector — reading only (its connector rule, `fitConnector`,
 * inserts a new connector as it decides). One more rule than `fitConnector`'s: an existing
 * connector that is not `platform_preset` is refused (`connector_not_offerable`) — an instance
 * there could not be enabled by any workspace (`connector_not_preset`), so a proposal for one
 * would apply into a dead end. `create_gate_instance` itself does not check it: an administrator
 * may stage an instance before putting its connector in the catalog.
 */
export async function planHostedGateInstance(
  client: PoolClient,
  input: { readonly gateId: string; readonly connector: string; readonly kind: GateTransportKind },
): Promise<HostedGatePlan> {
  const taken = await client.query('select 1 from gate_instances where gate_id = $1', [
    input.gateId,
  ]);
  if ((taken.rowCount ?? 0) > 0) return { refused: 'gate_id_taken' };
  if (isGenericConnector(input.connector)) {
    return input.connector === input.kind
      ? { refused: null, connectorCreated: false }
      : { refused: 'connector_kind_mismatch' };
  }
  const row = (
    await client.query<{ kind: GateTransportKind; packaged: boolean; mode: ConnectorMode }>(
      'select kind, packaged, mode from connectors where name = $1',
      [input.connector],
    )
  ).rows[0];
  if (!row) return { refused: null, connectorCreated: true };
  if (row.kind !== input.kind) return { refused: 'connector_kind_mismatch' };
  if (row.packaged) return { refused: 'connector_packaged' };
  if (row.mode !== 'platform_preset') return { refused: 'connector_not_offerable' };
  return { refused: null, connectorCreated: false };
}

/** What an administrator reads when an instance is refused: the same words for
 *  `create_gate_instance` and for a platform segment's item. */
export function hostedGateRefusalMessage(
  refused: HostedGatePlanRefusal,
  gateId: string,
  connector: string,
  definition: GateHostedDefinitionWire,
): string {
  switch (refused) {
    case 'gate_id_taken':
      return `a gate instance "${gateId}" already exists`;
    case 'connector_kind_mismatch':
      return `the connector "${connector}" is not an ${definition.transportKind} connector — name a new one for this system, or one of the same kind`;
    case 'connector_packaged':
      return definition.preset !== undefined
        ? `the connector "${connector}" belongs to a packaged gate this deployment runs — the system is already connected through it, so no preset instance can join it`
        : `the connector "${connector}" belongs to a packaged gate — name a new one for this system`;
    case 'connector_not_offerable':
      return `the connector "${connector}" is not in the catalog (platform_preset) — no workspace could enable an instance of it; change its mode first, or name a new connector`;
  }
}
