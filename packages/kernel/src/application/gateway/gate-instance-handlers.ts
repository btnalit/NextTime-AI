import type { GateInstanceWire, Operation } from '@nexttime/shared';
import { mintGateHostToken } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  assertConnectionParamsCarryNoCredentials,
  redactConnectionAddress,
} from '../../governance/connections/index.js';
import {
  type GatekeeperByEndpointEntry,
  GatekeeperNotFoundError,
  findGatekeepersByEndpoint,
  getGatekeeper,
  listPublishedOperationsForGatekeepers,
  operationRecordDigestOrNull,
  refreshOperationGovernance,
} from '../../governance/gatekeepers/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import {
  assertSelfConnectionNotSuspended,
  definitionRefusal,
  droppedUntilAdopted,
  findGateLinkByGate,
  findGateLinkByGatekeeper,
  getConnector,
  getGateInstance,
  landGatekeeper,
  listAvailableGateInstances,
  manifestDigest,
  operationsOf,
  readGateDefinitions,
} from '../gates/index.js';
import { getConfiguredTaskRuntime } from '../task/runtime.js';
import { compareAnnouncedOperations } from './announced-operations.js';
import type { CapabilityHandler } from './capability-handler.js';
import { connectionGatekeeperClient } from './connection-handlers.js';
import { platformGateIdForEndpoint, resolveGateTarget } from './gate-target.js';
import { gateHostCredentialUrl } from './platform-gates-handlers.js';

/**
 * application/gateway/gate-instance-handlers: the workspace half of P-B1 (docs/platform-admin-
 * design.md §6.3 "平台预置（管理员建实例、工作区一键启用）"; development-tasks.md P-B 决定 ①) —
 * `list_available_gate_instances` / `enable_gate_instance`, `scope:'workspace'`, owner.
 *
 * Enabling is the catalog source of the one landing path (`application/gates/landing.ts`, P0b):
 * one Activity, `registerGatekeeper` (or the existing Gatekeeper at the endpoint, below),
 * `importManifest` (origin `import`), `publishImportedDrafts` for every imported draft (one
 * declaring a gate-owned param stays a draft, legacy J), the `workspace_gate_links` row that lets
 * the approval decision read the instance's `trust` and the connector's deny list live, and
 * `ConnectionCreated`. This handler checks what only the catalog decides — the instance is
 * available, the manifest is the one previewed (R-18), which existing Gatekeeper to link — then
 * hands the landing exactly that. It runs on the workspace plane on purpose: `registerGatekeeper`
 * and the Activity need a real Principal, which the platform plane does not have; an administrator
 * who is not a member delegates first. Idempotent per (workspace, gate): a second call returns the
 * existing Gatekeeper.
 *
 * **Endpoint-association (S8 W2-K2, leftover 73, ui-audit J3/J4/B7)**: `registerGatekeeper` has no
 * identity key of its own, so a workspace that already had a Gatekeeper for the same running gate
 * (a self connection whose address became a platform instance's, or a registration from the
 * removed `register-gatekeeper` CLI) would get a *second* Gatekeeper + a second `ConnectedSystem`
 * + a duplicate set of published Operations every time "在本工作区启用" was clicked.
 * `resolveGateLinkTarget` below decides first, from every `Gatekeeper` Object in this workspace
 * whose own `endpoint` (the URL the kernel actually calls — not `name`/`target`, which a prior
 * registration and the instance are expected to disagree on) matches the instance's: exactly one
 * match → link it (no `registerGatekeeper`; the landing converts a self connection's origin row
 * into the link, and refuses one the platform suspended); zero → register a new one; more than one
 * → `ambiguous_existing_gatekeeper`, nothing written (never guess). Linking never rewrites the
 * existing Object's `name`/`target`/`transportKind`, nor any of its Operations' governance fields —
 * `drift` (in the result) surfaces a mismatch for a human to act on.
 *
 * `previewGateInstanceEnableHandler` below is the read-only twin the console's ConfirmTier calls
 * first (audit J3 "一键写入 ... 没有预览或确认"): it calls `resolveGateLinkTarget` and the same
 * manifest read (`readManifestInEffect`) this handler does, never a parallel reimplementation,
 * and never writes.
 *
 * **The manifest in effect (R-18, D-18)**: `gate_instances.operations` only changes when the gate
 * announces before the administrator decides, or when the administrator confirms a held
 * announcement (`confirm_gate_manifest`). The preview returns that manifest's digest; `enable`
 * (optionally) and `refresh_operation_governance` (always) take it back and refuse
 * `manifest_changed` when the manifest moved in between, so neither applies values the owner did
 * not see.
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
    // platform gate instance and is no gate the workspace connected itself either — its endpoint
    // is a catalog instance's, registered outside the catalog (legacy 214 narrowed it to this).
    | 'no_announced_manifest'
    // Legacy 214: `preview_gatekeeper_resync` on a Gatekeeper linked to a platform gate instance —
    // its manifest is the one the platform adopted, aligned through `preview_gate_instance_enable`;
    // asking the gate directly would skip the administrator's review (R-18).
    | 'gatekeeper_linked'
    // R-18 (D-18): the caller's `manifestDigest` (from `preview_gate_instance_enable`) is not the
    // digest of the manifest in effect any more — an administrator confirmed a newer one since.
    | 'manifest_changed'
    // L4-13 (S10 K4): the one existing Gatekeeper sharing the instance's endpoint is already
    // linked to a *different* platform gate instance (the same endpoint redeployed under a new
    // GATE_ID) — a second link would leave trust and the disabled-Operation list undetermined
    // (core 0042 makes it impossible; this refuses it with a reason first).
    | 'gatekeeper_already_linked';
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
 *  refuse/report it rather than pick one. L4-13: a single match already linked to another gate
 *  instance refuses `gatekeeper_already_linked` (both callers — the preview never offers a link
 *  the enable would refuse). */
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
    const linked = await findGateLinkByGatekeeper(client, workspaceId, existing.gatekeeperId);
    if (linked && linked.gateId !== instance.gateId) {
      throw new GateInstanceNotAvailableError(
        'gatekeeper_already_linked',
        `Gatekeeper ${existing.gatekeeperId} (the one existing Gatekeeper at gate instance "${instance.gateId}"'s endpoint) is already linked to gate instance "${linked.gateId}" — one Gatekeeper takes one gate instance link; retire the old instance's link before enabling this one`,
      );
    }
    // P0b: a self connection the platform suspended is never linked (the landing re-checks).
    await assertSelfConnectionNotSuspended(client, workspaceId, existing.gatekeeperId);
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
    // Compared as stored, shown as every gate address is (`redactConnectionAddress`, #620 review M2).
    drift.target = {
      existing: redactConnectionAddress('target', existing.target),
      instance: redactConnectionAddress('target', instance.target),
    };
  }
  if (existing.transportKind !== instance.transportKind) {
    drift.transportKind = { existing: existing.transportKind, instance: instance.transportKind };
  }
  return drift;
}

export const listAvailableGateInstancesHandler: CapabilityHandler = async (client, workspaceId) => {
  return { result: { items: await listAvailableGateInstances(client, workspaceId) } };
};

/** R-18 (D-18): the manifest in effect and its digest, read once — the caller applies exactly
 *  these operations after checking `expectedDigest` (when given) against this digest, so what it
 *  writes is always the version the human previewed. */
async function readManifestInEffect(
  client: PoolClient,
  gateId: string,
  expectedDigest: string | undefined,
): Promise<{ operations: Operation[]; digest: string }> {
  const raw = await rawOperations(client, gateId);
  const digest = manifestDigest(raw);
  if (expectedDigest !== undefined && expectedDigest !== digest) {
    throw new GateInstanceNotAvailableError(
      'manifest_changed',
      `gate instance "${gateId}"'s manifest changed since it was previewed — preview it again`,
    );
  }
  return { operations: operationsOf(raw), digest };
}

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
  const { gateId, manifestDigest: expectedDigest } = params as {
    gateId: string;
    manifestDigest?: string;
  };
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
        gateOwnedParamDrafts: [],
        absentAnswerDrafts: [],
        // This call made no link/create decision at all — it just returned the prior outcome.
        linkedExisting: false,
      },
      resourceType: 'gatekeeper',
      resourceId: existing.gatekeeperObjectId,
    };
  }
  const instance = await requireAvailable(client, gateId);
  // Review of #549 (legacy 186, gate-instance half): an instance created or announced before the
  // address rule carries its target into this workspace's Gatekeeper, ConnectedSystem, Activity and
  // `ConnectionCreated` — refused until an administrator recreates it without the credential.
  assertConnectionParamsCarryNoCredentials('enable_gate_instance', { target: instance.target });
  // Checked before anything is written; the same read supplies what is imported below.
  const { operations } = await readManifestInEffect(client, gateId, expectedDigest);

  const resolution = await resolveGateLinkTarget(client, workspaceId, instance);
  if (resolution.kind === 'ambiguous') {
    throw new GateInstanceNotAvailableError(
      'ambiguous_existing_gatekeeper',
      `gate instance "${gateId}"'s endpoint matches more than one existing Gatekeeper in this workspace (${resolution.candidateIds.join(', ')}) — resolve the duplicate before enabling`,
    );
  }

  // P0b: the one landing path — registers (or links) the Gatekeeper, imports and publishes the
  // manifest, writes the link (the origin record) and emits `ConnectionCreated`.
  const landed = await landGatekeeper(
    client,
    workspaceId,
    { id: ctx.principal.id, kind: ctx.principal.kind },
    {
      kind: 'catalog',
      instance,
      operations,
      existing: resolution.kind === 'link' ? resolution.existing : null,
    },
  );
  const drift =
    resolution.kind === 'link' ? computeGateLinkDrift(resolution.existing, instance) : undefined;
  return {
    result: {
      gateId,
      gatekeeperId: landed.gatekeeperId,
      publishedOperationNames: landed.publishedOperationNames,
      skippedOperationNames: landed.skippedOperationNames,
      gateOwnedParamDrafts: landed.gateOwnedParamDrafts,
      absentAnswerDrafts: landed.absentAnswerDrafts,
      linkedExisting: landed.linkedExisting,
      ...(drift !== undefined ? { drift } : {}),
    },
    resourceType: 'gatekeeper',
    resourceId: landed.gatekeeperId,
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
 * against the announced manifest (audit CO2) that this preview surfaces but never corrects, and
 * `direction` (R-19, D-17) the kernel's classification of that change. `manifestDigest` names the
 * manifest every row was computed from (module doc comment).
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

  const { operations, digest } = await readManifestInEffect(client, gateId, undefined);
  // Legacy K: what the gate runs right now, to say which listed Operation it refuses until the
  // platform adopts its held announcement (definition-drift.ts).
  const definitions = await readGateDefinitions(client, gateId);
  const awaitingAdoption: string[] = [];
  // UX acceptance of #579 (legacy 297): the subset adopting removes rather than restores.
  const droppedByGate: string[] = [];
  const droppedFromGate = (name: string) =>
    definitions !== null && droppedUntilAdopted(definitions, name);
  const noteAdoption = (name: string, approvedDigest: string | null) => {
    if (
      definitions &&
      definitionRefusal(definitions, name, approvedDigest) === 'platform_adoption'
    ) {
      awaitingAdoption.push(name);
      if (droppedFromGate(name)) droppedByGate.push(name);
    }
  };
  const { operationsToImport, operationsAlreadyPresent, records } =
    await compareAnnouncedOperations(
      client,
      workspaceId,
      targetGatekeeperId,
      operations,
      droppedFromGate,
      'platform',
    );
  operations.forEach((operation, index) => {
    const existingRecord = records[index] ?? null;
    // Importing publishes the manifest in effect's definition; a deployed row runs its own.
    noteAdoption(
      operation.name,
      existingRecord === null || existingRecord.status === 'draft'
        ? (definitions?.adopted.get(operation.name) ?? null)
        : operationRecordDigestOrNull(existingRecord),
    );
  });

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
      manifestDigest: digest,
      awaitingPlatformAdoption:
        awaitingAdoption.length > 0 && definitions?.pendingAnnouncedAt
          ? {
              announcedAt: definitions.pendingAnnouncedAt.toISOString(),
              operations: awaitingAdoption.sort(),
              ...(droppedByGate.length > 0 ? { dropped: droppedByGate.sort() } : {}),
            }
          : null,
    },
    resourceType: 'gate_instance',
    resourceId: gateId,
  };
};

/**
 * `refresh_operation_governance(gatekeeperId, operationNames?)` (S8 W3-K1, leftover 79, audit
 * CO2): the owner-authorized write half of `preview_gate_instance_enable`'s `differs` flag —
 * applies the gate's currently-announced governance fields (`mode`, `blastRadius`, `autoApprovable`,
 * `awaitDecision`, `reads`, `writes` and the MCP hints — STATUS leftover 344) to every selected,
 * already-deployed Operation of `gatekeeperId` whose fields disagree with it. `gatekeeperId` here
 * is the workspace's own Gatekeeper Object id (not a platform `gateId`) — `findGateLinkByGatekeeper`
 * resolves which platform gate instance's manifest (if any) it was enabled from.
 *
 * No linked gate instance: a gate the workspace connected itself (`create_connection`) re-syncs to
 * what it describes now (legacy 214, `gatekeeper-resync.ts` — the preview is
 * `preview_gatekeeper_resync`, and a name it describes that the workspace never had is imported as
 * a draft — a linked gate's align imports a name its adopted manifest gained the same way, P0b); one whose endpoint is a catalog instance's but was never enabled through the catalog
 * (connected before `create_connection` checked that, or by the removed `register-gatekeeper`
 * CLI) → `GateInstanceNotAvailableError` (`no_announced_manifest`), before any write — enabling
 * that instance links it (the landing converts its origin). A suspended self connection →
 * `GatekeeperLandingRefusedError` (`self_connection_suspended`). The domain write itself
 * (`governance/gatekeepers/manifest.ts`'s `refreshOperationGovernance`) is in-place, not a new
 * Operation version — see that module's own doc comment for why. R-18 (D-18): `manifestDigest`
 * is the preview's digest; a different manifest in effect refuses `manifest_changed` before any
 * write, and the values applied come from the same read the digest was checked against.
 *
 * One AuditRecord per refreshed Operation, in the same transaction as its write —
 * `refreshOperationGovernance` writes it with the write itself (legacy 482: the database refuses
 * the write without it, core 0047). Complementary to `application/gateway/dispatch.ts`'s own
 * per-call audit row (which only carries `params`, not the before/after this domain transition
 * needs), the same "two rows, not duplicates" split `governance/approval/transition-log.ts`'s
 * `recordTransition` documents for its own module.
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
  const {
    gatekeeperId,
    operationNames,
    manifestDigest: expectedDigest,
  } = params as {
    gatekeeperId: string;
    operationNames?: readonly string[];
    manifestDigest: string;
  };

  const link = await findGateLinkByGatekeeper(client, workspaceId, gatekeeperId);
  let announcedOperations: Operation[];
  let droppedByGate: ReadonlySet<string>;
  if (link) {
    // R-18 (D-18): apply exactly the reviewed manifest — the digest the owner's preview showed
    // must still be the manifest in effect, and the operations applied come from that same read.
    ({ operations: announcedOperations } = await readManifestInEffect(
      client,
      link.gateId,
      expectedDigest,
    ));
    // UX acceptance of #583 (P3-2): what the gate itself no longer runs gets no draft — adopting
    // its held manifest removes it, so publishing one would bring no call back (the preview's
    // `awaitingPlatformAdoption.dropped` and `pendingDraft.rewritable` say the same).
    const definitions = await readGateDefinitions(client, link.gateId);
    droppedByGate = new Set(
      definitions === null
        ? []
        : announcedOperations
            .map((operation) => operation.name)
            .filter((name) => droppedUntilAdopted(definitions, name)),
    );
  } else {
    // Legacy 214: a gate the workspace connected itself has no platform manifest — what it runs
    // is what it describes now. The same digest binding: the gate re-described between the
    // owner's `preview_gatekeeper_resync` and this confirm refuses `manifest_changed`.
    ({ operations: announcedOperations } = await readSelfConnectedManifest(
      client,
      workspaceId,
      gatekeeperId,
      expectedDigest,
    ));
    droppedByGate = new Set();
  }
  // Legacy K: the revision drafts a changed definition gets are written under this Activity.
  const activity = await startActivity(client, workspaceId, {
    kind: 'governance.refresh_operation_governance',
    principalId: ctx.principal.id,
    metadata: link ? { gatekeeperId, gateId: link.gateId } : { gatekeeperId, source: 'gate' },
  });
  const outcome = await refreshOperationGovernance(client, workspaceId, {
    gatekeeperId,
    announcedOperations,
    ...(operationNames !== undefined ? { operationNames } : {}),
    proposedBy: { id: ctx.principal.id, kind: ctx.principal.kind },
    activityId: activity.id,
    droppedByGate,
    // Either source imports what the manifest now carries and the workspace never had, as drafts
    // (legacy 214; P0b for a linked platform gate). Since nobody reviewed a self-connected gate's
    // own description, what it loosens also waits for a publish (review #493 on #612).
    source: link ? 'platform' : 'gate',
  });
  await endActivity(client, workspaceId, activity.id, 'completed');

  for (const draft of outcome.revisionDrafts) {
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: ctx.principal.id,
      action: 'operation.revision_drafted',
      resourceType: 'operation',
      resourceId: draft.id,
      payload: {
        gatekeeperId,
        name: draft.name,
        version: draft.version,
        draftOf: draft.draftOf ?? null,
        replaced: draft.replaced,
        // `new_on_gate`: the gate's own description (legacy 214); `new_in_adopted_manifest`: the
        // platform instance's manifest in effect (P0b, #612 P2).
        reason: draft.newName
          ? link
            ? 'new_in_adopted_manifest'
            : 'new_on_gate'
          : draft.governanceLoosened && !draft.governanceLoosened.definitionChanged
            ? 'governance_loosened'
            : 'definition_changed',
        // Review #493 on #612 (M1): a loosening the revision carries instead of an in-place write.
        ...(draft.governanceLoosened
          ? { governanceDirection: draft.governanceLoosened.direction }
          : {}),
      },
    });
  }

  return {
    result: {
      gatekeeperId,
      // `entry.id` is kernel-internal bookkeeping for the domain function's AuditRecord, not part of
      // this capability's wire result shape (`RefreshOperationGovernanceResultWireSchema` has no `id`).
      refreshed: outcome.refreshed.map(({ id: _id, ...rest }) => rest),
      revisionDrafts: outcome.revisionDrafts.map(({ name, version }) => ({ name, version })),
      unchanged: outcome.unchanged,
    },
    resourceType: 'gatekeeper',
    resourceId: gatekeeperId,
  };
};

// -------------------------------------------------------------------------------------------
// Legacy 214: a gate the workspace connected itself — re-describe → preview the diff → open the
// revisions. The same comparison (`compareAnnouncedOperations`) and the same write
// (`refresh_operation_governance` → `refreshOperationGovernance`) as a platform gate's align; only
// where the announced manifest comes from differs.
// -------------------------------------------------------------------------------------------

/**
 * What a self-connected gate runs right now: its own `describe_operations`, read through the
 * credential every call to it carries (`resolveGateTarget` — the Gatekeeper's connection secret).
 * The gate refuses calls made under any other definition (legacy K), so this, not the copy
 * `create_connection` imported (possibly from a `manifestSource` that never matched the gate's own
 * file), is what the workspace has to publish for its calls to run.
 *
 * Refused before contacting anything: a Gatekeeper linked to a platform gate instance
 * (`gatekeeper_linked` — its manifest is the one the platform adopted, R-18; asking the gate
 * directly would skip that review), a self connection the platform suspended
 * (`self_connection_suspended`, P0b), and one whose endpoint is a catalog instance's but was never
 * enabled through the catalog (`no_announced_manifest` — that gate is called with the platform
 * credential, and only the catalog's adopted manifest speaks for it; such a Gatekeeper predates
 * the endpoint check `create_connection` makes, or the removed `register-gatekeeper` CLI made
 * it). `manifestDigest` binds a write to the description the owner previewed, as
 * `readManifestInEffect` does for a platform gate.
 * Entries that do not parse as an Operation are left out, as `operationsOf` does for a stored
 * manifest.
 */
export async function readSelfConnectedManifest(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  expectedDigest: string | undefined,
): Promise<{ operations: Operation[]; digest: string }> {
  const record = await getGatekeeper(client, workspaceId, gatekeeperId);
  if (!record) throw new GatekeeperNotFoundError(gatekeeperId);
  const link = await findGateLinkByGatekeeper(client, workspaceId, gatekeeperId);
  if (link) {
    throw new GateInstanceNotAvailableError(
      'gatekeeper_linked',
      `gatekeeper "${gatekeeperId}" is enabled from platform gate instance "${link.gateId}" — align it with that instance's announcement (preview_gate_instance_enable) instead`,
    );
  }
  // P0b: the platform suspended this connection — nothing re-syncs it, and the kernel does not
  // contact the gate on its behalf, until the platform resumes it.
  await assertSelfConnectionNotSuspended(client, workspaceId, gatekeeperId);
  const platformGateId = await platformGateIdForEndpoint(client, record.endpoint);
  if (platformGateId !== null) {
    throw new GateInstanceNotAvailableError(
      'no_announced_manifest',
      `gatekeeper "${gatekeeperId}" is at the address of platform gate instance "${platformGateId}" but was not enabled from the catalog — enable that instance (enable_gate_instance) to align with its announcement`,
    );
  }
  const target = await resolveGateTarget(client, workspaceId, record);
  const described = await connectionGatekeeperClient().describeOperations(target);
  const operations = operationsOf(described.operations);
  const digest = manifestDigest(operations);
  if (expectedDigest !== undefined && expectedDigest !== digest) {
    throw new GateInstanceNotAvailableError(
      'manifest_changed',
      `the gate behind gatekeeper "${gatekeeperId}" describes another manifest than the one previewed — preview it again`,
    );
  }
  return { operations, digest };
}

/**
 * `preview_gatekeeper_resync(gatekeeperId)` (legacy 214): the read-only half — the gate's current
 * description compared with what the workspace holds, through the same `compareAnnouncedOperations`
 * `preview_gate_instance_enable` uses. `operationsToImport` without `pendingDraft` are names the
 * workspace never had (the resync imports them as drafts); `notDescribed` are published names the
 * gate no longer describes (it refuses calls to them; nothing here deprecates them). Writes nothing.
 */
export const previewGatekeeperResyncHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
) => {
  const { gatekeeperId } = params as { gatekeeperId: string };
  const { operations, digest } = await readSelfConnectedManifest(
    client,
    workspaceId,
    gatekeeperId,
    undefined,
  );
  const { operationsToImport, operationsAlreadyPresent } = await compareAnnouncedOperations(
    client,
    workspaceId,
    gatekeeperId,
    operations,
    () => false,
    'gate',
  );
  const described = new Set(operations.map((operation) => operation.name));
  const published = await listPublishedOperationsForGatekeepers(client, workspaceId, [
    gatekeeperId,
  ]);
  const notDescribed = [
    ...new Set(published.map((row) => row.name).filter((name) => !described.has(name))),
  ].sort();
  return {
    result: {
      gatekeeperId,
      manifestDigest: digest,
      operationsToImport,
      operationsAlreadyPresent,
      notDescribed,
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
