import { createHash } from 'node:crypto';
import type {
  GateAddressChangeImpactWire,
  GateAddressChangePreviewWire,
  GateAddressChangeStatusWire,
  GateAddressChangeWire,
  GateAddressManifestComparisonWire,
  Operation,
  PlatformGateAddressChangeWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { setWorkspaceContext, withPlatform } from '../../adapters/db/platform-context.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import {
  GatekeeperClientError,
  GatekeeperTimeoutError,
} from '../../adapters/gatekeeper-client/index.js';
import { countInFlightActionRequestsForGatekeeper } from '../../governance/approval/index.js';
import {
  assertConnectionParamsCarryNoCredentials,
  redactConnectionAddress,
} from '../../governance/connections/index.js';
import {
  GatekeeperNotFoundError,
  findGatekeeperIdByConnectionSecretSalt,
  findGatekeepersByEndpoint,
  gateAddressOrigin,
  getGatekeeper,
  listPublishedOperationsForGatekeepers,
  moveGatekeeperAddress,
  normalizeGateEndpoint,
} from '../../governance/gatekeepers/index.js';
import { shownFreeText } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { currentPrincipalId } from '../chat/index.js';
import {
  GATE_ADDRESS_CHANGE_ONE_OPEN_CONSTRAINT,
  GATE_ADDRESS_CHANGE_SALT_CONSTRAINT,
  type GateAddressChangeRow,
  type PlatformGateAddressChangeRow,
  assertEndpointFreeForSelfConnection,
  canonicalJson,
  expireStaleGateAddressChange,
  findGateAddressChange,
  findOpenGateAddressChange,
  findSelfConnection,
  gateAddressChangeExpired,
  insertGateAddressChange,
  listGateAddressChanges,
  lockSelfConnectionEndpoint,
  lockSelfConnectionState,
  manifestDigest,
  moveSelfConnectionAddress,
  operationsOf,
  settleGateAddressChange,
} from '../gates/index.js';
import { compareAnnouncedOperations } from './announced-operations.js';
import type { CapabilityHandler, CapabilityHandlerContext } from './capability-handler.js';
import {
  ConnectionSecretInvalidError,
  assertConnectionSecretNeverProposed,
  assertConnectionSecretUnused,
  assertEndpointIsNotAPlatformGate,
  connectionAddressDeps,
  connectionSecretServedAProposal,
} from './connection-handlers.js';
import { forgetGatekeeperPresence } from './credential-presence.js';
import { platformGateIdForEndpoint } from './gate-target.js';

/**
 * application/gateway/gate-address-change-handlers (legacy 701): moving a gate a workspace
 * connected itself (`create_connection`) to a new address — `http://` to `https://`, or a new host
 * — without connecting it again.
 *
 * Every reference to a Gatekeeper is by id: its published Operations, Grants
 * (`connect_gatekeeper`), auto-approvals, WorkerDefinitions' `gates`, Goals and Procedures. So
 * changing the address in place keeps all of them, and that is the risk: whatever the workspace
 * trusted "this gate" with follows it to the new host. A change is therefore a proposal the
 * workspace's owner makes and a platform administrator decides (`gate_address_changes`, core 0057):
 *
 *   preview_gate_address_change (owner, writes nothing)
 *     → propose_gate_address_change (owner) ── withdraw_gate_address_change (owner)
 *     → approve_gate_address_change / reject_gate_address_change (platform administrator)
 *
 * What holds (design: kernel-wip/701, reviewed by #493 and #501):
 *   - I-A1: the Gatekeeper Object's `endpoint`, normalized, is its self connection's
 *     `endpoint_key` — the approval moves both in one transaction (`moveGatekeeperAddress`,
 *     `moveSelfConnectionAddress`), from the address the change was proposed from only.
 *   - I-A2: one open proposal per gate (core 0057's partial unique index).
 *   - I-A3: a request runs only at the address it was made for (`action_requests.gate_endpoint_key`,
 *     governance 0044; the executor refuses `gate_address_changed`). An approval is refused while
 *     the gate has a request in flight made before that binding existed
 *     (`gate_address_change_blocked`), so no request without one ever meets a change.
 *   - I-A4: the approval checks again what the proposal checked — the new host's manifest (read
 *     again, with the new secret, and required to be the one proposed), the address free, not a
 *     platform gate's, the secret unused — under the locks a new self connection at that address
 *     and a suspension of this one take.
 *   - I-A5: only a self connection moves (a catalog gate's address is the platform instance's);
 *     a suspended one may be proposed and decided, and stays suspended.
 *
 * The new host gets its own connection secret (`mint_connection_secret`), never the current one:
 * the proposal stores its salt, which no other Gatekeeper may hold and no other proposal may have
 * carried — a secret serves one proposal. The new host must describe exactly the Operations the
 * workspace published (`matches`), or the proposal is refused: what moves is the same gate at
 * another address, never a different gate under the same name. No account credential is sent
 * anywhere by a change; the owner connects accounts at the new host and clears them at the old one
 * (the applied change's audit row says so: `accountCredentialsLeftOnOldHost`).
 *
 * Addresses as shown: the workspace sees them with user info, query and fragment cut out
 * (`redactConnectionAddress`; the proposal stores its "from" that way), the platform only scheme,
 * host and port (`gateAddressOrigin`), as `list_self_connections` shows a self connection. The
 * connection secret is never stored, echoed or audited (`redactedParamKeys`); an error a new host
 * answers with is shown as free text is (`shownFreeText`).
 */

type GateAddressChangeErrorCode =
  | 'gate_address_unchanged'
  | 'gatekeeper_not_self_connected'
  | 'gate_address_preview_changed'
  | 'gate_address_manifest_mismatch'
  | 'gate_address_change_pending'
  | 'gate_address_change_decided'
  | 'gate_address_change_expired'
  | 'gate_address_change_blocked'
  | 'gate_address_change_not_found'
  | 'manifest_fetch_failed'
  // The new address's checks again at approval, in the platform's words (`assertNewAddressStillFree`):
  // the codes `create_connection` and the preview answer with for the same conditions.
  | 'endpoint_is_platform_gate'
  | 'endpoint_already_connected'
  | 'connection_secret_in_use';

const STATUS_OF: Readonly<Record<GateAddressChangeErrorCode, 400 | 404 | 409 | 502>> = {
  gate_address_unchanged: 400,
  gatekeeper_not_self_connected: 409,
  gate_address_preview_changed: 409,
  gate_address_manifest_mismatch: 409,
  gate_address_change_pending: 409,
  gate_address_change_decided: 409,
  gate_address_change_expired: 409,
  gate_address_change_blocked: 409,
  gate_address_change_not_found: 404,
  manifest_fetch_failed: 502,
  endpoint_is_platform_gate: 400,
  endpoint_already_connected: 409,
  connection_secret_in_use: 409,
};

/** One refusal of an address change: its wire code and status (interfaces/http/capability-route,
 *  interfaces/ws/rpc). */
export class GateAddressChangeError extends Error {
  readonly code: GateAddressChangeErrorCode;
  readonly status: 400 | 404 | 409 | 502;
  constructor(code: GateAddressChangeErrorCode, message: string) {
    super(message);
    this.name = 'GateAddressChangeError';
    this.code = code;
    this.status = STATUS_OF[code];
  }
}

/** A platform transaction's own principal while it acts inside one workspace's rows (the same nil
 *  id the platform's per-workspace reads set, `platform-handlers.ts`). */
const NIL_PRINCIPAL = '00000000-0000-0000-0000-000000000000';

// -------------------------------------------------------------------------------------------
// The comparison and the impact — what the owner previews and the administrator decides on
// -------------------------------------------------------------------------------------------

/** The new host's description against what the workspace published for this gate. `differing`:
 *  names described differently from what is published or held as a draft that a re-sync would
 *  rewrite, and names the workspace never had; `notDescribed`: published names the new host does
 *  not describe. The judgments are `compareAnnouncedOperations`', the re-sync preview's. */
async function compareManifest(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  operations: readonly Operation[],
): Promise<GateAddressManifestComparisonWire> {
  const { operationsToImport, operationsAlreadyPresent } = await compareAnnouncedOperations(
    client,
    workspaceId,
    gatekeeperId,
    operations,
    () => false,
    'gate',
  );
  const differing = [
    ...new Set([
      ...operationsAlreadyPresent
        .filter((entry) => entry.differs || entry.definitionDiffers)
        .map((entry) => entry.name),
      ...operationsToImport
        .filter((entry) => entry.pendingDraft === undefined || entry.pendingDraft.rewritable)
        .map((entry) => entry.name),
    ]),
  ].sort();
  const described = new Set(operations.map((operation) => operation.name));
  const published = await listPublishedOperationsForGatekeepers(client, workspaceId, [
    gatekeeperId,
  ]);
  const notDescribed = [
    ...new Set(published.map((row) => row.name).filter((name) => !described.has(name))),
  ].sort();
  return {
    matches: differing.length === 0 && notDescribed.length === 0,
    manifestDigest: manifestDigest(operations),
    differing,
    notDescribed,
  };
}

/** What follows the gate to its new address (`GateAddressChangeImpactWireSchema`). */
async function impactOf(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<GateAddressChangeImpactWire> {
  const published = await listPublishedOperationsForGatekeepers(client, workspaceId, [
    gatekeeperId,
  ]);
  const grants = await client.query<{ count: string }>(
    `select count(*) as count from capability_grants
      where workspace_id = $1 and resource_type = 'gatekeeper' and resource_id = $2
        and status = 'active' and (expires_at is null or expires_at > now())`,
    [workspaceId, gatekeeperId],
  );
  const autoApproved = await client.query<{ action_kind: string }>(
    `select action_kind from gatekeeper_policies
      where workspace_id = $1 and gatekeeper_id = $2 and auto_approve
      order by action_kind`,
    [workspaceId, gatekeeperId],
  );
  const workerDefinitions = await client.query<{ count: string }>(
    `select count(distinct id) as count from worker_definitions
      where workspace_id = $1 and status = 'published' and definition -> 'gates' ? $2`,
    [workspaceId, gatekeeperId],
  );
  const inFlight = await countInFlightActionRequestsForGatekeeper(
    client,
    workspaceId,
    gatekeeperId,
  );
  return {
    publishedOperationCount: new Set(published.map((row) => row.name)).size,
    grantCount: Number(grants.rows[0]?.count ?? 0),
    autoApprovedOperations: autoApproved.rows.map((row) => row.action_kind),
    workerDefinitionCount: Number(workerDefinitions.rows[0]?.count ?? 0),
    inFlightActionRequestCount: inFlight.total,
  };
}

/** Binds a proposal to the preview its owner saw: the gate, the address it moves from (as shown),
 *  the one it moves to, the new secret and the new host's manifest. */
function previewDigestOf(input: {
  readonly gatekeeperId: string;
  readonly fromEndpoint: string;
  readonly toEndpointKey: string;
  readonly newSalt: string;
  readonly manifestDigest: string;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/** The new host's `describe_operations`, called with the new secret — what the new host runs, and
 *  proof it holds the secret the change gives it. A failure is the owner's to fix at the new host;
 *  its text is shown as free text is. To the owner (`workspace`) the address as the owner's reads
 *  show it; to the administrator approving (`platform`) by its origin only, as everything the
 *  platform reads of a self connection, with the one remedy the administrator has (#1156 review
 *  P3-1). */
async function describeNewHost(
  capability: string,
  workspaceId: string,
  endpoint: string,
  salt: string,
  voice: 'workspace' | 'platform',
): Promise<Operation[]> {
  const { gatekeeperClient } = connectionAddressDeps();
  try {
    const described = await gatekeeperClient.describeOperations({
      endpoint,
      credential: { kind: 'connection', workspaceId, salt },
    });
    return operationsOf(described.operations);
  } catch (err) {
    const why =
      err instanceof GatekeeperClientError && err.status === 401
        ? voice === 'workspace'
          ? 'it refused the new connection secret — put the secret this change was made with in the gate’s GATE_KERNEL_TOKEN_FILE there and restart it'
          : 'it refused the secret this change carries'
        : err instanceof GatekeeperTimeoutError
          ? 'it did not answer in time'
          : err instanceof Error
            ? shownFreeText(err.message)
            : 'it did not answer';
    const shown =
      voice === 'workspace'
        ? redactConnectionAddress('endpoint', endpoint)
        : gateAddressOrigin(endpoint);
    throw new GateAddressChangeError(
      'manifest_fetch_failed',
      `${capability}: the gate at ${JSON.stringify(shown)} did not describe its Operations: ${why}${voice === 'platform' ? ` — ${PLATFORM_REMEDY}` : ''}`,
    );
  }
}

/** What the administrator approving can do about a refusal the new host or the workspace caused. */
const PLATFORM_REMEDY = 'reject the change; the workspace owner can propose it again';

/**
 * I-A4: the new address's checks again, under the change's locks (`lockSelfConnectionEndpoint`
 * serializes the landing at that address with it) — the preview's checks, answered in the
 * platform's words: the codes are the ones `create_connection` and the preview answer with, the
 * address is shown by its origin only, and nothing of the workspace's other gates (their names,
 * ids, addresses) reaches the administrator (#1156 review P3-1).
 */
async function assertNewAddressStillFree(
  client: PoolClient,
  workspaceId: string,
  toEndpoint: string,
  newSalt: string,
  capability: string,
): Promise<void> {
  const shown = JSON.stringify(gateAddressOrigin(toEndpoint));
  const platformGateId = await platformGateIdForEndpoint(client, toEndpoint);
  if (platformGateId !== null) {
    throw new GateAddressChangeError(
      'endpoint_is_platform_gate',
      `${capability}: the new address ${shown} is platform gate instance "${platformGateId}"’s — ${PLATFORM_REMEDY}`,
    );
  }
  if ((await findGatekeepersByEndpoint(client, workspaceId, toEndpoint)).length > 0) {
    throw new GateAddressChangeError(
      'endpoint_already_connected',
      `${capability}: the workspace connected another gate at the new address ${shown} since the change was proposed — ${PLATFORM_REMEDY}`,
    );
  }
  if ((await findGatekeeperIdByConnectionSecretSalt(client, workspaceId, newSalt)) !== null) {
    throw new GateAddressChangeError(
      'connection_secret_in_use',
      `${capability}: another gate of the workspace holds the secret this change carries — ${PLATFORM_REMEDY}`,
    );
  }
}

// -------------------------------------------------------------------------------------------
// Wire projections
// -------------------------------------------------------------------------------------------

function toWorkspaceWire(
  row: GateAddressChangeRow,
  status: GateAddressChangeStatusWire = row.status,
): GateAddressChangeWire {
  return {
    id: row.id,
    gatekeeperId: row.gatekeeperId,
    // Stored as shown (`propose_gate_address_change`).
    fromEndpoint: row.fromEndpoint,
    toEndpoint: redactConnectionAddress('endpoint', row.toEndpoint),
    status,
    impact: row.impact,
    previewDigest: row.previewDigest,
    proposedBy: row.proposedBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    rejectionReason: row.rejectionReason,
  };
}

function platformShownAddress(field: 'target' | 'endpoint', address: string): string {
  return address === '' ? '' : redactConnectionAddress(field, gateAddressOrigin(address));
}

function toPlatformWire(row: PlatformGateAddressChangeRow): PlatformGateAddressChangeWire {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    gatekeeperId: row.gatekeeperId,
    connector: row.connector,
    target: platformShownAddress('target', row.target),
    fromEndpoint: platformShownAddress('endpoint', row.fromEndpoint),
    toEndpoint: platformShownAddress('endpoint', row.toEndpoint),
    // A `proposed` row past its expiry is shown as what it is; the next approval, rejection or
    // proposal for the gate records it so (lazy expiry).
    status: row.status === 'proposed' && row.lapsed ? 'expired' : row.status,
    impact: row.impact,
    manifestDigest: row.manifestDigest,
    previewDigest: row.previewDigest,
    proposedByName: row.proposedByName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedByLogin: row.decidedByLogin,
    rejectionReason: row.rejectionReason,
    suspended: row.suspended,
  };
}

/** `get_gatekeeper`'s `pendingAddressChange`: the gate's open proposal, unless it is past its
 *  expiry (it can no longer be approved). */
export async function pendingGateAddressChangeWire(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<GateAddressChangeWire | null> {
  const open = await findOpenGateAddressChange(client, workspaceId, gatekeeperId);
  if (!open || (await gateAddressChangeExpired(client, open))) return null;
  return toWorkspaceWire(open);
}

// -------------------------------------------------------------------------------------------
// Workspace plane (owner): preview, propose, withdraw
// -------------------------------------------------------------------------------------------

interface AddressChangeParams {
  readonly gatekeeperId: string;
  readonly endpoint: string;
  readonly connectionSecret: string;
}

interface PreviewOutcome {
  readonly wire: GateAddressChangePreviewWire;
  readonly storedFromEndpoint: string;
  readonly toEndpointKey: string;
  readonly newSalt: string;
}

/** The checks a proposal makes, in the order that keeps a refused one from contacting anything:
 *  the address carries no credential, the gate is this workspace's self connection, the address is
 *  a new one, not a platform gate's and not another self connection's, the secret was minted here
 *  and serves nothing yet, the URL passes the outbound-target predicate — then the new host is
 *  asked, with the new secret, what it runs. */
async function previewChange(
  client: PoolClient,
  workspaceId: string,
  params: AddressChangeParams,
  capability: string,
): Promise<PreviewOutcome> {
  const { connectionSecrets, outboundTargetGuard } = connectionAddressDeps();
  assertConnectionParamsCarryNoCredentials(capability, { endpoint: params.endpoint });
  const record = await getGatekeeper(client, workspaceId, params.gatekeeperId);
  if (!record) throw new GatekeeperNotFoundError(params.gatekeeperId);
  const selfConnection = await findSelfConnection(client, workspaceId, params.gatekeeperId);
  if (!selfConnection) {
    throw new GateAddressChangeError(
      'gatekeeper_not_self_connected',
      `${capability}: Gatekeeper "${params.gatekeeperId}" is not a gate this workspace connected itself — a gate enabled from the platform catalog is at the platform instance's address, which the platform administrator changes`,
    );
  }
  const toEndpointKey = normalizeGateEndpoint(params.endpoint);
  if (toEndpointKey === normalizeGateEndpoint(record.endpoint)) {
    throw new GateAddressChangeError(
      'gate_address_unchanged',
      `${capability}: Gatekeeper "${params.gatekeeperId}" is already at that address`,
    );
  }
  await assertEndpointIsNotAPlatformGate(client, params.endpoint, capability);
  await assertEndpointFreeForSelfConnection(client, workspaceId, params.endpoint);

  if (params.connectionSecret.trim() === '') {
    throw new ConnectionSecretInvalidError(true, capability);
  }
  const newSalt = connectionSecrets.saltOf(workspaceId, params.connectionSecret);
  if (newSalt === null) throw new ConnectionSecretInvalidError(false, capability);
  await assertConnectionSecretUnused(client, workspaceId, newSalt, capability);
  await assertConnectionSecretNeverProposed(client, workspaceId, newSalt, capability);

  await outboundTargetGuard(params.endpoint, 'endpoint');
  const operations = await describeNewHost(
    capability,
    workspaceId,
    params.endpoint,
    newSalt,
    'workspace',
  );
  const manifest = await compareManifest(client, workspaceId, params.gatekeeperId, operations);
  const impact = await impactOf(client, workspaceId, params.gatekeeperId);
  const fromEndpoint = redactConnectionAddress('endpoint', record.endpoint);
  return {
    wire: {
      gatekeeperId: params.gatekeeperId,
      fromEndpoint,
      toEndpoint: redactConnectionAddress('endpoint', params.endpoint),
      manifest,
      impact,
      previewDigest: previewDigestOf({
        gatekeeperId: params.gatekeeperId,
        fromEndpoint,
        toEndpointKey,
        newSalt,
        manifestDigest: manifest.manifestDigest,
      }),
    },
    storedFromEndpoint: fromEndpoint,
    toEndpointKey,
    newSalt,
  };
}

/** `preview_gate_address_change(gatekeeperId, endpoint, connectionSecret)` — human, owner. Writes
 *  nothing. */
export const previewGateAddressChangeHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
) => {
  const input = params as AddressChangeParams;
  const preview = await previewChange(client, workspaceId, input, 'preview_gate_address_change');
  return { result: preview.wire, resourceType: 'gatekeeper', resourceId: input.gatekeeperId };
};

function isUniqueViolation(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function pendingChange(capability: string, gatekeeperId: string): GateAddressChangeError {
  return new GateAddressChangeError(
    'gate_address_change_pending',
    `${capability}: Gatekeeper "${gatekeeperId}" already has a proposal to move it awaiting the platform administrator — withdraw it (withdraw_gate_address_change) to propose another`,
  );
}

/** `propose_gate_address_change(gatekeeperId, endpoint, connectionSecret, previewDigest)` —
 *  human, owner: the preview again, required to be the one the owner saw and to match, then the
 *  proposal, for a platform administrator to decide within 24 hours. */
export const proposeGateAddressChangeHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const capability = 'propose_gate_address_change';
  const input = params as AddressChangeParams & { readonly previewDigest: string };
  const preview = await previewChange(client, workspaceId, input, capability);
  if (preview.wire.previewDigest !== input.previewDigest) {
    throw new GateAddressChangeError(
      'gate_address_preview_changed',
      `${capability}: what the change would do is not what was previewed any more (the gate's address, the new host's Operations or the secret changed) — preview it again`,
    );
  }
  if (!preview.wire.manifest.matches) {
    throw new GateAddressChangeError(
      'gate_address_manifest_mismatch',
      `${capability}: the gate at the new address does not describe exactly the Operations this workspace published for it — run the same gate there (or re-sync this one first), then preview again`,
    );
  }
  const proposedBy = ctx?.principalId || (await currentPrincipalId(client));
  await expireStaleGateAddressChange(client, workspaceId, input.gatekeeperId);
  if (await findOpenGateAddressChange(client, workspaceId, input.gatekeeperId)) {
    throw pendingChange(capability, input.gatekeeperId);
  }
  let row: GateAddressChangeRow;
  try {
    row = await insertGateAddressChange(client, {
      workspaceId,
      gatekeeperId: input.gatekeeperId,
      fromEndpoint: preview.storedFromEndpoint,
      toEndpoint: input.endpoint,
      toEndpointKey: preview.toEndpointKey,
      newSalt: preview.newSalt,
      manifestDigest: preview.wire.manifest.manifestDigest,
      previewDigest: preview.wire.previewDigest,
      impact: preview.wire.impact,
      proposedBy,
    });
  } catch (err) {
    // A concurrent proposal got there first (the checks above ran outside its transaction).
    if (isUniqueViolation(err) && err.constraint === GATE_ADDRESS_CHANGE_SALT_CONSTRAINT) {
      throw connectionSecretServedAProposal(capability);
    }
    if (isUniqueViolation(err) && err.constraint === GATE_ADDRESS_CHANGE_ONE_OPEN_CONSTRAINT) {
      throw pendingChange(capability, input.gatekeeperId);
    }
    throw err;
  }
  return {
    result: toWorkspaceWire(row),
    resourceType: 'gate_address_change',
    resourceId: row.id,
    auditPayload: { gatekeeperId: row.gatekeeperId, impact: row.impact },
  };
};

function decidedChange(capability: string, row: GateAddressChangeRow): GateAddressChangeError {
  return new GateAddressChangeError(
    'gate_address_change_decided',
    `${capability}: the proposal is ${row.status} already`,
  );
}

function notFound(capability: string, id: string): GateAddressChangeError {
  return new GateAddressChangeError(
    'gate_address_change_not_found',
    `${capability}: no proposal to move a gate has id "${id}"`,
  );
}

/** `withdraw_gate_address_change(id)` — human, owner. A proposal past its expiry is recorded as
 *  expired instead, and returned so. */
export const withdrawGateAddressChangeHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const capability = 'withdraw_gate_address_change';
  const { id } = params as { readonly id: string };
  const read = await findGateAddressChange(client, workspaceId, id);
  if (!read) throw notFound(capability, id);
  if (read.status !== 'proposed') throw decidedChange(capability, read);
  // The lock sees an open proposal only (`findGateAddressChange`): none here means it was decided
  // since the read above.
  const row = await findGateAddressChange(client, workspaceId, id, { forUpdate: true });
  if (!row) {
    const decided = await findGateAddressChange(client, workspaceId, id);
    throw decidedChange(capability, decided ?? read);
  }
  const settled = (await gateAddressChangeExpired(client, row))
    ? await settleGateAddressChange(client, workspaceId, id, { status: 'expired' })
    : await settleGateAddressChange(client, workspaceId, id, {
        status: 'withdrawn',
        withdrawnBy: ctx?.principalId || (await currentPrincipalId(client)),
      });
  if (!settled) throw new Error(`${capability}: proposal ${id} was decided inside its own lock`);
  return {
    result: toWorkspaceWire(settled),
    resourceType: 'gate_address_change',
    resourceId: id,
    auditPayload: { gatekeeperId: settled.gatekeeperId, status: settled.status },
  };
};

// -------------------------------------------------------------------------------------------
// Platform plane (administrator): list, approve, reject
// -------------------------------------------------------------------------------------------

function platformUserOf(
  capability: string,
  ctx: CapabilityHandlerContext | undefined,
): NonNullable<CapabilityHandlerContext['platformUser']> {
  if (!ctx?.platformUser) {
    throw new Error(
      `${capability}: no platform user in the call's context (a platform-scope call)`,
    );
  }
  return ctx.platformUser;
}

/** `list_gate_address_changes(status?, workspaceId?)` — platform. Newest first. */
export const listGateAddressChangesHandler: CapabilityHandler = async (client, _ws, params) => {
  const filter = params as { status?: GateAddressChangeStatusWire; workspaceId?: string };
  const rows = await listGateAddressChanges(client, filter);
  return { result: { items: rows.map(toPlatformWire) } };
};

async function requireOne(
  client: PoolClient,
  capability: string,
  workspaceId: string,
  id: string,
): Promise<PlatformGateAddressChangeRow> {
  const [row] = await listGateAddressChanges(client, { workspaceId, id });
  if (!row) throw notFound(capability, id);
  return row;
}

function expiredChange(capability: string): GateAddressChangeError {
  return new GateAddressChangeError(
    'gate_address_change_expired',
    `${capability}: the proposal expired before it was decided — the workspace owner can propose it again`,
  );
}

/** A proposal found past its expiry by a decision: recorded as expired in the decision's own
 *  transaction, which then commits, and the decision refused after it. */
async function settleLapsed(
  client: PoolClient,
  capability: string,
  row: PlatformGateAddressChangeRow,
) {
  await settleGateAddressChange(client, row.workspaceId, row.id, { status: 'expired' });
  const settled = await requireOne(client, capability, row.workspaceId, row.id);
  return {
    result: toPlatformWire(settled),
    resourceType: 'gate_address_change',
    resourceId: row.id,
    auditPayload: { outcome: 'expired' },
    afterCommit: async (): Promise<never> => {
      throw expiredChange(capability);
    },
  };
}

/**
 * `approve_gate_address_change(workspaceId, id, previewDigest)` — platform. Two phases, as every
 * call that reaches a network does: the first (the dispatcher's platform transaction, its audit
 * row) reads the proposal and checks it is still open and the one the administrator read; the
 * second asks the new host again what it runs — with the new secret, outside any transaction — and
 * then, in one platform transaction under the self connection's and the new address's locks,
 * checks everything again (I-A4) and moves the Gatekeeper and its self connection (I-A1), records
 * the decision, audits it (`gatekeeper.address_changed`) and emits `GatekeeperAddressChanged`. From
 * that commit every call to the gate goes to the new host with the new secret, and every request
 * made for the old address is refused where it would have run (I-A3).
 */
export const approveGateAddressChangeHandler: CapabilityHandler = async (
  client,
  _ws,
  params,
  ctx,
) => {
  const capability = 'approve_gate_address_change';
  const user = platformUserOf(capability, ctx);
  const input = params as { workspaceId: string; id: string; previewDigest: string };
  const row = await requireOne(client, capability, input.workspaceId, input.id);
  if (row.status !== 'proposed') throw decidedChange(capability, row);
  if (row.lapsed) return settleLapsed(client, capability, row);
  if (row.previewDigest !== input.previewDigest) {
    throw new GateAddressChangeError(
      'gate_address_preview_changed',
      `${capability}: this is not the proposal that was read — read it again`,
    );
  }
  return {
    result: toPlatformWire(row),
    resourceType: 'gate_address_change',
    resourceId: row.id,
    auditPayload: { gatekeeperId: row.gatekeeperId },
    afterCommit: (pool) => applyGateAddressChange(pool, capability, user, row),
  };
};

async function applyGateAddressChange(
  pool: PoolLike,
  capability: string,
  user: { readonly id: string; readonly login: string },
  proposal: PlatformGateAddressChangeRow,
): Promise<PlatformGateAddressChangeWire> {
  const { workspaceId, gatekeeperId, toEndpoint, newSalt } = proposal;
  // The new host again, before anything is held: the predicate (the platform's networks may have
  // changed since the proposal), then what it runs, which must be what was proposed.
  await connectionAddressDeps().outboundTargetGuard(toEndpoint, 'endpoint');
  const operations = await describeNewHost(
    capability,
    workspaceId,
    toEndpoint,
    newSalt,
    'platform',
  );
  if (manifestDigest(operations) !== proposal.manifestDigest) {
    throw new GateAddressChangeError(
      'gate_address_manifest_mismatch',
      `${capability}: the gate at the new address describes other Operations than when the change was proposed — reject it; the workspace owner can propose it again`,
    );
  }

  const applied = await withPlatform(pool, { userId: user.id }, async (client) => {
    await setWorkspaceContext(client, workspaceId, NIL_PRINCIPAL);
    // A suspension of this self connection, and a new self connection at the new address, wait
    // for this transaction (and this one for them): what is checked below holds when it commits.
    await lockSelfConnectionState(client, workspaceId, gatekeeperId, 'change');
    await lockSelfConnectionEndpoint(client, workspaceId, toEndpoint);
    const current = await findGateAddressChange(client, workspaceId, proposal.id, {
      forUpdate: true,
    });
    if (!current) throw notFound(capability, proposal.id);
    if (current.status !== 'proposed') throw decidedChange(capability, current);
    if (await gateAddressChangeExpired(client, current)) throw expiredChange(capability);

    const record = await getGatekeeper(client, workspaceId, gatekeeperId);
    if (!record || redactConnectionAddress('endpoint', record.endpoint) !== current.fromEndpoint) {
      throw new GateAddressChangeError(
        'gate_address_preview_changed',
        `${capability}: the gate is not at the address the change was proposed from any more — reject it`,
      );
    }
    if (!(await findSelfConnection(client, workspaceId, gatekeeperId))) {
      throw new GateAddressChangeError(
        'gatekeeper_not_self_connected',
        `${capability}: the gate is no longer one its workspace connected itself — reject the change`,
      );
    }
    assertConnectionParamsCarryNoCredentials(capability, { endpoint: toEndpoint });
    await assertNewAddressStillFree(client, workspaceId, toEndpoint, newSalt, capability);
    const inFlight = await countInFlightActionRequestsForGatekeeper(
      client,
      workspaceId,
      gatekeeperId,
    );
    if (inFlight.unbound > 0) {
      throw new GateAddressChangeError(
        'gate_address_change_blocked',
        `${capability}: the gate has ${inFlight.unbound} request(s) in flight made before requests were bound to an address — approve once they have finished`,
      );
    }
    const comparison = await compareManifest(client, workspaceId, gatekeeperId, operations);
    if (!comparison.matches) {
      throw new GateAddressChangeError(
        'gate_address_manifest_mismatch',
        `${capability}: the workspace's published Operations of this gate changed since the proposal — reject it; the workspace owner can propose it again`,
      );
    }

    const moved =
      (await moveGatekeeperAddress(client, workspaceId, gatekeeperId, {
        fromEndpoint: record.endpoint,
        endpoint: toEndpoint,
        salt: newSalt,
      })) &&
      (await moveSelfConnectionAddress(client, workspaceId, gatekeeperId, {
        fromEndpointKey: normalizeGateEndpoint(record.endpoint),
        toEndpoint,
        toEndpointKey: current.toEndpointKey,
      }));
    if (!moved) {
      throw new GateAddressChangeError(
        'gate_address_preview_changed',
        `${capability}: the gate moved while the change was being applied — read the proposal again`,
      );
    }
    const settled = await settleGateAddressChange(client, workspaceId, proposal.id, {
      status: 'applied',
      decidedByUserId: user.id,
    });
    if (!settled) throw decidedChange(capability, current);
    await writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      actorUserId: user.id,
      action: 'gatekeeper.address_changed',
      resourceType: 'gatekeeper',
      resourceId: gatekeeperId,
      payload: {
        workspaceId,
        gateAddressChangeId: proposal.id,
        fromHost: gateAddressOrigin(record.endpoint),
        toHost: gateAddressOrigin(toEndpoint),
        // No account credential moved: the owner connects accounts at the new host and clears
        // them at the old one.
        accountCredentialsLeftOnOldHost: true,
      },
    });
    await enqueue(client, {
      type: 'GatekeeperAddressChanged',
      workspaceId,
      gatekeeperId,
      gateAddressChangeId: proposal.id,
    });
    return requireOne(client, capability, workspaceId, proposal.id);
  });
  // This process's answers about accounts on the old host; every other process forgets them on
  // the event (`registerGatekeeperAddressChangedConsumer`).
  forgetGatekeeperPresence(workspaceId, gatekeeperId);
  return toPlatformWire(applied);
}

/** `reject_gate_address_change(workspaceId, id, reason?)` — platform. Nothing moves; the secret
 *  the proposal carried stays used up. */
export const rejectGateAddressChangeHandler: CapabilityHandler = async (
  client,
  _ws,
  params,
  ctx,
) => {
  const capability = 'reject_gate_address_change';
  const user = platformUserOf(capability, ctx);
  const input = params as { workspaceId: string; id: string; reason?: string };
  const row = await requireOne(client, capability, input.workspaceId, input.id);
  if (row.status !== 'proposed') throw decidedChange(capability, row);
  if (row.lapsed) return settleLapsed(client, capability, row);
  const settled = await settleGateAddressChange(client, input.workspaceId, input.id, {
    status: 'rejected',
    decidedByUserId: user.id,
    reason: input.reason ?? null,
  });
  if (!settled) throw decidedChange(capability, row);
  return {
    result: toPlatformWire(await requireOne(client, capability, input.workspaceId, input.id)),
    resourceType: 'gate_address_change',
    resourceId: input.id,
    auditPayload: { gatekeeperId: row.gatekeeperId },
  };
};
