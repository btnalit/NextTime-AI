import type { Operation, PrincipalKind, PublishableStatus } from '@nexttime/shared';
import { IllegalTransition, PUBLISHABLE_TRANSITIONS, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import {
  registerOperationDraftObject,
  setOperationStatusObject,
} from '../../substrate/ontology/index.js';

/**
 * governance/gatekeepers/manifest: Operation manifest import (draft) + publish/deprecate (design
 * doc §5.1.4 InterfaceManifest/Operation, §5.4 I16/I17, §5.5 `draft -> published -> deprecated`;
 * docs/development-tasks.md S2.4 "propose_operation 产草稿，owner 发布"). Owns the
 * transition-checking policy `substrate/ontology/meta-objects.ts`'s dumb Object-projection
 * helpers deliberately do not (see that file's own doc comment).
 */

const graphStore = new SqlGraphStore();

export interface OperationRecord {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly operation: Operation;
  readonly status: PublishableStatus;
}

function toOperationRecord(
  gatekeeperId: string,
  name: string,
  properties: Record<string, unknown>,
): OperationRecord {
  const { status, ...operationFields } = properties as Record<string, unknown> & {
    status?: PublishableStatus;
  };
  return {
    gatekeeperId,
    name,
    operation: operationFields as unknown as Operation,
    status: status ?? 'draft',
  };
}

export class OperationNotFoundError extends Error {
  constructor(gatekeeperId: string, name: string) {
    super(`Operation not found: gatekeeper ${gatekeeperId}, name "${name}"`);
    this.name = 'OperationNotFoundError';
  }
}

// -------------------------------------------------------------------------------------------
// importManifest / proposeOperation — always produce drafts (I16).
// -------------------------------------------------------------------------------------------

export interface ImportManifestInput {
  readonly gatekeeperId: string;
  readonly operations: readonly Operation[];
  readonly proposedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
}

/** Imports a whole manifest (e.g. from `importOpenApi`/`importMcpTools`, or a hand-written YAML
 *  接入包) as draft Operation Objects — one per entry, all `status: 'draft'` regardless of the
 *  transport's own suggested defaults (I17: nothing is auto-approvable until an owner reviews and
 *  publishes it). */
export async function importManifest(
  client: PoolClient,
  workspaceId: string,
  input: ImportManifestInput,
): Promise<readonly OperationRecord[]> {
  const records: OperationRecord[] = [];
  for (const operation of input.operations) {
    await registerOperationDraftObject(client, workspaceId, {
      gatekeeperId: input.gatekeeperId,
      name: operation.name,
      operation,
      proposedBy: input.proposedBy,
      activityId: input.activityId,
    });
    records.push({
      gatekeeperId: input.gatekeeperId,
      name: operation.name,
      operation,
      status: 'draft',
    });
  }
  return records;
}

export interface ProposeOperationInput {
  readonly gatekeeperId: string;
  readonly operation: Operation;
  readonly proposedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
}

/** `propose_operation` (single-entry variant of `importManifest`, capabilities.ts `meta` group):
 *  an agent that explored a Gatekeeper proposes one concrete, classified Operation as a draft. */
export async function proposeOperation(
  client: PoolClient,
  workspaceId: string,
  input: ProposeOperationInput,
): Promise<OperationRecord> {
  const [record] = await importManifest(client, workspaceId, {
    gatekeeperId: input.gatekeeperId,
    operations: [input.operation],
    proposedBy: input.proposedBy,
    activityId: input.activityId,
  });
  if (!record) throw new Error('proposeOperation: importManifest produced no record');
  return record;
}

// -------------------------------------------------------------------------------------------
// reads
// -------------------------------------------------------------------------------------------

/** Reads one Operation regardless of status, or `null` if it does not exist. */
export async function getOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord | null> {
  const object = await graphStore.getObjectByIdentity(client, workspaceId, 'Operation', {
    gatekeeperId,
    name,
  });
  if (!object) return null;
  return toOperationRecord(gatekeeperId, name, object.properties);
}

/**
 * Resolves a **published** Operation only — `null` for a draft, deprecated, or unknown one. I17:
 * "resolve the published Operation (draft/unknown → I17: treat as unclassified require_approval,
 * never execute)" — the caller (`request_action`'s handler) is expected to treat `null` here
 * uniformly as "unclassified", not distinguish "no such Operation" from "not published yet".
 */
export async function getPublishedOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord | null> {
  const record = await getOperation(client, workspaceId, gatekeeperId, name);
  return record && record.status === 'published' ? record : null;
}

interface OperationObjectRow {
  identity_key: { gatekeeperId?: string; name?: string } | null;
  properties: Record<string, unknown>;
}

/**
 * `list_allowed_operations` (S2.9, task brief: "the published Operations of the Gatekeepers in
 * the Handle's resources.gatekeeper scope") — every **published** Operation across a set of
 * Gatekeeper instance ids, one direct query rather than N `getOperation` round trips. Same direct-
 * SQL-over-`objects` style `substrate/graph/find-means.ts` already established for meta-ontology
 * reads (an Operation has no dedicated relational table, §9.2). Returns `[]` for an empty
 * `gatekeeperIds` (nothing to list, not "list everything").
 */
export async function listPublishedOperationsForGatekeepers(
  client: PoolClient,
  workspaceId: string,
  gatekeeperIds: readonly string[],
): Promise<readonly OperationRecord[]> {
  if (gatekeeperIds.length === 0) return [];
  const result = await client.query<OperationObjectRow>(
    `select identity_key, properties
     from objects
     where workspace_id = $1
       and object_type = 'Operation'
       and identity_key ->> 'gatekeeperId' = any($2::text[])
       and properties ->> 'status' = 'published'
     order by updated_at asc`,
    [workspaceId, gatekeeperIds],
  );
  const records: OperationRecord[] = [];
  for (const row of result.rows) {
    const gatekeeperId = row.identity_key?.gatekeeperId;
    const name = row.identity_key?.name;
    if (!gatekeeperId || !name) continue; // defensive — every Operation Object is upserted with both
    records.push(toOperationRecord(gatekeeperId, name, row.properties));
  }
  return records;
}

// -------------------------------------------------------------------------------------------
// publish / deprecate — human channel only (enforced at the capability-registry layer, I16).
// -------------------------------------------------------------------------------------------

async function requireOperation(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
  name: string,
): Promise<OperationRecord> {
  const record = await getOperation(client, workspaceId, gatekeeperId, name);
  if (!record) throw new OperationNotFoundError(gatekeeperId, name);
  return record;
}

export interface PublishOperationInput {
  readonly gatekeeperId: string;
  readonly name: string;
}

/** Publishes a draft Operation. Throws `OperationNotFoundError` if unknown, `IllegalTransition`
 *  (`@nexttime/shared`) if not currently `draft`. */
export async function publishOperation(
  client: PoolClient,
  workspaceId: string,
  input: PublishOperationInput,
): Promise<OperationRecord> {
  const existing = await requireOperation(client, workspaceId, input.gatekeeperId, input.name);
  transition(PUBLISHABLE_TRANSITIONS, existing.status, 'publish');
  await setOperationStatusObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name },
    'published',
  );
  return { ...existing, status: 'published' };
}

export interface DeprecateOperationInput {
  readonly gatekeeperId: string;
  readonly name: string;
}

/** Deprecates a published Operation. Throws `OperationNotFoundError` if unknown, `IllegalTransition`
 *  if not currently `published`. */
export async function deprecateOperation(
  client: PoolClient,
  workspaceId: string,
  input: DeprecateOperationInput,
): Promise<OperationRecord> {
  const existing = await requireOperation(client, workspaceId, input.gatekeeperId, input.name);
  transition(PUBLISHABLE_TRANSITIONS, existing.status, 'deprecate');
  await setOperationStatusObject(
    client,
    workspaceId,
    { gatekeeperId: input.gatekeeperId, name: input.name },
    'deprecated',
  );
  return { ...existing, status: 'deprecated' };
}

export { IllegalTransition };
