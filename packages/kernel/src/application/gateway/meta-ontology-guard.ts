import { type CapabilityChannel, isMetaOntologyObjectType } from '@nexttime/shared';
import { ForbiddenError } from './authorize.js';

/**
 * application/gateway/meta-ontology-guard: I16 on the graph write path (design doc §5.3 item 12,
 * §5.4 I16; docs/development-tasks.md S2.6 — "Cover the graph write path too: assert_fact/object
 * writes naming a meta-ontology ObjectType from the Handle channel → 403 unless it is the
 * caller's own draft").
 *
 * The relational registry side of I16 (`propose`/`publish`/`deprecate` on `worker_definitions`)
 * needs no runtime check here at all — `publish_worker_definition`/`deprecate_worker_definition`
 * are `channel:'human'`-only capabilities (rejected by `authorizeCapabilityCall` before any
 * handler runs), and `propose_worker_definition` always inserts a row it owns (see
 * `application/worker/definitions.ts`'s own doc comment). This module exists for the other half:
 * a Handle-channel caller writing a Fact (`assert_fact`) whose referenced Object is one of the
 * six meta-ontology ObjectTypes (`WorkerDefinition` / `Gatekeeper` / `Operation` / `Capability` /
 * `Skill` / `Procedure`) must be rejected — those Objects are only ever written as a *side effect*
 * of an already-governed action (e.g. `publishWorkerDefinition`'s own
 * `projectWorkerDefinitionObject` call, `governance/connections`'s future
 * `registerGatekeeperObject` call, S2.13), never directly by an agent's generic graph-write tools.
 *
 * `MetaOntologyWriteForbiddenError` extends `ForbiddenError` so every existing generic-403 code
 * path (the WS transport's `-32002 FORBIDDEN`, `interfaces/http/capability-route.ts`'s own
 * `instanceof ForbiddenError` fallback) keeps working unchanged; `interfaces/http/
 * capability-route.ts` additionally maps it to the more specific, stable HTTP error code
 * `meta_ontology_write_forbidden` (checked *before* the generic `ForbiddenError` branch, since a
 * subclass would otherwise match that first).
 */

export class MetaOntologyWriteForbiddenError extends ForbiddenError {
  readonly objectType: string;

  constructor(objectType: string) {
    super(
      `meta-ontology ObjectType "${objectType}" cannot be written from the Handle channel (I16) — these Objects are only ever written as a side effect of an already-governed action`,
    );
    this.name = 'MetaOntologyWriteForbiddenError';
    this.objectType = objectType;
  }
}

/**
 * Throws `MetaOntologyWriteForbiddenError` when `channel` is `'handle'` and `objectType` names one
 * of the six platform meta-ontology ObjectTypes. A no-op for the human channel, or for any other
 * ObjectType. Pure — no IO, so it can gate a call site before (or instead of) attempting any
 * database write.
 */
export function assertMetaOntologyHandleWriteAllowed(
  channel: CapabilityChannel,
  objectType: string,
): void {
  if (channel === 'handle' && isMetaOntologyObjectType(objectType)) {
    throw new MetaOntologyWriteForbiddenError(objectType);
  }
}
