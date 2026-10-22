import type { ChangeItemKind } from '@nexttime/shared';
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
