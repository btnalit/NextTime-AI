import type {
  ConflictWire,
  ExplainResultWire,
  FactWire,
  ObjectWire,
  OntologyObjectTypeWire,
} from '@nexttime/shared';
import type {
  ProvenanceActivity,
  ProvenanceFact,
  ProvenanceSource,
} from '../components/ui/ProvenanceChain.js';

/**
 * lib/graph-view: wire → view mappers for the graph page (S6-D, docs/console-completion-plan.md
 * §5.7). Pure and unit-tested; the components under `components/graph/` only render what these
 * return. The wire shapes are `packages/shared/src/wire/graph.ts` (`ObjectWire`, `FactWire`,
 * `ExplainResultWire`, `ConflictWire`) and `wire/ontology.ts` (`OntologyObjectTypeWire`).
 */

/** uuid-ish (8-4-4-4-12 hex): an identity-key value shaped like this is another Object's id
 *  (`hostId`, `composeProjectId`, `gatekeeperId` — `ontology/ops-assets-v2.yaml`'s own convention),
 *  never a name a reader would recognise. */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidLike(value: unknown): boolean {
  return typeof value === 'string' && UUID_LIKE.test(value);
}

/** Property names a domain pack commonly uses for a human name, tried in this order before the
 *  identity key. Kept short and generic: the identity key (from the published ontology) is the
 *  authoritative "what makes this Object this Object" and is the fallback for every type. */
const NAME_PROPERTIES = ['name', 'displayName', 'title', 'label', 'hostname'] as const;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The display name of an Object (§5.9 principle 3, "id 永不裸露"): a name-like property first;
 * else the Object's identity-key values in the ObjectType's declared `identityKey` order (when
 * `identityKeys` — from `list_types{kind:'object'}` — is known; else in stored order), skipping
 * uuid-shaped values (foreign Object ids) and joining the rest with " / ". `undefined` when
 * nothing usable exists — the caller's `RefChip` then shows the grey bare-id fallback.
 */
export function objectDisplayName(
  object: Pick<ObjectWire, 'identityKey' | 'properties'>,
  identityKeys?: readonly string[],
): string | undefined {
  for (const key of NAME_PROPERTIES) {
    const value = nonEmptyString(object.properties[key]);
    if (value !== undefined && !isUuidLike(value)) return value;
  }
  const identity = object.identityKey;
  if (!identity) return undefined;
  const order = identityKeys ?? Object.keys(identity);
  const parts: string[] = [];
  for (const key of order) {
    const value = identity[key];
    if (value === undefined || value === null || isUuidLike(value)) continue;
    const text = typeof value === 'string' ? value : String(value);
    if (text.trim() !== '') parts.push(text);
  }
  return parts.length > 0 ? parts.join(' / ') : undefined;
}

/** `list_types{kind:'object'}` → `typeName → identityKey[]`, for `objectDisplayName`. */
export function identityKeysByType(
  types: readonly { readonly kind: string; readonly name: string; readonly identityKey?: readonly string[] }[],
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const type of types) {
    if (type.kind === 'object' && type.identityKey !== undefined)
      map.set(type.name, type.identityKey);
  }
  return map;
}

/** Only the ObjectType rows of a mixed `list_types` result, sorted by name. */
export function objectTypeOptions(
  types: readonly { readonly kind: string; readonly name: string }[],
): readonly OntologyObjectTypeWire[] {
  return types
    .filter((type): type is OntologyObjectTypeWire => type.kind === 'object')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

// -------------------------------------------------------------------------------------------
// Facts around an Object
// -------------------------------------------------------------------------------------------

/** Direction of a Fact relative to the focused Object: `out` = it is the source, `in` = the
 *  target, `self` = a self-link (both ends). */
export type FactDirection = 'out' | 'in' | 'self';

export function factDirection(
  fact: Pick<FactWire, 'sourceObjectId' | 'targetObjectId'>,
  objectId: string,
): FactDirection {
  const isSource = fact.sourceObjectId === objectId;
  const isTarget = fact.targetObjectId === objectId;
  if (isSource && isTarget) return 'self';
  return isSource ? 'out' : 'in';
}

/** The other end of a Fact, seen from `objectId` (the Object itself for a self-link). */
export function neighbourId(
  fact: Pick<FactWire, 'sourceObjectId' | 'targetObjectId'>,
  objectId: string,
): string {
  return fact.sourceObjectId === objectId ? fact.targetObjectId : fact.sourceObjectId;
}

export interface FactGroup {
  readonly key: string;
  readonly linkType: string;
  readonly direction: FactDirection;
  readonly facts: readonly FactWire[];
}

const DIRECTION_ORDER: Readonly<Record<FactDirection, number>> = { out: 0, in: 1, self: 2 };

/**
 * `state_at{objectId, at}.facts` grouped by (linkType, direction): outgoing before incoming,
 * link types alphabetical, Facts within a group newest-recorded first (the kernel's own order).
 * `state_at` returns every Fact touching the Object in both directions — what `traverse` depth 1
 * reaches, but with the full `FactWire` rows the Fact list needs (`traverse`'s wire result is
 * ids only; see the page's doc comment).
 */
export function groupFacts(facts: readonly FactWire[], objectId: string): readonly FactGroup[] {
  const groups = new Map<string, { linkType: string; direction: FactDirection; facts: FactWire[] }>();
  for (const fact of facts) {
    const direction = factDirection(fact, objectId);
    const key = `${fact.linkType}:${direction}`;
    const group = groups.get(key);
    if (group) group.facts.push(fact);
    else groups.set(key, { linkType: fact.linkType, direction, facts: [fact] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort(
      (a, b) =>
        a.linkType.localeCompare(b.linkType) ||
        DIRECTION_ORDER[a.direction] - DIRECTION_ORDER[b.direction],
    );
}

/** Distinct neighbour ids of a Fact list, in first-seen order (the Object itself excluded). */
export function neighbourIds(facts: readonly FactWire[], objectId: string): readonly string[] {
  const seen = new Set<string>();
  for (const fact of facts) {
    const id = neighbourId(fact, objectId);
    if (id !== objectId) seen.add(id);
  }
  return [...seen];
}

// -------------------------------------------------------------------------------------------
// Conflicts
// -------------------------------------------------------------------------------------------

/** Fact id → the open Conflicts it is a side of. `list_conflicts` has no per-Object / per-Fact
 *  filter (reported as a kernel gap), so the page loads `{status:'open'}` once and matches here. */
export function conflictsByFactId(
  conflicts: readonly ConflictWire[],
): ReadonlyMap<string, readonly ConflictWire[]> {
  const map = new Map<string, ConflictWire[]>();
  for (const conflict of conflicts) {
    for (const factId of [conflict.factAId, conflict.factBId]) {
      const list = map.get(factId);
      if (list) list.push(conflict);
      else map.set(factId, [conflict]);
    }
  }
  return map;
}

// -------------------------------------------------------------------------------------------
// explain → ProvenanceChain
// -------------------------------------------------------------------------------------------

export interface ProvenanceView {
  readonly fact: ProvenanceFact | null;
  readonly activity: ProvenanceActivity | null;
  readonly source: ProvenanceSource | null;
}

/**
 * `explain{nodeId: factId}` (`ExplainResultWire`) onto `ui/ProvenanceChain`'s three segments.
 * The Source is the Fact's own `lastObservation.source` when it has one (S5.2 — the latest
 * same-origin confirmation), else the first Observation the Activity recorded (leftover 1 narrowed
 * `explain` to the Fact's own Observation, so "first" is "the" one for an observed Fact). A Fact
 * asserted without an Observation (human / agent `assert_fact`) has no Source segment — the
 * chain shows "无 Not recorded" there, which is the truth, not a broken render.
 */
export function explainToProvenance(result: ExplainResultWire): ProvenanceView {
  const fact = result.fact
    ? {
        id: result.fact.id,
        linkType: result.fact.linkType,
        epistemicStatus: result.fact.epistemicStatus,
        assertedByPrincipal: result.fact.assertedByPrincipal,
        verifiedByPrincipal: result.fact.verifiedByPrincipal,
        invalidatedAt: result.fact.invalidatedAt,
        invalidationReason: result.fact.invalidationReason,
        lastObservation: result.fact.lastObservation,
      }
    : null;
  const activity = result.activity
    ? {
        id: result.activity.id,
        kind: result.activity.kind,
        status: result.activity.status,
        createdAt: result.activity.createdAt,
        endedAt: result.activity.endedAt,
        startedByPrincipal: result.activity.startedByPrincipal,
        onBehalfOfPrincipal: result.activity.onBehalfOfPrincipal,
      }
    : null;
  const source =
    result.fact?.lastObservation?.source ?? result.activity?.observations[0]?.source ?? null;
  return { fact, activity, source };
}

/** Whether `iso` parses as an instant the kernel's `state_at` (`new Date(at)`, unguarded) can
 *  take — the page validates before it calls. */
export function isValidInstant(iso: string): boolean {
  return !Number.isNaN(Date.parse(iso));
}

/** `2026-09-19T10:30` (a `datetime-local` input's value, local time) → ISO instant; an already-ISO
 *  string passes through. `undefined` when it does not parse. */
export function localInputToIso(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** ISO instant → the `datetime-local` value for that instant in the reader's zone. */
export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
