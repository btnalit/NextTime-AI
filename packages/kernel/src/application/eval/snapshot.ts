import { createHash } from 'node:crypto';
import { canonicalJson } from '@nexttime/gatekeeper-base';
import type { EvalFixtureGateLiveState, EvalFixtureOperationWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  getGatekeeper,
  listPublishedOperationsForGatekeepers,
} from '../../governance/gatekeepers/index.js';
import { shownFreeText } from '../../governance/redaction/index.js';

/**
 * application/eval/snapshot: what a fixture gate freezes of a real gate (S10 E3-1a, fork 3 = a) —
 * its name and its published Operations, as `list_allowed_operations` shows them to an agent: the
 * tool names an evaluated Worker sees are `<gate name>.<operation name>`, with the Operation's
 * definition behind each. Every published Operation is kept, observe and execute alike (an
 * execute-class call is only ever simulated, E3-2). Stored whole in `eval_fixture_gates.snapshot`
 * and named by `snapshotDigest`, the same `sha256:` over canonical JSON the Operation digests use;
 * a gate whose snapshot taken now has another digest has changed.
 */

export interface FixtureOperationSnapshot {
  readonly name: string;
  readonly version: number;
  /** The published Operation's definition, as stored (`OperationRecord.operation`). */
  readonly operation: Record<string, unknown>;
}

export interface FixtureGateSnapshot {
  readonly gateName: string;
  /** By name. */
  readonly operations: readonly FixtureOperationSnapshot[];
}

export function snapshotDigest(snapshot: FixtureGateSnapshot): string {
  return `sha256:${createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex')}`;
}

/** The gate's snapshot now, or `null` when there is nothing to freeze: no such Gatekeeper in the
 *  workspace, or it publishes no Operation. */
export async function readGateSnapshot(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<FixtureGateSnapshot | null> {
  const gate = await getGatekeeper(client, workspaceId, gatekeeperId);
  if (gate === null) return null;
  const records = await listPublishedOperationsForGatekeepers(client, workspaceId, [gatekeeperId]);
  if (records.length === 0) return null;
  const operations = records
    .map((record) => ({
      name: record.name,
      version: record.version,
      operation: record.operation as unknown as Record<string, unknown>,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { gateName: gate.name, operations };
}

/** A frozen snapshot's live state against the gate's snapshot now (`null`: nothing to freeze). */
export function liveStateOf(
  storedDigest: string,
  current: FixtureGateSnapshot | null,
): EvalFixtureGateLiveState {
  if (current === null) return 'unavailable';
  return snapshotDigest(current) === storedDigest ? 'same' : 'changed';
}

/** Which Operations a sync adds, removes and changes (another version or definition), by name. */
export function diffSnapshots(
  before: FixtureGateSnapshot,
  after: FixtureGateSnapshot,
): {
  readonly addedOperations: string[];
  readonly removedOperations: string[];
  readonly changedOperations: string[];
} {
  const old = new Map(before.operations.map((op) => [op.name, op]));
  const now = new Map(after.operations.map((op) => [op.name, op]));
  const addedOperations = [...now.keys()].filter((name) => !old.has(name)).sort();
  const removedOperations = [...old.keys()].filter((name) => !now.has(name)).sort();
  const changedOperations = [...now.entries()]
    .filter(([name, op]) => {
      const was = old.get(name);
      return (
        was !== undefined &&
        (was.version !== op.version || canonicalJson(was.operation) !== canonicalJson(op.operation))
      );
    })
    .map(([name]) => name)
    .sort();
  return { addedOperations, removedOperations, changedOperations };
}

/** One frozen Operation as the console shows it. */
export function fixtureOperationWire(op: FixtureOperationSnapshot): EvalFixtureOperationWire {
  const definition = op.operation;
  const description = definition.description;
  const params = definition.params_schema;
  return {
    name: op.name,
    version: op.version,
    mode: definition.mode === 'execute' ? 'execute' : 'observe',
    description: typeof description === 'string' ? shownFreeText(description) : null,
    paramsSchema:
      params !== null && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {},
  };
}
