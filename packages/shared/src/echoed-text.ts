/**
 * Legacy 232: how a caller-chosen string (an Operation / action kind, a LinkType or ObjectType a
 * model wrote) is echoed back — in an error, a stored refusal, an audit payload, a log line or
 * the console. Such a string is whatever the caller sent, so an echo of it is clipped (a long one
 * cannot fill the message or the row) and keeps nothing a reader cannot see: control characters,
 * format characters (a bidi override such as U+202E, zero-width characters), lone surrogates and
 * line / paragraph separators are shown as `\u{XXXX}`. One module for the kernel and the console,
 * so both show the same string the same way.
 */

import { OPERATION_NAME_MAX } from './action-description.js';

/** The most code points of a caller-chosen string any echo carries — `OPERATION_NAME_MAX`
 *  (action-description.ts), so a legal Operation name is never clipped (review #493 on #593). */
export const ECHO_MAX = OPERATION_NAME_MAX;

/** Characters a reader cannot see, or sees reorder the text around them. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
/** As `UNSEEN`, less what `JSON.stringify` already escapes (Cc, lone surrogates). */
const UNSEEN_AFTER_JSON = /[\p{Cf}\p{Zl}\p{Zp}]/gu;

function escapeCodePoint(ch: string): string {
  return `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;
}

/** `value` cut to `max` code points (never inside a surrogate pair), `…` marking a cut. */
export function clipCodePoints(value: string, max: number = ECHO_MAX): string {
  const points = [...value];
  return points.length > max ? `${points.slice(0, max).join('')}…` : value;
}

/** `value` with every unseen character shown as `\u{XXXX}`; nothing else changes. */
export function visibleText(value: string): string {
  return value.replace(UNSEEN, escapeCodePoint);
}

/** JSON text (`JSON.stringify` output) with every unseen character it left raw — format characters
 *  and line / paragraph separators — shown as `\u{XXXX}`. Control characters and lone surrogates
 *  are already escaped by `JSON.stringify`, and pretty-printing's own line breaks stay as they are
 *  (review of #593: a bidi override inside a value reordered what an approver read). */
export function visibleJson(json: string): string {
  return json.replace(UNSEEN_AFTER_JSON, escapeCodePoint);
}

/** An unquoted echo: clipped, then made visible — for a stored field or an audit payload. */
export function boundedEcho(value: string, max: number = ECHO_MAX): string {
  return visibleText(clipCodePoints(value, max));
}

/** A quoted echo for running text: clipped, then quoted the JSON way (quotes, backslashes and
 *  control characters escaped, so it can neither end the quote nor forge a log line), with
 *  format characters shown as `\u{XXXX}` too. */
export function quotedName(name: string): string {
  return visibleJson(JSON.stringify(clipCodePoints(name)));
}
