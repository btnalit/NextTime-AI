// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { ProvenanceDrawer } from './ProvenanceDrawer.js';
import { CONFLICT, FACTS, NOW, scriptedHttp } from './test-fixtures.js';

afterEach(cleanup);

describe('ProvenanceDrawer', () => {
  it('stays closed without a Fact', () => {
    render(
      <ProvenanceDrawer http={scriptedHttp()} fact={null} asOf={NOW} onClose={() => undefined} />,
    );
    expect(screen.queryByTestId('graph-provenance-drawer')).toBeNull();
  });

  it('shows the conflict notice and the error state with Retry', async () => {
    let attempts = 0;
    const http = scriptedHttp({
      explain: () => {
        attempts += 1;
        if (attempts === 1) throw new HttpError('capability_error', 'nope', 'not_found');
        return {
          nodeType: 'fact',
          fact: {
            id: 'f-2',
            linkType: 'runs_on',
            epistemicStatus: 'observed',
            assertedByPrincipal: null,
            verifiedByPrincipal: null,
            observationId: null,
            invalidatedAt: null,
            invalidationReason: null,
            lastObservation: null,
          },
          activity: null,
        };
      },
    });
    const onClose = vi.fn();
    render(
      <ProvenanceDrawer
        http={http}
        fact={FACTS[1] ?? null}
        asOf={NOW}
        conflicts={[CONFLICT]}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('graph-provenance-conflicts').textContent).toContain(
      '1 open Conflict',
    );
    expect(screen.getByTestId('graph-provenance-freshness').getAttribute('data-freshness')).toBe(
      'conflict',
    );
    const banner = await screen.findByTestId('graph-provenance-error');
    expect(banner.getAttribute('data-error-code')).toBe('not_found');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('graph-provenance-chain');
    // A Fact with no Observation and no Activity keeps the missing segments visible.
    expect(screen.getByTestId('prov-activity').getAttribute('data-present')).toBe('false');
    expect(screen.getByTestId('prov-source').getAttribute('data-present')).toBe('false');
    expect(screen.getByTestId('graph-open-in-audit').getAttribute('href')).toBe(
      '#/govern/audit?nodeId=f-2',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
