/**
 * Legacy 351: an approve / reject `reason` is typed by a person and shown back verbatim (pre-wrap)
 * on every approval surface, with no limit on the wire. The console caps what it lets a person
 * type here — the same 1000 characters a failure reason is cut to — so one reason cannot turn an
 * approval page into a wall of text; displays pass it through `visibleLines`, so a control
 * character shows as its escape rather than disappearing.
 */
export const DECISION_REASON_MAX_LENGTH = 1000;
