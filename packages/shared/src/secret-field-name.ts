/**
 * secret-field-name: the one rule for "this field holds a secret, whatever its value looks like".
 *
 * Three places ask that question about the same content and must answer it the same way
 * (maintainer decision 2026-10-09, "二次确认"): the kernel's scrubs (a Turn's tool calls, a JSON
 * pair inside text), the kernel's suspected-credential count that gates approve / publish, and the
 * console's display masking. The console hides a field's value only where the kernel counts it,
 * so every `[redacted]` a person sees on an approval is one the kernel asked them to confirm.
 *
 * **The field rule.** A field whose name names a secret holds a secret in every string or number
 * inside it (an object or array under it included); a boolean, `null` or a blank string is not one
 * (`passwordRequired: true` shows). `isSecretFieldValue`.
 *
 * **The name rule** (`namesASecretField`), on the name as written (`apiKey0`, `api_key_2`,
 * `x-api-key`, `PGPASSWORD`, `client.secret`):
 *   - anywhere in it, case-insensitive: `password`, `passwd`, `passphrase`, `secret`,
 *     `credential`, `authorization` / `authorisation`, `api key`, `private key`, `access key`
 *     (with or without `_` / `-`) — words no ordinary field name contains;
 *   - a word ending in `token` or `tokens` (`token`, `accessToken`, `GITHUB_TOKEN`,
 *     `refreshtoken`, `tokenValue`, `apiTokens`), but not a count of them: `tokenizer`,
 *     `maxTokens`, `max_token`, `tokenCount`, `token_limit`, `inputTokens`, `total_tokens` stay;
 *   - `cookie` or `bearer` as the last word (`Cookie`, `set-cookie` — `cookieConsent` stays);
 *   - `handle` alone, or `capability handle` (a field named after a Handle carries one).
 * Over-matching is the accepted failure mode: a field that only sounds secret is hidden and asks
 * for one extra tick (`secretary`, `passwordMinLength: 8`, `accessKeyId`). Under-matching is the
 * failure to avoid, which is why the strong words match inside a word (`dbpassword`).
 *
 * Linear in the name: one regex without nested quantifiers, and a single pass to split words.
 */

/** Matched anywhere in a name. */
const SECRET_WORD =
  /password|passwd|passphrase|secret|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key/i;

/** A word before `token` that makes it a count (`max_token`, `inputToken`). */
const TOKEN_COUNT_BEFORE = new Set([
  'max',
  'min',
  'num',
  'total',
  'input',
  'output',
  'prompt',
  'completion',
  'cached',
  'reasoning',
  'per',
]);
/** A word after `token` that makes it a count or a property of one (`tokenCount`, `token_type`). */
const TOKEN_COUNT_AFTER = new Set([
  'count',
  'counts',
  'limit',
  'limits',
  'usage',
  'budget',
  'budgets',
  'length',
  'len',
  'size',
  'type',
  'estimate',
  'total',
  'index',
]);

/** Names longer than this are judged on their first this-many characters. */
const MAX_NAME_CHARS = 256;

/** `apiKey0` → `api key`, `X-Api-Key` → `x api key`, `GITHUB_TOKEN` → `github token`,
 *  `HTTPHeader` → `http header`: lower-case words, split at case changes and at anything that is
 *  not a letter (digits included). */
function words(name: string): string[] {
  const out: string[] = [];
  let word = '';
  for (let i = 0; i < name.length; i += 1) {
    const char = name.charAt(i);
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (lower === upper) {
      // Not a letter: a separator.
      if (word !== '') out.push(word);
      word = '';
      continue;
    }
    const isUpper = char === upper;
    if (isUpper && word !== '') {
      const prev = name.charAt(i - 1);
      const next = name.charAt(i + 1);
      const prevLower = prev !== prev.toUpperCase();
      const nextLower = next !== '' && next !== next.toUpperCase();
      // `apiKey` splits before `K`; `HTTPHeader` splits before the `H` that starts `Header`.
      if (prevLower || nextLower) {
        out.push(word);
        word = '';
      }
    }
    word += lower;
  }
  if (word !== '') out.push(word);
  return out;
}

/** Whether a field named `name` holds a secret — the rule in this module's doc comment. */
export function namesASecretField(name: string): boolean {
  const judged = name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS) : name;
  if (SECRET_WORD.test(judged)) return true;
  const split = words(judged);
  const last = split.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const word = split[i] as string;
    if (word.endsWith('token') || word.endsWith('tokens')) {
      const before = i > 0 ? (split[i - 1] as string) : '';
      const after = i < last ? (split[i + 1] as string) : '';
      if (!TOKEN_COUNT_BEFORE.has(before) && !TOKEN_COUNT_AFTER.has(after)) return true;
    }
  }
  const lastWord = split[last];
  if (lastWord === 'cookie' || lastWord === 'bearer') return true;
  if (split.length === 1 && lastWord === 'handle') return true;
  return lastWord === 'handle' && split[last - 1] === 'capability';
}

/** Whether `value`, found under a secret-named field, is a secret value: a non-blank string or a
 *  finite number. Objects and arrays are walked into; the rest is shown. */
export function isSecretFieldValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return typeof value === 'number' && Number.isFinite(value);
}

export const SECRET_FIELD_MASK = '[redacted]';

/**
 * `value` with the secret value under every secret-named field replaced by `[redacted]` — the
 * console's display mask. Keeps the shape (an object under `credentials` stays an object, its
 * strings and numbers hidden) and walks into nothing it does not keep. The kernel's count
 * (`findSuspectedSecrets` with `secretFields`) counts every value this hides, at the same path.
 * Values that only look like a secret, under an ordinary name, are left to the kernel's scrubs.
 */
export function maskSecretFields(value: unknown, underSecretField = false): unknown {
  if (Array.isArray(value)) return value.map((item) => maskSecretFields(item, underSecretField));
  if (value !== null && typeof value === 'object') {
    // `Object.fromEntries` defines each key as an own property; assigning `out[key]` would turn a
    // `"__proto__"` key into a prototype swap instead of a field.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        maskSecretFields(inner, underSecretField || namesASecretField(key)),
      ]),
    );
  }
  return underSecretField && isSecretFieldValue(value) ? SECRET_FIELD_MASK : value;
}
