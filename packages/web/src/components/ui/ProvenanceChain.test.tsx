// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProvenanceChain } from './ProvenanceChain.js';

afterEach(cleanup);

describe('ProvenanceChain', () => {
  it('renders the three segments from an explain-shaped result, with the raw disclosure', () => {
    const raw = { nodeType: 'fact' };
    render(
      <ProvenanceChain
        fact={{
          id: 'fact-1',
          linkType: 'depends_on',
          epistemicStatus: 'verified',
          assertedByPrincipal: { id: 'p-1', displayName: 'collector' },
          lastObservation: {
            id: 'obs-1',
            createdAt: '2026-09-01T00:00:00Z',
            source: {
              id: 'src-1',
              kind: 'ragflow',
              uri: 'ragflow://kb/1',
              visibility: 'workspace',
            },
          },
        }}
        activity={{
          id: 'act-1',
          kind: 'ingest',
          status: 'completed',
          createdAt: '2026-09-01T00:00:00Z',
          startedByPrincipal: { id: 'p-2', displayName: null },
        }}
        raw={raw}
        hrefFor={(kind, id) => `#/${kind}/${id}`}
        testId="chain"
      />,
    );
    const fact = screen.getByTestId('prov-fact');
    expect(fact.getAttribute('data-present')).toBe('true');
    expect(within(fact).getByRole('link', { name: 'depends_on' }).getAttribute('href')).toBe(
      '#/object/fact-1',
    );
    expect(within(fact).getByText('collector')).toBeTruthy();
    expect(within(fact).getByText('verified')).toBeTruthy();

    const activity = screen.getByTestId('prov-activity');
    expect(within(activity).getByText('ingest')).toBeTruthy();
    // A principal without a display name degrades to the bare-id RefChip.
    expect(activity.querySelector('.ref-chip-bare')).toBeTruthy();

    // Source resolved from the fact's last observation when not given directly.
    const source = screen.getByTestId('prov-source');
    expect(source.getAttribute('data-present')).toBe('true');
    expect(within(source).getByText('ragflow://kb/1')).toBeTruthy();

    const details = screen.getByTestId('prov-raw');
    expect(details.textContent).toContain('原始证据');
    expect(details.querySelector('pre')?.textContent).toContain('"nodeType": "fact"');
  });

  it('keeps a missing segment visible as "Not recorded" instead of dropping it', () => {
    render(<ProvenanceChain fact={{ id: 'f' }} />);
    expect(screen.getByTestId('prov-fact').getAttribute('data-present')).toBe('true');
    expect(screen.getByTestId('prov-activity').getAttribute('data-present')).toBe('false');
    expect(screen.getByTestId('prov-activity').textContent).toContain('无');
    expect(screen.getByTestId('prov-source').getAttribute('data-present')).toBe('false');
    expect(screen.queryByTestId('prov-raw')).toBeNull();
  });
});
