import type { Role } from '@nexttime/shared';
import { roleSatisfiesMinRole } from './roles.js';

/**
 * Review 2026-10-02 decision D-24 (the STATUS leftover 100 family): one authority rule for every
 * meta-ontology `publish_*` / `deprecate_*` capability. The registry sets `minRole: 'builder'` on
 * each (the floor), and the row being published or deprecated must have been proposed by the
 * caller — unless the caller is the workspace owner. `publish_ontology_version` already had the
 * stricter proposer-only form (leftover 100, `substrate/ontology/registry.ts`), and
 * `publish_manifest` stays owner-only; both are unchanged.
 *
 * `publish_operation` on a revision draft also deprecates the identity's live row (S3.12), so the
 * caller needs the same authority over that row — a builder revises their own Operation; replacing
 * one someone else proposed (a gate's imported Operation, say) is the owner's. The versioned
 * registries apply the same rule to their families (`application/worker/publish-family.ts`):
 * propose may add a version to anyone's family, but publishing it over a live version someone
 * else proposed needs that proposer or the owner.
 *
 * The services (`application/worker` skills / procedures / definitions,
 * `governance/gatekeepers/manifest.ts`) apply it to the row they have just locked, so a version
 * proposed by someone else between a pre-read and the write can never slip through. An internal
 * caller (CLI seed, module install, `enable_gate_instance`) passes no actor and is not checked —
 * those are not capability calls by a person.
 *
 * Refusal: a draft the caller may not even see (a WorkerDefinition draft is private to its
 * proposer, I16) answers the module's own not-found, exactly as `discard_draft` does; a row the
 * caller can see (anything published or deprecated, and Operation / Skill / Procedure drafts,
 * which builders review — `seesEveryDraft` below) answers `NotProposerError` (403
 * `not_proposer`). The console treats that code as a per-row refusal, not as "this role can never
 * call the capability". Seeing a draft is not publishing it: a builder who reviews another
 * principal's draft still cannot publish it.
 */

export interface PublishActor {
  readonly principalId: string;
  readonly role: Role;
}

/**
 * D-26 (review 2026-10-02): the workspace's draft reviewers — the owner and builders
 * (`roleSatisfiesMinRole(role, 'builder')`: the owner clears every role, `builder` is the role
 * that proposes meta-ontology) — see every Operation, Skill and Procedure draft, not only their
 * own. A member's Worker proposes on that member's behalf (`proposedBy` = the member), and the
 * draft only goes live through an owner's `publish_*`, so the owner has to be able to find it.
 * Everyone else sees only their own drafts (I16). The one role rule behind `operationVisibleTo`
 * (governance/gatekeepers/manifest.ts) and `draftVisibleTo` (application/worker/
 * draft-visibility.ts).
 */
export function seesEveryDraft(role: Role): boolean {
  return roleSatisfiesMinRole(role, 'builder');
}

export function mayPublishOrDeprecate(
  actor: PublishActor,
  proposedBy: string | null | undefined,
): boolean {
  if (actor.role === 'owner') return true;
  return typeof proposedBy === 'string' && proposedBy === actor.principalId;
}

/**
 * Applies the rule to one locked row. `actor` undefined is an internal caller: no check.
 * `hiddenDraftError` is the module's own not-found for a draft the caller cannot see; omit it
 * where drafts are visible to every caller that clears the builder floor (Operations, D-26).
 */
export function assertPublishAuthority(
  action: string,
  actor: PublishActor | undefined,
  row: { readonly status: string; readonly proposedBy?: string | null },
  subject: string,
  hiddenDraftError?: () => Error,
): void {
  if (actor === undefined || mayPublishOrDeprecate(actor, row.proposedBy)) return;
  if (row.status === 'draft' && hiddenDraftError) throw hiddenDraftError();
  throw new NotProposerError(action, subject);
}

export class NotProposerError extends Error {
  readonly code = 'not_proposer' as const;

  /** `action` is the capability name (`publish_skill`, `deprecate_operation`, ...). */
  constructor(action: string, subject: string) {
    const verb = action.startsWith('deprecate_') ? 'deprecate' : 'publish';
    super(
      `${action}: ${subject} was proposed by another principal — only its proposer or the workspace owner may ${verb} it`,
    );
    this.name = 'NotProposerError';
  }
}
