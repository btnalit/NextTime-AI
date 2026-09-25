/**
 * lib/message-references: S8 W4-A (journey ④ "追溯「agent 为什么这么说」", ui-audit J8). Pure
 * extraction only — no capability calls, no React (`components/chat/MessageReferences.tsx` does
 * the calling and the rendering, same split `lib/audit.ts` keeps for the audit page).
 *
 * **Why text-scanning at all, given the design doc's own "prefer structured data over parsing free
 * text"**: the entry agent's own tool-call rows (`ToolCallRowView`) are the *first-choice*
 * structured channel — but nothing in a Turn's *own* transcript names which Fact a given sentence
 * of the final reply actually rests on; that link exists only if the reply itself names the Fact
 * (typically by an id a tool result already put in front of the model, or by quoting an id a
 * person pasted into the conversation). Scanning the persisted reply text for an id-shaped token
 * and verifying it through `explain` (never rendering an unverified guess — see
 * `MessageReferences.tsx`) is therefore not a workaround, it is the one place this link can be
 * read from at all today; `docs/development-tasks.md`/`ui-audit-2026-09-23.md` J8's own fix note
 * says exactly this ("对已知实体做行内链接").
 */

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Bounds how many candidate ids one message/tool-result is ever scanned for — a message quoting
 *  a long list of ids (a Worker's own dump) should not fire dozens of `explain` calls. */
const MAX_CANDIDATES = 8;

/** Every distinct id-shaped token in `text`, lower-cased, in first-seen order, capped at
 *  {@link MAX_CANDIDATES}. Returns `[]` for text with no id-shaped substring — the common case for
 *  an ordinary prose reply, and the reason a plain reply renders no reference affordance at all
 *  (journey ④'s own "空" state: "不应该出现追溯入口"). */
export function extractIdCandidates(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(UUID_RE)) {
    found.add(match[0].toLowerCase());
    if (found.size >= MAX_CANDIDATES) break;
  }
  return [...found];
}
