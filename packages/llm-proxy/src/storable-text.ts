/**
 * Text the kernel can store. Postgres refuses U+0000 in `text` and `jsonb`, and an unpaired
 * surrogate in `jsonb`; a kernel write that meets one fails with a 500 (legacy 825, and the
 * usage report that #501 found alongside it). Two exits of this proxy carry text that never
 * passed the write-time rule (#1409) — a model id in an operator's `llm-providers.yaml` or one
 * stored before that rule, an error cut through a surrogate pair:
 *
 * - the platform audit row (`audit-details.ts` `storableDetails`);
 * - the usage report (`report.ts`).
 *
 * Both send `storableText` of every string, and keep the text as it was in this proxy's own log
 * line.
 */

/** `text` with U+0000 and every unpaired surrogate replaced by U+FFFD. A char-code loop: biome
 *  refuses a control character in a regex. */
export function storableText(text: string): string {
  let stored = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        stored += text.slice(i, i + 2);
        i += 1;
        continue;
      }
    } else if (code !== 0 && (code < 0xdc00 || code > 0xdfff)) {
      stored += text[i];
      continue;
    }
    stored += '\ufffd';
  }
  return stored;
}
