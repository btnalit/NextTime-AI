import type { ComponentProps } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table.js';

/**
 * components/kit/markdown (S8 W1-A2, docs/development-tasks.md §5e decision F3; audit C2): the
 * one Markdown renderer for assistant chat messages — headings, bold/italic, lists, links, inline
 * code, fenced code blocks, GFM tables (via `remark-gfm`) and blockquotes, on the §5.9 tokens.
 * Deliberately restricted, not a general Markdown viewer:
 *
 * - **Never renders raw HTML.** No `rehype-raw` is wired in, and `skipHtml={false}` is passed
 *   explicitly (react-markdown's own default) so any literal HTML in the source — `<script>`,
 *   `<img onerror=…>`, a stray `<div>` — becomes an inert *text* node instead of a real element
 *   (react-markdown's `transform`: a `raw` hast node becomes `{type:'text', value}` unless
 *   `skipHtml` drops it entirely; text nodes are always React-escaped, never `dangerouslySet…`).
 *   `skipHtml` is kept `false` rather than `true` on purpose — the audit wants the raw markup
 *   *visible* as text (so a self-test report showing `##`/`**`/`` ` `` is still legible once this
 *   lands), not silently deleted.
 * - **No images.** The CSP (`deploy/caddy/Caddyfile`, read-only for this lane) already sets
 *   `img-src 'self' data:`, so a remote `![alt](https://…)` would be blocked by the browser
 *   anyway — `Img` below never emits an `<img>` at all and renders the alt text (or nothing, if
 *   there is none) as plain text instead, so the failure mode is "shows as text" rather than "a
 *   broken image icon".
 * - **Links are allowlisted by scheme**, not just sanitized: `urlTransform` accepts only
 *   `http:`/`https:`/`mailto:` (react-markdown's own `defaultUrlTransform` additionally allows
 *   `irc(s):`/`xmpp:`/relative URLs — narrower here since a chat message has no legitimate
 *   relative link target). A rejected URL becomes `''`, and `Anchor` below renders *no* `<a>` at
 *   all when `href` is empty — the link text still shows, just as plain inert text, matching the
 *   "others rendered as text" requirement (covers `javascript:`, `data:`, `vbscript:`, bare/
 *   relative paths, and anything else not on the allowlist).
 * - **Monospace font is inherited, not re-declared.** `styles/base.css`'s `code, pre { font-family:
 *   var(--font-mono); font-size: var(--fs-13); }` is unlayered CSS; per the CSS Cascading Layers
 *   spec (see `packages/web/README.md` "No preflight, existing pages unaffected") an unlayered
 *   declaration always beats a Tailwind utility (which lives in `layer(utilities)`) for the same
 *   property — so adding `font-mono`/`text-13` utility classes here would be silently overridden
 *   dead code. Only the properties that rule does *not* set (background, border, radius, padding,
 *   horizontal scroll) are styled with Tailwind below.
 */
export interface MarkdownProps {
  readonly content: string;
  readonly className?: string;
}

const ALLOWED_URL = /^(https?|mailto):/i;

function urlTransform(url: string): string {
  return ALLOWED_URL.test(url) ? url : '';
}

type Props<Tag extends keyof JSX.IntrinsicElements> = ComponentProps<Tag> & ExtraProps;

function Anchor({ href, children, node: _node, ...rest }: Props<'a'>) {
  if (!href) return <>{children}</>;
  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2 hover:text-accent-hover"
    >
      {children}
    </a>
  );
}

function Img({ alt }: Props<'img'>) {
  // Never render <img> from message content — see the module doc comment above.
  return alt ? <>{alt}</> : null;
}

/** Fenced block vs. inline span: a fenced block's `<code>` always sits inside our `Pre` (structural
 *  signal from CommonMark itself — an inline span never has a `pre` parent), and also usually
 *  carries a `language-xxx` className when a fence names a language, or spans multiple lines when
 *  it does not. The one miss (a one-line fenced block with no language tag) still renders inside
 *  `Pre`'s scroll/border box, just with the inline span's own small padding too — a cosmetic edge
 *  case, not a policy one. */
function Code({ className, children, node: _node, ...rest }: Props<'code'>) {
  const isBlock = /language-/.test(className ?? '') || String(children).includes('\n');
  if (isBlock) {
    return (
      <code {...rest} className={className}>
        {children}
      </code>
    );
  }
  return (
    <code {...rest} className={cn('rounded-s bg-surface-2 px-1 py-0.5', className)}>
      {children}
    </code>
  );
}

function Pre({ children, node: _node, ...rest }: Props<'pre'>) {
  return (
    <pre
      {...rest}
      className="overflow-x-auto rounded-m border border-border bg-surface-2 p-3 text-text-2"
    >
      {children}
    </pre>
  );
}

function Blockquote({ children, node: _node, ...rest }: Props<'blockquote'>) {
  return (
    <blockquote {...rest} className="border-l-2 border-border-strong pl-3 text-text-2">
      {children}
    </blockquote>
  );
}

/** Shared prop shape for every heading level — `ComponentProps<'h1'>` through `'h6'` are
 *  structurally identical (`HTMLAttributes<HTMLHeadingElement>`). */
type HeadingProps = Props<'h1'>;

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const sizeClass =
    level === 1 ? 'text-19' : level === 2 ? 'text-16' : level <= 4 ? 'text-14' : 'text-13';
  const Tag = `h${level}` as const;
  return function Heading({ children, node: _node, ...rest }: HeadingProps) {
    return (
      <Tag {...rest} className={cn(sizeClass, 'font-semibold')}>
        {children}
      </Tag>
    );
  };
}

function Paragraph({ children, node: _node, ...rest }: Props<'p'>) {
  return <p {...rest}>{children}</p>;
}

function UnorderedList({ children, node: _node, ...rest }: Props<'ul'>) {
  return (
    <ul {...rest} className="list-disc pl-5">
      {children}
    </ul>
  );
}

function OrderedList({ children, node: _node, ...rest }: Props<'ol'>) {
  return (
    <ol {...rest} className="list-decimal pl-5">
      {children}
    </ol>
  );
}

function ListItem({ children, node: _node, ...rest }: Props<'li'>) {
  return <li {...rest}>{children}</li>;
}

function MarkdownTable({ children, node: _node, ...rest }: Props<'table'>) {
  return <Table {...rest}>{children}</Table>;
}

function MarkdownThead({ children, node: _node, ...rest }: Props<'thead'>) {
  return <TableHeader {...rest}>{children}</TableHeader>;
}

function MarkdownTbody({ children, node: _node, ...rest }: Props<'tbody'>) {
  return <TableBody {...rest}>{children}</TableBody>;
}

function MarkdownTr({ children, node: _node, ...rest }: Props<'tr'>) {
  return <TableRow {...rest}>{children}</TableRow>;
}

function MarkdownTh({ children, node: _node, ...rest }: Props<'th'>) {
  return <TableHead {...rest}>{children}</TableHead>;
}

function MarkdownTd({ children, node: _node, ...rest }: Props<'td'>) {
  return <TableCell {...rest}>{children}</TableCell>;
}

const components: Components = {
  a: Anchor,
  img: Img,
  code: Code,
  pre: Pre,
  blockquote: Blockquote,
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  p: Paragraph,
  ul: UnorderedList,
  ol: OrderedList,
  li: ListItem,
  table: MarkdownTable,
  thead: MarkdownThead,
  tbody: MarkdownTbody,
  tr: MarkdownTr,
  th: MarkdownTh,
  td: MarkdownTd,
};

/** Renders `content` as the restricted Markdown subset described above. Safe to call with a
 *  partial, still-streaming string (an unclosed fenced code block, a half-written table row) —
 *  `remark-parse` treats unterminated constructs as plain text/best-effort rather than throwing,
 *  so a partial render never crashes; it just looks momentarily unfinished until the next chunk
 *  completes it. */
export function Markdown({ content, className }: MarkdownProps) {
  return (
    <ReactMarkdown
      className={cn('markdown-body break-words', className)}
      remarkPlugins={[remarkGfm]}
      skipHtml={false}
      urlTransform={urlTransform}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
