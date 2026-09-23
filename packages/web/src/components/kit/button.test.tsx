// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './button.js';

afterEach(cleanup);

describe('kit/Button', () => {
  it('renders a button with role="button" and the default (secondary/m) variant classes', () => {
    render(<Button>保存</Button>);
    const button = screen.getByRole('button', { name: '保存' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('bg-surface-2');
    expect(button.className).toContain('h-9');
  });

  it('applies the primary variant class (ink background)', () => {
    render(<Button variant="primary">确认</Button>);
    expect(screen.getByRole('button', { name: '确认' }).className).toContain('bg-text');
  });

  it('applies the danger variant class', () => {
    render(<Button variant="danger">删除</Button>);
    expect(screen.getByRole('button', { name: '删除' }).className).toContain('bg-danger-soft');
  });

  it('applies the s size class (28px floor)', () => {
    render(<Button size="s">刷新</Button>);
    expect(screen.getByRole('button', { name: '刷新' }).className).toContain('h-7');
  });

  it('asChild renders the single child element instead of a <button>, merging classes', () => {
    render(
      <Button asChild variant="primary">
        <a href="#/work/chats">对话</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: '对话' });
    expect(link.tagName).toBe('A');
    expect(link.className).toContain('bg-text');
  });
});
