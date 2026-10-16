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
  /** The caller confirmed the draft's suspected credentials (decision 2026-10-09 "二次确认",
   *  governance/redaction/credential-review.ts) — required by `publish_*` when the draft carries
   *  any, ignored otherwise. */
  readonly credentialsReviewed?: boolean;
  /** Legacy 300: the version the caller reviewed — `publish_skill` / `publish_procedure` publish
   *  the family's latest version, and refuse `ReviewedVersionChangedError` when that is another
   *  one. Internal callers omit the actor, and so the check. */
  readonly reviewedVersion?: number;
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

  /** `action` is the capability name (`publish_skill`, `deprecate_operation`,
   *  `discard_operation_draft`, ...). */
  constructor(action: string, subject: string) {
    const verb = action.startsWith('deprecate_')
      ? 'deprecate'
      : action.startsWith('discard_')
        ? 'discard'
        : 'publish';
    super(
      `${action}: ${subject} was proposed by another principal — only its proposer or the workspace owner may ${verb} it`,
    );
    this.name = 'NotProposerError';
  }
}

/**
 * Legacy 300 (same class as review #493 on #583's `draft_changed`): a publish names the version the
 * person reviewed, and the version it would publish now is a different one — a newer draft under
 * the same Skill / Procedure family, a newer indexed module version. Raised after the row (or the
 * module's install lock) is held, before anything is written; the caller reloads and decides on
 * what is there now. Rows are immutable per version (only `status` changes), so the version alone
 * binds the content reviewed; an Operation draft is revised in place and binds by `draftDigest`
 * instead (`OperationDraftChangedError`).
 */
export class ReviewedVersionChangedError extends Error {
  readonly code = 'version_changed' as const;
  readonly reviewedVersion: number;
  readonly currentVersion: number;

  /** `action` is the capability name; `subject` names the family (`Skill <id>`, `module <name>`). */
  constructor(action: string, subject: string, reviewedVersion: number, currentVersion: number) {
    super(
      `${action}: ${subject} is at v${currentVersion} now, not the v${reviewedVersion} that was reviewed — nothing was written; reload it and look again`,
    );
    this.name = 'ReviewedVersionChangedError';
    this.reviewedVersion = reviewedVersion;
    this.currentVersion = currentVersion;
  }
}

/** Refuses with `ReviewedVersionChangedError` unless `reviewed` is the version about to change. */
export function assertReviewedVersion(
  action: string,
  subject: string,
  reviewed: number | undefined,
  current: number,
): void {
  if (reviewed !== undefined && reviewed !== current) {
    throw new ReviewedVersionChangedError(action, subject, reviewed, current);
  }
}
