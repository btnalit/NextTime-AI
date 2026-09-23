// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './markdown.js';

afterEach(cleanup);

describe('kit/Markdown', () => {
  it('renders headings, bold, lists and inline code as real elements', () => {
    const { container } = render(
      <Markdown content={'# 标题\n\n**加粗** 与 `inline code`\n\n- 第一项\n- 第二项'} />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('标题');
    expect(container.querySelector('strong')?.textContent).toBe('加粗');
    expect(container.querySelector('code')?.textContent).toBe('inline code');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders a GFM table as real <table> elements', () => {
    const content = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const { container } = render(<Markdown content={content} />);
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders a fenced code block inside a scrollable <pre>', () => {
    const content = ['```json', '{"a": 1}', '```'].join('\n');
    const { container } = render(<Markdown content={content} />);
    const pre = container.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre?.className).toContain('overflow-x-auto');
    expect(pre?.querySelector('code')?.textContent).toContain('{"a": 1}');
  });

  it('wraps a wide GFM table in a horizontal scroll container so it never pushes the chat column', () => {
    const header = Array.from({ length: 12 }, (_, i) => `列${i}`).join(' | ');
    const sep = Array.from({ length: 12 }, () => '---').join(' | ');
    const row = Array.from({ length: 12 }, (_, i) => `值${i}`).join(' | ');
    const content = [`| ${header} |`, `| ${sep} |`, `| ${row} |`].join('\n');
    const { container } = render(<Markdown content={content} />);
    const table = container.querySelector('table');
    const scrollParent = table?.parentElement;
    expect(scrollParent?.className).toContain('overflow-x-auto');
  });

  describe('never renders raw HTML — inert text instead', () => {
    it('a <script> tag is inert text, never an executable element', () => {
      const { container } = render(<Markdown content={'before <script>alert(1)</script> after'} />);
      expect(container.querySelector('script')).toBeNull();
      expect(container.textContent).toContain('<script>alert(1)</script>');
    });

    it('an <img onerror=…> tag never becomes a real <img> element', () => {
      const { container } = render(<Markdown content={'<img src=x onerror="alert(1)">'} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('onerror');
    });

    it('a Markdown ![]() image never renders an <img> — alt text only', () => {
      const { container } = render(<Markdown content={'![danger](https://evil.example/x.png)'} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('danger');
    });
  });

  describe('links are scheme-allowlisted; everything else renders as inert text', () => {
    it('keeps an https link as a real, safely-attributed <a>', () => {
      const { container } = render(<Markdown content={'[ok](https://example.com/path)'} />);
      const a = container.querySelector('a');
      expect(a).toBeTruthy();
      expect(a?.getAttribute('href')).toBe('https://example.com/path');
      expect(a?.getAttribute('target')).toBe('_blank');
      expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('keeps a mailto: link', () => {
      const { container } = render(<Markdown content={'[mail](mailto:a@example.com)'} />);
      expect(container.querySelector('a')?.getAttribute('href')).toBe('mailto:a@example.com');
    });

    it('a javascript: link renders no <a> — the label is plain text', () => {
      const { container } = render(<Markdown content={'[click](javascript:alert(1))'} />);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toContain('click');
    });

    it('a data: link renders no <a>', () => {
      const { container } = render(
        <Markdown content={'[x](data:text/html,<script>alert(1)</script>)'} />,
      );
      expect(container.querySelector('a')).toBeNull();
    });
  });

  describe('streaming: partial Markdown never throws', () => {
    it('an unclosed fenced code block renders without throwing', () => {
      expect(() => render(<Markdown content={'answer:\n\n```json\n{"a": 1, "b'} />)).not.toThrow();
      expect(screen.getByText(/answer:/)).toBeTruthy();
    });

    it('an unclosed table row renders without throwing', () => {
      expect(() => render(<Markdown content={'| A | B |\n| --- | --- |\n| 1 |'} />)).not.toThrow();
    });

    it('an unclosed bold/emphasis marker renders without throwing', () => {
      expect(() =>
        render(<Markdown content={'partial **bold text that never closes'} />),
      ).not.toThrow();
    });

    it('re-rendering with growing content across several chunks never throws', () => {
      const [first, ...rest] = [
        '# Rep',
        '# Report\n\n- one',
        '# Report\n\n- one\n- two\n\n```js\nconst x =',
      ];
      const { rerender } = render(<Markdown content={first} />);
      for (const content of rest) {
        expect(() => rerender(<Markdown content={content} />)).not.toThrow();
      }
    });
  });
});
