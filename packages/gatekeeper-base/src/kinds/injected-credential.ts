/**
 * Legacy 961: what a target answers goes back to the agent that called it, and on to its model. A
 * target that echoes the request's headers (an echo or introspection endpoint, a debug error body,
 * a `whoami` answer) would hand it the credential this gate put on the request, and nothing past
 * the gate could take it out again: the kernel's secret patterns read a value after a secret's
 * name, and an echoed token has none in front of it. The gate is the one place that knows the
 * value, so it masks it there, by its literal value, before the answer leaves (design doc
 * `docs/redaction-boundary-design-2026-11-27.md` §4.6; as llm-proxy does with its model key).
 *
 * Masked: each value the call's credential actually put on the request (`credentialHeaders`), and
 * after an auth scheme (`Bearer `, `Basic `, `token `) the part after it, in every string of the
 * answer, keys too, as written or percent-encoded (any mix of encoded and plain characters, either
 * case of hex). JSON escapes are undone by parsing, before this runs. Not base64 or any other
 * transform of the value. A value shorter than `MIN_MASKED_LENGTH` is not masked: too many plain
 * strings of an answer would match it.
 */

/** The shortest credential value masked by its literal value. */
export const MIN_MASKED_LENGTH = 8;

const MASK = '[redacted]';
const AUTH_SCHEME = /^(?:bearer|basic|token)[ \t]+(\S.*)$/i;

/** Masks the values a call's credential put on its request, and counts what it masked. */
export interface InjectedCredentialMask {
  /** `value` with each injected credential value in its strings (keys too) replaced; `masked` is
   *  how many were. Objects and arrays are copied, anything else returned as it is. */
  apply<T>(value: T): { readonly value: T; readonly masked: number };
}

const NOTHING_TO_MASK: InjectedCredentialMask = {
  apply: (value) => ({ value, masked: 0 }),
};

/** One character of a value, written as it is or percent-encoded (a blank also as `+`). */
function charPattern(char: string): string {
  const plain = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let encoded: string;
  try {
    encoded = encodeURIComponent(char);
  } catch {
    return plain; // a lone surrogate has no percent-encoding
  }
  if (encoded === char) return plain;
  const percent = encoded.replace(/%([0-9A-F])([0-9A-F])/g, (_m, high: string, low: string) => {
    const either = (digit: string) =>
      /[A-F]/.test(digit) ? `[${digit}${digit.toLowerCase()}]` : digit;
    return `%${either(high)}${either(low)}`;
  });
  return char === ' ' ? `(?:${plain}|${percent}|\\+)` : `(?:${plain}|${percent})`;
}

/** The mask for the headers this call's credential set (`credentialHeaders`' result). */
export function injectedCredentialMask(
  headers: Readonly<Record<string, string>>,
): InjectedCredentialMask {
  const values = new Set<string>();
  for (const configured of Object.values(headers)) {
    // As fetch sends it: a header value loses its leading and trailing blanks.
    const value = configured.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    values.add(value);
    const scheme = AUTH_SCHEME.exec(value);
    if (scheme?.[1]) values.add(scheme[1]);
  }
  const masked = [...values]
    .filter((value) => value.length >= MIN_MASKED_LENGTH)
    // Longest first: where one value begins another (two header values), the longer goes whole.
    .sort((a, b) => b.length - a.length);
  if (masked.length === 0) return NOTHING_TO_MASK;
  const pattern = new RegExp(
    masked.map((value) => [...value].map(charPattern).join('')).join('|'),
    'g',
  );

  const apply = <T>(input: T): { value: T; masked: number } => {
    let count = 0;
    const text = (s: string): string =>
      s.replace(pattern, () => {
        count += 1;
        return MASK;
      });
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return text(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value === null || typeof value !== 'object') return value;
      const copy: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        // Defined, not assigned: a parsed `__proto__` key stays an own property, as it was.
        Object.defineProperty(copy, text(key), {
          value: walk(inner),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return copy;
    };
    const value = walk(input) as T;
    return { value, masked: count };
  };
  return { apply };
}

/** Why an answer the mask could not walk (nested past the stack) is refused rather than handed
 *  back unread: the credential would leave with it. Only when the call carried a credential. */
export const UNCHECKED_ANSWER = "its answer is nested too deep to check for this gate's credential";

/** The line a gate logs when it masked its own credential in an answer: how many, never what. */
export function credentialEchoLine(what: string, masked: number): string {
  return `${what}: the target's answer held this gate's own credential ${masked === 1 ? 'once' : `${masked} times`}; masked before the answer left the gate (legacy 961)`;
}
