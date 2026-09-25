import type { GateInstanceWire, Operation, PublishableStatus } from '@nexttime/shared';
import { mintGateHostToken } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type GatekeeperByEndpointEntry,
  diffOperationGovernanceFields,
  findGatekeepersByEndpoint,
  getOperation,
  importManifest,
  publishOperation,
  refreshOperationGovernance,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import {
  findGateLinkByGate,
  findGateLinkByGatekeeper,
  getConnector,
  getGateInstance,
  insertGateLink,
  listAvailableGateInstances,
  operationsOf,
} from '../gates/index.js';
import { getConfiguredTaskRuntime } from '../task/runtime.js';
import type { CapabilityHandler } from './capability-handler.js';
import { gateHostCredentialUrl } from './platform-gates-handlers.js';

/**
 * application/gateway/gate-instance-handlers: the workspace half of P-B1 (docs/platform-admin-
 * design.md §6.3 "平台预置（管理员建实例、工作区一键启用）"; development-tasks.md P-B 决定 ①) —
 * `list_available_gate_instances` / `enable_gate_instance`, `scope:'workspace'`, owner.
 *
 * Enabling mirrors `cli/bootstrap.ts`'s `register-gatekeeper --publish` step for step — one
 * Activity, `registerGatekeeper`, `importManifest` (origin `import`), `publishOperation` for every
 * imported draft, `ConnectionCreated` — and then writes the `workspace_gate_links` row that lets
 * the approval decision read the instance's `trust` and the connector's deny list live. It runs on
 * the workspace plane on purpose: `registerGatekeeper` and the Activity need a real Principal,
 * which the platform plane does not have; an administrator who is not a member delegates first.
 * Idempotent per (workspace, gate): a second call returns the existing Gatekeeper.
 *
 * **Endpoint-association (S8 W2-K2, leftover 73, ui-audit J3/J4/B7)**: `registerGatekeeper` has no
 * identity key of its own, so before this handler existed a workspace that had already registered
 * a Gatekeeper for the same running gate process through some other path (concretely: the legacy
 * `register-gatekeeper` CLI, `cli/bootstrap.ts`) would get a *second* Gatekeeper + a second
 * `ConnectedSystem` + a duplicate set of published Operations every time "在本工作区启用" was
 * clicked, with no way to undo it (no delete capability for a live Gatekeeper). `resolveGateLinkTarget`
 * below is the fix: before registering anything, it looks up every `Gatekeeper` Object in this
 * workspace whose own `endpoint` property (the URL the kernel actually calls) matches the
 * instance's — `endpoint`, not `name`/`target`, because those are exactly the fields a legacy
 * registration and a platform gate instance are expected to disagree on (§ its own doc comment on
 * `governance/gatekeepers/registry.ts`'s `findGatekeepersByEndpoint`). Three outcomes: exactly one
 * match → link it (`registerGatekeeper` is skipped entirely — no new Gatekeeper, no new
 * `ConnectedSystem`); zero matches → today's create path, unchanged; more than one match →
 * `GateInstanceNotAvailableError('ambiguous_existing_gatekeeper')`, nothing written (never guess
 * which one is "the" instance). Linking never rewrites the existing Object's `name`/`target`/
 * `transportKind`, nor any of its Operations' governance fields — `drift` (in the result) surfaces
 * a mismatch for a human to act on, it does not correct it.
 *
 * `previewGateInstanceEnableHandler` below is the read-only twin the console's ConfirmTier calls
 * first (audit J3 "一键写入 ... 没有预览或确认"): it calls `resolveGateLinkTarget` and the same
 * manifest-parse (`operationsOf(await rawOperations(...))`) this handler does, never a parallel
 * reimplementation, and never writes.
 */

export class GateInstanceNotAvailableError extends Error {
  readonly code:
    | 'gate_not_found'
    | 'gate_not_enabled'
    | 'connector_not_preset'
    | 'gate_not_ready'
    | 'gate_not_linked'
    | 'credential_mode_mismatch'
    // S8 W2-K2 (leftover 73): more than one existing Gatekeeper in this workspace shares the
    // instance's endpoint — `resolveGateLinkTarget` refuses rather than guess which one is "the"
    // instance's prior registration.
    | 'ambiguous_existing_gatekeeper'
    // S8 W3-K1 (leftover 79): `refresh_operation_governance`'s target Gatekeeper has no linked
    // platform gate instance (`findGateLinkByGatekeeper` returned null) — nothing to refresh from.
    | 'no_announced_manifest';
  constructor(code: GateInstanceNotAvailableError['code'], message: string) {
    super(message);
    this.name = 'GateInstanceNotAvailableError';
    this.code = code;
  }
}

// -------------------------------------------------------------------------------------------
// S8 W2-K2 shared helpers — used verbatim by both enableGateInstanceHandler and
// previewGateInstanceEnableHandler below (the dispatch's own "same functions, not a parallel
// reimplementation" contract).
// -------------------------------------------------------------------------------------------

interface GateLinkResolutionCreate {
  readonly kind: 'create';
}
interface GateLinkResolutionLink {
  readonly kind: 'link';
  readonly existing: GatekeeperByEndpointEntry;
}
interface GateLinkResolutionAmbiguous {
  readonly kind: 'ambiguous';
  readonly candidateIds: readonly string[];
}
type GateLinkResolution =
  | GateLinkResolutionCreate
  | GateLinkResolutionLink
  | GateLinkResolutionAmbiguous;

/** The endpoint-association decision (module doc comment) — zero matches: `create` (today's
 *  unchanged path); exactly one: `link` that Object; more than one: `ambiguous`, both callers
 *  refuse/report it rather than pick one. */
async function resolveGateLinkTarget(
  client: PoolClient,
  workspaceId: string,
  instance: GateInstanceWire,
): Promise<GateLinkResolution> {
  const matches = await findGatekeepersByEndpoint(client, workspaceId, instance.endpoint);
  if (matches.length === 0) return { kind: 'create' };
  if (matches.length === 1) {
    const [existing] = matches;
    if (!existing) throw new Error('resolveGateLinkTarget: unreachable — length 1 with no [0]');
    return { kind: 'link', existing };
  }
  return { kind: 'ambiguous', candidateIds: matches.map((m) => m.gatekeeperId) };
}

interface GateLinkDriftField {
  readonly existing: string;
  readonly instance: string;
}
interface GateLinkDrift {
  readonly name?: GateLinkDriftField;
  readonly target?: GateLinkDriftField;
  readonly transportKind?: GateLinkDriftField;
}

/** Which of name/target/transportKind differ between the Gatekeeper Object a `link` resolution
 *  found and the platform gate instance being enabled — presentational only, never acted on here
 *  (module doc comment: linking never rewrites the existing Object). */
function computeGateLinkDrift(
  existing: GatekeeperByEndpointEntry,
  instance: GateInstanceWire,
): GateLinkDrift {
  const drift: {
    name?: GateLinkDriftField;
    target?: GateLinkDriftField;
    transportKind?: GateLinkDriftField;
  } = {};
  if (existing.name !== instance.displayName) {
    drift.name = { existing: existing.name, instance: instance.displayName };
  }
  if (existing.target !== instance.target) {
    drift.target = { existing: existing.target, instance: instance.target };
  }
  if (existing.transportKind !== instance.transportKind) {
    drift.transportKind = { existing: existing.transportKind, instance: instance.transportKind };
  }
  return drift;
}

export const listAvailableGateInstancesHandler: CapabilityHandler = async (client, workspaceId) => {
  return { result: { items: await listAvailableGateInstances(client, workspaceId) } };
};

async function requireAvailable(client: PoolClient, gateId: string) {
  const instance = await getGateInstance(client, gateId);
  if (!instance)
    throw new GateInstanceNotAvailableError('gate_not_found', 'gate instance not found');
  const connector = await getConnector(client, instance.connector);
  if (!connector || connector.mode !== 'platform_preset') {
    throw new GateInstanceNotAvailableError(
      'connector_not_preset',
      `connector "${instance.connector}" is not in platform-preset mode`,
    );
  }
  if (instance.status !== 'enabled') {
    throw new GateInstanceNotAvailableError(
      'gate_not_enabled',
      `gate instance "${gateId}" is ${instance.status}, not enabled by the administrator`,
    );
  }
  if (instance.lastSeenAt === null || instance.operationCount === 0) {
    // P-B2a (决定 ⑨): a gate-host instance the host has not taken over yet (or a gate that announced
    // no Operations) would publish nothing and leave a useless link behind.
    throw new GateInstanceNotAvailableError(
      'gate_not_ready',
      `gate instance "${gateId}" has not announced any Operations yet — wait for the gate host to take it over`,
    );
  }
  return instance;
}

/** Workspace side of 决定 ⑩: a 5-minute token for the caller's own credential slot on a hosted
 *  `connected_account` instance this workspace already enabled. The credential goes browser → gate
 *  host; the kernel never sees it. */
export const issueGateCredentialTokenHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error('issue_gate_credential_token: no resolved human principal in context');
  }
  const { gateId } = params as { gateId: string };
  const instance = await getGateInstance(client, gateId);
  if (!instance)
    throw new GateInstanceNotAvailableError('gate_not_found', 'gate instance not found');
  const link = await findGateLinkByGate(client, workspaceId, gateId);
  if (!link) {
    throw new GateInstanceNotAvailableError(
      'gate_not_linked',
      `gate instance "${gateId}" is not enabled in this workspace`,
    );
  }
  if (!instance.hosted || instance.definition?.credentialMode !== 'connected_account') {
    throw new GateInstanceNotAvailableError(
      'credential_mode_mismatch',
      'only a gate-host instance in connected_account mode takes a per-member credential',
    );
  }
  const { privateKey } = getConfiguredTaskRuntime();
  const minted = await mintGateHostToken({
    privateKey,
    gateId,
    onBehalfOf: ctx.principal.id,
    subject: ctx.principal.id,
  });
  return {
    result: {
      gateId,
      token: minted.token,
      url: gateHostCredentialUrl(gateId),
      onBehalfOf: ctx.principal.id,
      credentialMode: 'connected_account',
      expiresAt: minted.expiresAt.toISOString(),
    },
    resourceType: 'gatekeeper',
    resourceId: link.gatekeeperObjectId,
  };
};

export const enableGateInstanceHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error('enable_gate_instance: no resolved human principal in context');
  }
  const { gateId } = params as { gateId: string };
  // Serialize concurrent enables of the same (workspace, gate) so the idempotency check below is
  // exact — the same advisory-lock shape `application/task/invoke.ts` uses (review finding).
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `enable_gate:${workspaceId}:${gateId}`,
  ]);
  const existing = await findGateLinkByGate(client, workspaceId, gateId);
  if (existing) {
    return {
      result: {
        gateId,
        gatekeeperId: existing.gatekeeperObjectId,
        publishedOperationNames: [],
        skippedOperationNames: [],
        // This call made no link/create decision at all — it just returned the prior outcome.
        linkedExisting: false,
      },
      resourceType: 'gatekeeper',
      resourceId: existing.gatekeeperObjectId,
    };
  }
  const instance = await requireAvailable(client, gateId);
  const actor = { id: ctx.principal.id, kind: ctx.principal.kind };

  const resolution = await resolveGateLinkTarget(client, workspaceId, instance);
  if (resolution.kind === 'ambiguous') {
    throw new GateInstanceNotAvailableError(
      'ambiguous_existing_gatekeeper',
      `gate instance "${gateId}"'s endpoint matches more than one existing Gatekeeper in this workspace (${resolution.candidateIds.join(', ')}) — resolve the duplicate before enabling`,
    );
  }

  const activity = await startActivity(client, workspaceId, {
    kind: 'governance.enable_gate_instance',
    principalId: actor.id,
    metadata:
      resolution.kind === 'link'
        ? { gateId, linkedExisting: true, gatekeeperId: resolution.existing.gatekeeperId }
        : { gateId },
  });

  let gatekeeperId: string;
  let drift: GateLinkDrift | undefined;
  if (resolution.kind === 'link') {
    // No `registerGatekeeper` call — no new Gatekeeper, no new `ConnectedSystem` (module doc
    // comment). The existing Object's name/target/transportKind are left exactly as they were.
    gatekeeperId = resolution.existing.gatekeeperId;
    drift = computeGateLinkDrift(resolution.existing, instance);
  } else {
    const registered = await registerGatekeeper(client, workspaceId, {
      name: instance.displayName,
      transportKind: instance.transportKind,
      target: instance.target || instance.displayName,
      endpoint: instance.endpoint,
      activityId: activity.id,
      registeredBy: actor,
    });
    gatekeeperId = registered.gatekeeperId;
  }

  const operations = operationsOf(await rawOperations(client, gateId));
  const imported = await importManifest(client, workspaceId, {
    gatekeeperId,
    operations,
    proposedBy: actor,
    activityId: activity.id,
  });
  const publishedOperationNames: string[] = [];
  for (const record of imported.imported) {
    await publishOperation(client, workspaceId, { gatekeeperId, name: record.name });
    publishedOperationNames.push(record.name);
  }
  await endActivity(client, workspaceId, activity.id, 'completed');
  await insertGateLink(client, {
    workspaceId,
    gateId,
    gatekeeperObjectId: gatekeeperId,
    enabledBy: actor.id,
  });
  await enqueue(client, {
    type: 'ConnectionCreated',
    workspaceId,
    gatekeeperId,
    kind: instance.transportKind,
    target: instance.target || instance.displayName,
  });
  return {
    result: {
      gateId,
      gatekeeperId,
      publishedOperationNames,
      skippedOperationNames: imported.skipped.map((entry) => entry.name),
      linkedExisting: resolution.kind === 'link',
      ...(drift !== undefined ? { drift } : {}),
    },
    resourceType: 'gatekeeper',
    resourceId: gatekeeperId,
  };
};

/**
 * `preview_gate_instance_enable` (S8 W2-K2, audit J3): the console ConfirmTier's read model for
 * `enable_gate_instance` above — same `requireAvailable`/`resolveGateLinkTarget`/manifest-parse
 * calls, never a parallel reimplementation, and writes nothing (no advisory lock needed either:
 * there is nothing here a concurrent call could race on the *result* of, only its own read). For
 * each Operation the gate's manifest announces right now: no existing row, or the existing row is
 * still a `draft` (any origin) → `operationsToImport` (this is exactly what `importManifest`
 * would write over — see that function's own doc comment on which rows a draft-write replaces);
 * `published`/`deprecated` → `operationsAlreadyPresent`, with `differs` flagging a mismatch
 * against the announced manifest (audit CO2) that this preview surfaces but never corrects.
 */
export const previewGateInstanceEnableHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
) => {
  const { gateId } = params as { gateId: string };
  const instance = await requireAvailable(client, gateId);
  const resolution = await resolveGateLinkTarget(client, workspaceId, instance);
  const targetGatekeeperId =
    resolution.kind === 'link' ? resolution.existing.gatekeeperId : undefined;

  const operations = operationsOf(await rawOperations(client, gateId));
  const operationsToImport: {
    name: string;
    mode: Operation['mode'];
    blastRadius: Operation['blast_radius'];
    autoApprovable: boolean;
    description?: string;
  }[] = [];
  const operationsAlreadyPresent: {
    name: string;
    existing: {
      mode: Operation['mode'];
      blastRadius: Operation['blast_radius'];
      autoApprovable: boolean;
      status: PublishableStatus;
    };
    announced: {
      mode: Operation['mode'];
      blastRadius: Operation['blast_radius'];
      autoApprovable: boolean;
    };
    differs: boolean;
  }[] = [];

  for (const operation of operations) {
    const existingRecord = targetGatekeeperId
      ? await getOperation(client, workspaceId, targetGatekeeperId, operation.name)
      : null;
    if (existingRecord === null || existingRecord.status === 'draft') {
      operationsToImport.push({
        name: operation.name,
        mode: operation.mode,
        blastRadius: operation.blast_radius,
        autoApprovable: operation.auto_approvable,
        ...(operation.description !== undefined ? { description: operation.description } : {}),
      });
      continue;
    }
    const announced = {
      mode: operation.mode,
      blastRadius: operation.blast_radius,
      autoApprovable: operation.auto_approvable,
    };
    const existingFields = {
      mode: existingRecord.operation.mode,
      blastRadius: existingRecord.operation.blast_radius,
      autoApprovable: existingRecord.operation.auto_approvable,
      status: existingRecord.status,
    };
    // S8 W3-K1: the exact comparison `refresh_operation_governance` (governance/gatekeepers/
    // manifest.ts's `diffOperationGovernanceFields`) reuses for its own write decision — one
    // judgment function, never two that could drift.
    operationsAlreadyPresent.push({
      name: operation.name,
      existing: existingFields,
      announced,
      differs: diffOperationGovernanceFields(existingFields, announced).differs,
    });
  }

  return {
    result: {
      gateId,
      wouldLink:
        resolution.kind === 'link'
          ? {
              gatekeeperId: resolution.existing.gatekeeperId,
              drift: computeGateLinkDrift(resolution.existing, instance),
            }
          : null,
      ambiguousCandidates: resolution.kind === 'ambiguous' ? resolution.candidateIds : [],
      operationsToImport,
      operationsAlreadyPresent,
    },
    resourceType: 'gate_instance',
    resourceId: gateId,
  };
};

/**
 * `refresh_operation_governance(gatekeeperId, operationNames?)` (S8 W3-K1, leftover 79, audit
 * CO2): the owner-authorized write half of `preview_gate_instance_enable`'s `differs` flag —
 * applies the gate's currently-announced `mode`/`blastRadius`/`autoApprovable` to every selected,
 * already-deployed Operation of `gatekeeperId` whose fields disagree with it. `gatekeeperId` here
 * is the workspace's own Gatekeeper Object id (not a platform `gateId`) — `findGateLinkByGatekeeper`
 * resolves which platform gate instance's manifest (if any) it was enabled from.
 *
 * No linked gate instance (a legacy `register-gatekeeper`/`create_connection` registration, or one
 * this workspace never enabled through the platform catalog) → `GateInstanceNotAvailableError`
 * (`no_announced_manifest`), before any write. The domain write itself
 * (`governance/gatekeepers/manifest.ts`'s `refreshOperationGovernance`) is in-place, not a new
 * Operation version — see that module's own doc comment for why.
 *
 * One AuditRecord per refreshed Operation, in the same transaction as its write — complementary to
 * `application/gateway/dispatch.ts`'s own per-call audit row (which only carries `params`, not the
 * before/after this domain transition needs), the same "two rows, not duplicates" split
 * `governance/approval/transition-log.ts`'s `recordTransition` documents for its own module.
 */
export const refreshOperationGovernanceHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  if (!ctx?.principal) {
    throw new Error('refresh_operation_governance: no resolved human principal in context');
  }
  const { gatekeeperId, operationNames } = params as {
    gatekeeperId: string;
    operationNames?: readonly string[];
  };

  const link = await findGateLinkByGatekeeper(client, workspaceId, gatekeeperId);
  if (!link) {
    throw new GateInstanceNotAvailableError(
      'no_announced_manifest',
      `gatekeeper "${gatekeeperId}" has no linked platform gate instance — there is no announced manifest to refresh from`,
    );
  }

  const announcedOperations = operationsOf(await rawOperations(client, link.gateId));
  const outcome = await refreshOperationGovernance(client, workspaceId, {
    gatekeeperId,
    announcedOperations,
    ...(operationNames !== undefined ? { operationNames } : {}),
  });

  for (const entry of outcome.refreshed) {
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: ctx.principal.id,
      action: 'operation.governance_refreshed',
      resourceType: 'operation',
      resourceId: `${gatekeeperId}:${entry.name}`,
      payload: {
        gatekeeperId,
        name: entry.name,
        before: entry.before,
        after: entry.after,
        direction: entry.direction,
      },
    });
  }

  return {
    result: {
      gatekeeperId,
      refreshed: outcome.refreshed,
      unchanged: outcome.unchanged,
    },
    resourceType: 'gatekeeper',
    resourceId: gatekeeperId,
  };
};

/** The announced manifest as stored (`gate_instances.operations`), not the wire projection. */
async function rawOperations(client: PoolClient, gateId: string): Promise<unknown> {
  const result = await client.query<{ operations: unknown }>(
    'select operations from gate_instances where gate_id = $1',
    [gateId],
  );
  return result.rows[0]?.operations ?? [];
}
