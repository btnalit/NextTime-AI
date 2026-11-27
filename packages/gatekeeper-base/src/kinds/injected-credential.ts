/**
 * Legacy 961: what a target answers goes back to the agent that called it, and on to its model. A
 * target that echoes the request's headers (an echo or introspection endpoint, a debug error body,
 * a `whoami` answer) would hand it the credential this gate put on the request, and nothing past
 * the gate could take it out again: the kernel's secret patterns read a value after a secret's
 * name, and an echoed token has none in front of it. The gate is the one place that knows the
 * value, so it masks it there, by its literal value, before the answer leaves (design doc
 * `docs/redaction-boundary-design-2026-11-27.md` §4.6; as llm-proxy does with its model key).
 *
 * Masked: each value the call's credential actually put on the request (`credentialHeaders`); after
 * an auth scheme (`Bearer `, `Basic `, `ApiKey `, any one word and a blank) the part after it; and
 * where a header value is a list of `name=value` parts (a cookie, Rails' `Token token="…"`), each
 * part's value, unquoted. In every string of the answer, keys too, each character as written,
 * percent-encoded (any mix of encoded and plain characters, either case of hex) or, where it is
 * not a letter or digit, as an escape a single parse leaves in place: `\uXXXX`, `\/` for `/`, an
 * HTML or XML character reference (`&#47;`, `&#x2F;`, `&amp;`). A number of the answer equal to an
 * all-digit value is masked too (a target that parsed the key as a number). JSON escapes are undone
 * by parsing, before this runs. Not base64 or any other transform of the value, and not a piece
 * cut from it. A value shorter than `MIN_MASKED_LENGTH` is not masked: too many plain strings of an
 * answer would match it.
 */

/** The shortest credential value masked by its literal value. */
export const MIN_MASKED_LENGTH = 8;

const MASK = '[redacted]';
/** Any auth scheme word (`Bearer`, `Basic`, `token`, `ApiKey`, `Bot`, `SSWS`, …) and the rest. */
const AUTH_SCHEME = /^[A-Za-z][A-Za-z0-9._~+/-]*[ \t]+(\S.*)$/;
/** The five characters XML names; HTML writes them the same way. */
const NAMED_REFERENCE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Masks the values a call's credential put on its request, and counts what it masked. */
export interface InjectedCredentialMask {
  /** `value` with each injected credential value in its strings (keys too), and each number equal
   *  to an all-digit one, replaced; `masked` is how many were. Objects and arrays are copied,
   *  anything else returned as it is. */
  apply<T>(value: T): { readonly value: T; readonly masked: number };
}

const NOTHING_TO_MASK: InjectedCredentialMask = {
  apply: (value) => ({ value, masked: 0 }),
};

/** A hex digit in either case, for a pattern. */
const eitherCase = (digit: string): string =>
  /[a-f]/i.test(digit) ? `[${digit.toUpperCase()}${digit.toLowerCase()}]` : digit;

/** One character of a value: as it is, percent-encoded (a blank also as `+`), and where it is not
 *  a letter or digit, as `\uXXXX`, `\/`, or an HTML or XML character reference. */
function charPattern(char: string): string {
  const plain = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ways = [plain];
  try {
    const encoded = encodeURIComponent(char);
    if (encoded !== char) {
      ways.push(
        encoded.replace(
          /%([0-9A-F])([0-9A-F])/g,
          (_m, high: string, low: string) => `%${eitherCase(high)}${eitherCase(low)}`,
        ),
      );
    }
  } catch {
    // a lone surrogate has no percent-encoding
  }
  if (char === ' ') ways.push('\\+');
  if (!/^[A-Za-z0-9]$/.test(char)) {
    const units = Array.from({ length: char.length }, (_, i) => char.charCodeAt(i));
    ways.push(
      units
        .map((unit) => `\\\\u${[...unit.toString(16).padStart(4, '0')].map(eitherCase).join('')}`)
        .join(''),
    );
    const point = char.codePointAt(0) ?? 0;
    ways.push(`&#0*${point};`, `&#[xX]0*${[...point.toString(16)].map(eitherCase).join('')};`);
    const named = NAMED_REFERENCE[char];
    if (named) ways.push(named);
    if (char === '/') ways.push('\\\\/');
  }
  return ways.length === 1 ? plain : `(?:${ways.join('|')})`;
}

/** The values of a header value's `name=value` parts (`;` or `,` between them), unquoted. */
function partValues(value: string): string[] {
  return value
    .split(/[;,]/)
    .filter((part) => part.includes('='))
    .map((part) =>
      part
        .slice(part.indexOf('=') + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1'),
    );
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
    const rest = AUTH_SCHEME.exec(value)?.[1];
    if (rest) values.add(rest);
    for (const part of [value, rest ?? ''].flatMap(partValues)) values.add(part);
  }
  const masked = [...values]
    .filter((value) => value.length >= MIN_MASKED_LENGTH)
    // Longest first: where one value begins another (two header values), the longer goes whole.
    .sort((a, b) => b.length - a.length);
  if (masked.length === 0) return NOTHING_TO_MASK;
  // A key the target parsed as a number: compared as a number, so one that lost precision too.
  const numbers = new Set(masked.filter((value) => /^[0-9]+$/.test(value)).map(Number));
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
      if (typeof value === 'number' && numbers.has(value)) {
        count += 1;
        return MASK;
      }
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
