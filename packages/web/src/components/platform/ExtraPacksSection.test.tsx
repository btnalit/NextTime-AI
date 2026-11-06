// @vitest-environment jsdom
import type { ExtraPacksWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ExtraPacksSection } from './ExtraPacksSection.js';

afterEach(() => cleanup());

function status(overrides: Partial<ExtraPacksWire> = {}): ExtraPacksWire {
  return {
    configured: true,
    packs: [],
    skipped: [],
    unreadable: null,
    checkedAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  };
}

function httpReturning(...answers: ExtraPacksWire[]): CapabilityCaller {
  let next = 0;
  return {
    call: vi.fn(async (name: string) => {
      if (name !== 'extra_packs_status') throw new Error(`unscripted capability ${name}`);
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      return answer;
    }) as CapabilityCaller['call'],
  };
}

/** S11 AA5d-3: the platform's view of the extra packs directory. */
describe('ExtraPacksSection', () => {
  it('without the directory: says so, and how to make it', async () => {
    render(<ExtraPacksSection http={httpReturning(status({ configured: false }))} />);
    const notice = await screen.findByTestId('extra-packs-not-configured');
    expect(notice.textContent).toContain('没有配置附加能力包目录');
    expect(notice.textContent).toContain('§14.10');
    expect(screen.queryByTestId('extra-packs-list')).toBeNull();
  });

  it('lists the packs read and every one left out with its rule; Read again reads anew', async () => {
    const http = httpReturning(
      status({
        packs: [{ name: 'ticket-desk', summary: 'Ticket triage.', latestVersion: 1 }],
        skipped: [
          {
            name: 'org-broken',
            reason: 'org-broken/1/pack.yaml: summary is required',
          },
        ],
      }),
      status({
        packs: [
          { name: 'org-broken', summary: 'Fixed.', latestVersion: 1 },
          { name: 'ticket-desk', summary: 'Ticket triage.', latestVersion: 1 },
        ],
      }),
    );
    render(<ExtraPacksSection http={http} />);
    const row = await screen.findByTestId('extra-pack-ticket-desk');
    expect(row.textContent).toContain('v1');
    expect(row.textContent).toContain('Ticket triage.');
    expect(screen.getByTestId('extra-packs-skipped').textContent).toContain('有 1 个目录');
    expect(screen.getByTestId('extra-pack-skipped-org-broken').textContent).toContain(
      'org-broken/1/pack.yaml: summary is required',
    );

    fireEvent.click(screen.getByTestId('extra-packs-reload'));
    await waitFor(() => expect(screen.queryByTestId('extra-packs-skipped')).toBeNull());
    expect(screen.getByTestId('extra-pack-org-broken')).toBeTruthy();
    expect(http.call).toHaveBeenCalledTimes(2);
  });

  it('an empty directory, and one that cannot be read', async () => {
    render(<ExtraPacksSection http={httpReturning(status())} />);
    expect((await screen.findByTestId('extra-packs-none')).textContent).toContain('还没有能力包');
    cleanup();
    render(
      <ExtraPacksSection
        http={httpReturning(status({ unreadable: 'EACCES: permission denied' }))}
      />,
    );
    const unreadable = await screen.findByTestId('extra-packs-unreadable');
    expect(unreadable.textContent).toContain('EACCES: permission denied');
    expect(screen.queryByTestId('extra-packs-none')).toBeNull();
  });
});
