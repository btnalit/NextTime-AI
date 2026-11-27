/**
 * The text a model is shown of a gate tool's result, as `platform-extension`'s
 * `modes/tool-result.ts` writes it (legacy 967 stage 1, `docs/tool-result-and-budget-design-
 * 2026-11-27.md` §4.1), and as a tool call's stored preview keeps it: compact JSON and, when the
 * result was shortened, `TOOL_RESULT_NOTE_SEPARATOR` and one note line in square brackets. Compact
 * JSON holds no raw line break, so the first blank line followed by `[` is where the note starts.
 * Rows written before legacy 967 hold indented JSON cut from its head, with a marker line after.
 */

export const TOOL_RESULT_NOTE_SEPARATOR = '\n\n';

/** `text` split at its note line: the JSON text before it, and the note (`undefined` when there is
 *  none — the whole text is then `json`). */
export function splitToolResultNote(text: string): { json: string; note: string | undefined } {
  const at = text.indexOf(`${TOOL_RESULT_NOTE_SEPARATOR}[`);
  return at === -1
    ? { json: text, note: undefined }
    : { json: text.slice(0, at), note: text.slice(at + TOOL_RESULT_NOTE_SEPARATOR.length) };
}

/** The JSON value a tool result's text holds — the whole text, or the part before its note line —
 *  or `undefined` when neither parses (a character cut, a cut preview, plain output). */
export function toolResultJsonValue(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    // Not whole JSON: perhaps JSON and a note.
  }
  const { json, note } = splitToolResultNote(text);
  if (note === undefined) return undefined;
  try {
    return { value: JSON.parse(json) };
  } catch {
    return undefined;
  }
}
