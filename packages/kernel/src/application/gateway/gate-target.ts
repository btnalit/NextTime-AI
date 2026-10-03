import type { PoolClient } from 'pg';
import type { GateTarget } from '../../adapters/gatekeeper-client/index.js';
import { isConnectionSecretSalt } from '../../adapters/gatekeeper-client/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';

/**
 * application/gateway/gate-target: which credential the kernel presents to a registered
 * Gatekeeper (R-01, maintainer decision D-01, 2026-10-02 review) — the one decision every gate call
 * site goes through (`request_action`'s observe / simulate, the action executor's apply and replay,
 * `get_gatekeeper`'s health probe).
 *
 *   - **Platform** (`gate_token`): the endpoint's host is a platform-catalog instance's
 *     (`gate_instances.endpoint`, any status) — a packaged gate that announced itself on the compose
 *     network, or a gate-host instance. Only the catalog says so: it is written by the platform
 *     (an administrator, or a gate announcing with its own internal credential), never by a
 *     workspace, so no workspace-controlled field can turn the platform token on.
 *   - **Connection**: anything else is a gate a workspace connected itself (`create_connection`) and
 *     gets its own secret, derived from the Gatekeeper's `connectionSecretSalt`
 *     (`adapters/gatekeeper-client/connection-secret.ts`).
 *   - **None**: a self-connected Gatekeeper with no salt — registered before per-connection secrets
 *     existed. The client refuses to call it (`connection_secret_missing`) until the owner issues a
 *     secret with `rotate_connection_secret`; it is never sent the platform token.
 *
 * Matching on the parsed `host` (hostname plus a non-default port), not the string, is the rule
 * `create_connection`'s catalog guard has used since leftover 36: for gate-host one announced
 * instance (`http://gate-host:8083/i/<id>`) covers every `/i/*` under that host.
 */

/** `host` (hostname plus a non-default port) of a URL, lower-cased; `null` when the string is not
 *  a URL at all. */
export function urlHost(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The `gate_id` of the platform-catalog instance whose endpoint host `endpoint` shares, or `null`.
 *  `gate_instances` has a `*_read_all` policy (migration core 0023), so any workspace transaction
 *  can read it; hosted rows not announced yet (`endpoint = ''`) are skipped. */
export async function platformGateIdForEndpoint(
  client: PoolClient,
  endpoint: string,
): Promise<string | null> {
  const host = urlHost(endpoint);
  if (host === null) return null;
  const catalog = await client.query<{ gate_id: string; endpoint: string }>(
    "select gate_id, endpoint from gate_instances where endpoint <> ''",
  );
  for (const row of catalog.rows) {
    if (urlHost(row.endpoint) === host) return row.gate_id;
  }
  return null;
}

/** The `GateTarget` for a registered Gatekeeper (see the module doc comment). */
export async function resolveGateTarget(
  client: PoolClient,
  workspaceId: string,
  gatekeeper: Pick<GatekeeperRecord, 'endpoint' | 'connectionSecretSalt'>,
): Promise<GateTarget> {
  const { endpoint, connectionSecretSalt } = gatekeeper;
  if ((await platformGateIdForEndpoint(client, endpoint)) !== null) {
    return { endpoint, credential: { kind: 'platform' } };
  }
  if (isConnectionSecretSalt(connectionSecretSalt)) {
    return {
      endpoint,
      credential: { kind: 'connection', workspaceId, salt: connectionSecretSalt },
    };
  }
  return { endpoint, credential: { kind: 'none' } };
}
