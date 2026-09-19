import { type MarkdownBlock, parseMarkdownBlocks } from '../../lib/catalog.js';

/** components/catalog/MarkdownPreview: the SKILL.md body rendered from `parseMarkdownBlocks`
 *  (lib/catalog.ts) as React elements — headings, paragraphs, lists, fenced code; inline
 *  syntax stays literal. No dependency and no HTML injection (§5.3 "预览"). */
export function MarkdownPreview({
  markdown,
  testId,
}: { readonly markdown: string; readonly testId?: string }) {
  const blocks = parseMarkdownBlocks(markdown);
  if (blocks.length === 0) {
    return (
      <p className="text-3 text-small" data-testid={testId}>
        （空正文 empty body）
      </p>
    );
  }
  return (
    <div className="stack-s markdown-preview" data-testid={testId}>
      {blocks.map((block, index) => (
        <Block key={`${index}:${block.kind}`} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { readonly block: MarkdownBlock }) {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level));
      // Preview headings sit under the page's own h1/h2: start at h3 so the outline stays sane.
      const Tag = `h${Math.min(6, level + 2)}` as 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag>{block.text}</Tag>;
    }
    case 'code':
      return (
        <pre className="code-block" data-lang={block.lang || undefined}>
          {block.text}
        </pre>
      );
    case 'list':
      return block.ordered ? (
        <ol>
          {block.items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      );
    default:
      return <p className="pre-wrap">{block.text}</p>;
  }
}
