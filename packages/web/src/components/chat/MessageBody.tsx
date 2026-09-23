import { type ReactNode, Suspense, lazy } from 'react';
import type { ChatMessage } from '../../lib/ws-client.js';

/** `react-markdown` + `remark-gfm` would add ~191 kB raw / ~59 kB gzip to the single main chunk if
 *  imported eagerly (measured: main chunk 803.31 kB → 994.10 kB raw, 226.52 kB → 285.32 kB gzip —
 *  this app has no other code-split boundary yet), for a feature only a chat page with an
 *  assistant message ever needs. `React.lazy` moves that weight into its own chunk instead
 *  (measured: `markdown-*.js` ≈189 kB raw / ≈57 kB gzip; the main chunk barely moves, 803.31 kB →
 *  805.58 kB raw), fetched only the first time a message actually needs rendering. The dynamic
 *  `import()` is memoized by `lazy()` itself, once per page load, so only the *first* assistant
 *  message on screen pays the fetch; every later one (this render or a future one) gets the
 *  already-resolved module synchronously. */
const Markdown = lazy(() =>
  import('../kit/markdown.js').then((mod) => ({ default: mod.Markdown })),
);

/**
 * components/chat/MessageBody (S8 W1-A2, audit C2): the `.message-bubble` content for one chat
 * row. `messageRole === 'assistant'` renders through `components/kit/markdown` — an LLM reply commonly
 * *contains* Markdown syntax (audit C2: a self-test report showed raw `##`/`**`/table pipes/
 * backticks). Every other role (`user`/`tool`/`system`) stays plain text: a user's own message is
 * verbatim keyboard input from the composer's `<textarea>`, not Markdown-authored, so rendering it
 * as Markdown would be both pointless and wrong (a literal `*` the user typed would turn into
 * emphasis it never meant); `tool`/`system` rows reaching this fallback (past
 * `isPendingCardMessage`/`systemStatusLineFromMessage` in `ChatPage.tsx`) are already-formatted
 * system copy, same reasoning.
 *
 * `.message-bubble` (styles/pages.css, unlayered) sets `white-space: pre-wrap` so a *plain-text*
 * message's own literal line breaks survive without a `<br>`. Markdown semantics disagree — a
 * single `\n` inside one paragraph is a soft break (collapses to a space; CommonMark), not a hard
 * one — so the assistant branch resets it back to `white-space: normal` with an inline `style`
 * (the one override that can beat an unlayered rule: `style` attributes sit outside every CSS
 * layer and always win). Markdown's own block elements (`<p>`, `<li>`, `<pre>`, …) still wrap and
 * lay out normally; `overflow-wrap: anywhere` (also on `.message-bubble`) is left alone, still
 * wrapping any long unbroken token (an id, a URL) either way. The `Suspense` fallback below
 * (before the Markdown chunk has loaded) renders the same raw text with `.pre-wrap` — so the very
 * first assistant message on a freshly-loaded page shows its text immediately, un-rendered, for
 * the one chunk-load instant, rather than nothing.
 */
export interface MessageBodyProps {
  // Named `messageRole`, not `role` — biome's `lint/a11y/useValidAriaRole` flags a JSX attribute
  // literally named `role` on *any* element, custom components included, and "assistant" etc.
  // are obviously not ARIA roles; renaming sidesteps the false positive instead of an `ignore` at
  // every call site.
  readonly messageRole: ChatMessage['role'];
  readonly text: string;
  /** Appended after the rendered content, outside it (e.g. the streaming caret) — see
   *  `ChatPage.tsx`'s streaming turn preview, which has no persisted message to key a
   *  `MessageBody` by. Not part of the Markdown source itself: keeping the caret a DOM sibling
   *  (rather than a literal character appended to `text`) preserves its own CSS `::after`
   *  animation (`.streaming-caret`, `styles/pages.css`) instead of flattening it to plain text. */
  readonly trailing?: ReactNode;
}

export function MessageBody({ messageRole, text, trailing }: MessageBodyProps) {
  if (messageRole !== 'assistant') {
    return (
      <div className="message-bubble message-text">
        {text}
        {trailing}
      </div>
    );
  }
  return (
    <div className="message-bubble message-text" style={{ whiteSpace: 'normal' }}>
      <Suspense fallback={<span className="pre-wrap">{text}</span>}>
        <Markdown content={text} />
      </Suspense>
      {trailing}
    </div>
  );
}
