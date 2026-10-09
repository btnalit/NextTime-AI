// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { ProvenanceDrawer } from './ProvenanceDrawer.js';
import { CONFLICT, EXPLAIN_F1, FACTS, NOW, iso, scriptedHttp } from './test-fixtures.js';

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
      '1 个未解决冲突中',
    );
    expect(screen.getByTestId('graph-provenance-freshness').getAttribute('data-freshness')).toBe(
      'conflict',
    );
    const banner = await screen.findByTestId('graph-provenance-error');
    expect(banner.getAttribute('data-error-code')).toBe('not_found');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
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

  // STATUS leftover 89: a person's own confirmation shows as its own labelled row — who, when,
  // note, link — never mixed into the machine lineage.
  it('renders human attestations as distinct 人工确认 rows with who, when, note and a safe link', async () => {
    const http = scriptedHttp({
      explain: () => ({
        ...EXPLAIN_F1,
        fact: {
          ...(EXPLAIN_F1.fact as NonNullable<typeof EXPLAIN_F1.fact>),
          humanAttestations: [
            {
              id: 'ev-1',
              kind: 'human_attestation',
              note: '到机房核对过。',
              link: 'https://ticket.example/42',
              activityId: 'act-att-1',
              attestedByPrincipal: {
                id: 'p-alice',
                kind: 'human',
                role: 'member',
                displayName: 'Alice',
              },
              createdAt: iso(-5 * 60_000),
            },
            {
              id: 'ev-2',
              kind: 'human_attestation',
              note: 'second',
              // Never rendered as an href — only http(s) links become anchors.
              link: 'javascript:alert(1)',
              activityId: null,
              attestedByPrincipal: null,
              createdAt: iso(-60_000),
            },
          ],
        },
      }),
    });
    render(
      <ProvenanceDrawer http={http} fact={FACTS[0] ?? null} asOf={NOW} onClose={() => undefined} />,
    );
    const block = await screen.findByTestId('prov-human-attestations');
    expect(block.textContent).toContain('人工确认 · 2');
    const rows = screen.getAllByTestId('prov-human-attestation');
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(first.getAttribute('data-kind')).toBe('human_attestation');
    expect(first.textContent).toContain('人工确认');
    expect(first.textContent).toContain('Alice');
    expect(first.textContent).toContain('到机房核对过。');
    expect(within(first).getByTestId('prov-human-attestation-link').getAttribute('href')).toBe(
      'https://ticket.example/42',
    );
    // Its own block under the lineage — in none of the Fact / Activity / Source segments — with a
    // pointer from the Fact segment.
    for (const segment of ['prov-fact', 'prov-activity', 'prov-source']) {
      expect(screen.getByTestId(segment).contains(block)).toBe(false);
    }
    expect(screen.getByTestId('graph-provenance-chain').contains(block)).toBe(true);
    expect(screen.getByTestId('prov-fact-attestation-count').textContent).toContain('2');
    expect(within(rows[1] as HTMLElement).queryByTestId('prov-human-attestation-link')).toBeNull();
  });

  it('shows no attestation block for a Fact without any', async () => {
    render(
      <ProvenanceDrawer
        http={scriptedHttp()}
        fact={FACTS[0] ?? null}
        asOf={NOW}
        onClose={() => undefined}
      />,
    );
    await screen.findByTestId('graph-provenance-chain');
    expect(screen.queryByTestId('prov-human-attestations')).toBeNull();
  });
});
