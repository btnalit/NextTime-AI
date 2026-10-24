import { isMetaOntologyObjectType } from '@nexttime/shared';

/**
 * substrate/graph/meta-object-guard (review #493 F1 on #757): the one gate every Object write goes
 * through (`SqlGraphStore.upsertObject`) refuses a platform meta-ontology ObjectType
 * (`WorkerDefinition` / `Gatekeeper` / `Operation` / `Capability` / `Skill` / `Procedure`) unless
 * the kernel composed the write itself (`kernelAuthored`, `substrate/ontology/meta-objects.ts`).
 *
 * An Operation Object *is* the published definition — its mode, binding, `auto_approvable` and
 * `blast_radius` are what the approval decision reads — and `upsertObject` merges properties into
 * the row its identity names. Before this guard, an observing writer (`submit_observations`, a
 * gate's `observedFacts`) that named such a type with the identity of a published version rewrote
 * it in place, past every review. These Objects are only ever written as a side effect of an
 * already-governed action (publish, import, a ChangePlan revision), never by a writer that carries
 * outside data, whatever its channel. The handlers that take outside data refuse such a write
 * before writing anything (`application/gateway`); this is the backstop for any path that does
 * not.
 */
export class MetaOntologyObjectWriteError extends Error {
  readonly objectType: string;

  constructor(objectType: string) {
    super(
      `meta-ontology ObjectType "${objectType}" is written only by the platform as part of a governed action (publish, import, a ChangePlan revision) — never from observed or submitted data`,
    );
    this.name = 'MetaOntologyObjectWriteError';
    this.objectType = objectType;
  }
}

/** Throws {@link MetaOntologyObjectWriteError} for a meta-ontology `objectType` the kernel did
 *  not author. Pure. */
export function assertObjectWriteAllowed(objectType: string, kernelAuthored: boolean): void {
  if (!kernelAuthored && isMetaOntologyObjectType(objectType)) {
    throw new MetaOntologyObjectWriteError(objectType);
  }
}
