import type { ChangeWideningReasonCode } from '@nexttime/shared';

/**
 * governance/field-rules: the building blocks of the authority-widening classifier (S11 plan §5.4,
 * I-A4) — one rule per field, saying whether a before → after change of it can widen authority.
 * `application/change-plan/classify.ts` builds its per-kind rule tables from these; the Operation
 * table (`governance/gatekeepers/governance-fields.ts`) lives below it, in `governance/`, so a
 * gate's re-announced governance (STATUS leftover 344) is judged by the very same rules as a
 * change plan's `operation_version` item — one classifier, never two that could disagree.
 */

/** One field's rule: the reason a before → after change of it widens authority, or `null` when it
 *  is proven not to. Called only for fields present on at least one side. */
export type FieldRule = (before: unknown, after: unknown) => ChangeWideningReasonCode | null;

export function sameValue(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

/** Proven not to widen authority whatever the change (see each use for why). */
export const NOT_WIDENING: FieldRule = () => null;

/** Any change needs confirmation: the field governs review, and no direction of change is proven
 *  harmless. */
export const ANY_CHANGE: FieldRule = (before, after) =>
  sameValue(before, after) ? null : 'changed';

/** A field with a strictness order: moving to a stricter (or equally strict) value is proven not
 *  to widen; a looser one is `loosened`; a value outside the order is `changed`. */
export function strictness(rank: (value: unknown) => number | undefined): FieldRule {
  return (before, after) => {
    if (sameValue(before, after)) return null;
    const from = rank(before);
    const to = rank(after);
    if (from === undefined || to === undefined) return 'changed';
    return to < from ? 'loosened' : null;
  };
}

export function rankOf(order: readonly unknown[]): (value: unknown) => number | undefined {
  return (value) => {
    const index = order.indexOf(value);
    return index === -1 ? undefined : index;
  };
}

/** A list of strings, or `undefined` for anything else; `undefined` itself reads as `absent`. */
export function stringList(
  value: unknown,
  absent: readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) return absent;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

/**
 * A list whose entries each reach further (`widensWhen: 'grows'` — an entry added widens) or hold
 * something back (`'shrinks'` — an entry dropped widens). Order does not count. `absentIsEmpty`:
 * the field left out means no entries; otherwise leaving it out means a default defined elsewhere,
 * and a change between that and a list is `changed` (not proven either way).
 */
export function listRule(widensWhen: 'grows' | 'shrinks', absentIsEmpty: boolean): FieldRule {
  return (before, after) => {
    if (sameValue(before, after)) return null;
    if (!absentIsEmpty && (before === undefined) !== (after === undefined)) return 'changed';
    const b = stringList(before, absentIsEmpty ? [] : undefined);
    const a = stringList(after, absentIsEmpty ? [] : undefined);
    if (b === undefined || a === undefined) return 'changed';
    const [wider, narrower] = widensWhen === 'grows' ? [a, b] : [b, a];
    return wider.every((entry) => narrower.includes(entry)) ? null : 'loosened';
  };
}
