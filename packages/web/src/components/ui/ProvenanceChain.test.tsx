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
    // Legacy sweep (console batch, 2026-10-16): statuses read as labels, never the raw value.
    expect(screen.getByTestId('prov-fact-epistemic-status').textContent).toBe('已验证');
    expect(within(fact).queryByText('verified')).toBeNull();

    const activity = screen.getByTestId('prov-activity');
    // An activity kind the label table does not know keeps its raw name.
    expect(within(activity).getByText('ingest')).toBeTruthy();
    expect(screen.getByTestId('prov-activity-status').textContent).toBe('已完成');
    expect(within(activity).queryByText('completed')).toBeNull();
    // A principal without a display name degrades to the bare-id RefChip.
    expect(activity.querySelector('.ref-chip-bare')).toBeTruthy();

    // Source resolved from the fact's last observation when not given directly.
    const source = screen.getByTestId('prov-source');
    expect(source.getAttribute('data-present')).toBe('true');
    expect(within(source).getByText('ragflow://kb/1')).toBeTruthy();
    expect(screen.getByTestId('prov-source-visibility').textContent).toBe('工作区可见');
    expect(within(source).queryByText('workspace')).toBeNull();

    const details = screen.getByTestId('prov-raw');
    expect(details.textContent).toContain('原始证据');
    expect(details.querySelector('pre')?.textContent).toContain('"nodeType": "fact"');
  });

  it('legacy sweep: a known Activity kind and Source kind read as labels, not the raw kind', () => {
    render(
      <ProvenanceChain
        activity={{ id: 'act-2', kind: 'worker_result', status: 'interrupted' }}
        source={{ id: 'src-2', kind: 'worker_run', visibility: 'private' }}
      />,
    );
    const activity = screen.getByTestId('prov-activity');
    expect(within(activity).getByText('Worker 结果')).toBeTruthy();
    expect(within(activity).queryByText('worker_result')).toBeNull();
    expect(screen.getByTestId('prov-activity-status').textContent).toBe('已中断');
    const source = screen.getByTestId('prov-source');
    expect(within(source).getByText('Worker 运行')).toBeTruthy();
    expect(within(source).queryByText('worker_run')).toBeNull();
    expect(screen.getByTestId('prov-source-visibility').textContent).toBe('仅自己');
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
