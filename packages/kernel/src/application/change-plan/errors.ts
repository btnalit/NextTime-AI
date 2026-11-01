import type { ChangeItemKind, ChangeRollbackBlocker } from '@nexttime/shared';
import type { WideningReason } from './classify.js';

/** I-A8: the segment's dry run, recomputed in the applying transaction, is not the one reviewed —
 *  its source, or the state it changes, moved since. Mapped to 409 `change_plan_changed`; nothing
 *  was applied, and the caller reviews the segment again. */
export class ChangePlanChangedError extends Error {
  readonly code = 'change_plan_changed' as const;
  readonly reviewedDigest: string;
  readonly currentDigest: string;
  constructor(reviewedDigest: string, currentDigest: string) {
    super(
      `the change segment is no longer the one reviewed (reviewed ${reviewedDigest}, now ${currentDigest}) — nothing was applied; review it again`,
    );
    this.name = 'ChangePlanChangedError';
    this.reviewedDigest = reviewedDigest;
    this.currentDigest = currentDigest;
  }
}

export interface UnconfirmedChangeItem {
  readonly ordinal: number;
  readonly kind: ChangeItemKind;
  readonly target: Readonly<Record<string, unknown>>;
  readonly widening: readonly WideningReason[];
}

/** I-A4: authority-widening items the applier has not confirmed one by one. Mapped to 400
 *  `change_confirmation_required` with the items in `details`, the same "here is exactly what to
 *  confirm" shape as `module_confirm_required`; nothing was applied. */
export class ChangeConfirmationRequiredError extends Error {
  readonly code = 'change_confirmation_required' as const;
  readonly details: { readonly items: readonly UnconfirmedChangeItem[] };
  constructor(items: readonly UnconfirmedChangeItem[], context?: string) {
    const list = items
      .map(
        (item) =>
          `#${item.ordinal} ${item.kind} (${item.widening.map((w) => `${w.path}: ${w.reason}`).join(', ')})`,
      )
      .join('; ');
    super(
      `${context ? `${context}: ` : ''}authority-widening change item(s) need to be confirmed one by one: ${list} — nothing was applied`,
    );
    this.name = 'ChangeConfirmationRequiredError';
    this.details = { items };
  }
}

/** I-A1 at run time (legacy 407): a segment is applied or rolled back by a person, on the human
 *  or platform channel, never through a Handle or by a service or agent Principal
 *  (`assertChangeApplierIsPerson`). Mapped to 403 `forbidden`; nothing was written. The registry
 *  refuses such a caller first (`actsForPerson` on every segment-writing capability), so this is
 *  the backstop. */
export class ChangeApplierNotAPersonError extends Error {
  readonly action: 'apply' | 'roll_back';
  constructor(action: 'apply' | 'roll_back', why: string) {
    super(
      `a change segment is ${action === 'apply' ? 'applied' : 'rolled back'} by a person only (${why}) — nothing was written`,
    );
    this.name = 'ChangeApplierNotAPersonError';
    this.action = action;
  }
}

/** P1-B: the segment was already rolled back — mapped to 409 `change_segment_rolled_back`; nothing
 *  was written. */
export class ChangeSegmentRolledBackError extends Error {
  readonly code = 'change_segment_rolled_back' as const;
  constructor(segmentId: string) {
    super(`change segment ${segmentId} is already rolled back — nothing was written`);
    this.name = 'ChangeSegmentRolledBackError';
  }
}

/** One item a rollback cannot do now, and why (`@nexttime/shared` `CHANGE_ROLLBACK_BLOCKER_VALUES`). */
export interface ChangeRollbackConflict {
  readonly ordinal: number;
  readonly kind: ChangeItemKind;
  readonly target: Readonly<Record<string, unknown>>;
  readonly blocker: ChangeRollbackBlocker;
  /** For `replaced`: the segment whose change came after this item — roll it back first; `null`
   *  when that change was made outside the ChangePlan core. */
  readonly blockedBy: { readonly segmentId: string } | null;
  /** For `namespace_conflict`: the type names another ontology family declares now (I-P1). */
  readonly conflicts: readonly { readonly kind: 'object' | 'action'; readonly name: string }[];
}

/** P1-B (§3.4 "逆操作遇到中间被别人改过的版本时停下不覆盖"): an item's target is not what the item left
 *  there, or what it would restore is gone or clashes. Mapped to 409 `change_rollback_conflict`
 *  with the items in `details`; nothing was written. */
export class ChangeRollbackConflictError extends Error {
  readonly code = 'change_rollback_conflict' as const;
  readonly details: { readonly items: readonly ChangeRollbackConflict[] };
  constructor(segmentId: string, items: readonly ChangeRollbackConflict[]) {
    const list = items
      .map(
        (item) =>
          `#${item.ordinal} ${item.kind}: ${item.blocker}${item.blockedBy ? ` (roll back segment ${item.blockedBy.segmentId} first)` : ''}`,
      )
      .join('; ');
    super(`change segment ${segmentId} cannot be rolled back now: ${list} — nothing was written`);
    this.name = 'ChangeRollbackConflictError';
    this.details = { items };
  }
}
