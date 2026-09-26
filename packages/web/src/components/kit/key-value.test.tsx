// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyValue } from './key-value.js';

afterEach(cleanup);

describe('kit/KeyValue', () => {
  it('renders each item as a dt/dd pair inside a definition-list dl', () => {
    const { container } = render(
      <KeyValue
        testId="kv"
        items={[
          { label: 'Gatekeeper', value: 'nexttime-ai-kernel-1' },
          { label: 'Scope', value: 'docker.container.restart', mono: true },
        ]}
      />,
    );
    const dl = screen.getByTestId('kv');
    expect(dl.tagName).toBe('DL');
    expect(dl.className).toContain('definition-list');
    const terms = container.querySelectorAll('dt');
    const descriptions = container.querySelectorAll('dd');
    expect(terms).toHaveLength(2);
    expect(descriptions).toHaveLength(2);
    expect(terms[0]?.textContent).toBe('Gatekeeper');
    expect(descriptions[0]?.textContent).toBe('nexttime-ai-kernel-1');
  });

  it('adds .mono only to rows that ask for it', () => {
    const { container } = render(
      <KeyValue
        items={[
          { label: 'Name', value: 'Acme' },
          { label: 'Id', value: 'ws-abc123', mono: true },
        ]}
      />,
    );
    const descriptions = container.querySelectorAll('dd');
    expect(descriptions[0]?.className).toBe('');
    expect(descriptions[1]?.className).toBe('mono');
  });

  it('renders nothing when items is empty', () => {
    const { container } = render(<KeyValue items={[]} testId="kv-empty" />);
    expect(container.querySelectorAll('dt')).toHaveLength(0);
    expect(screen.getByTestId('kv-empty').children).toHaveLength(0);
  });
});
