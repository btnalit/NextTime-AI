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
    // Not configured is the kernel's EXTRA_PACKS_DIR unset: a directory on the host alone does not change it.
    expect(notice.textContent).toContain('内核没有设置附加能力包目录');
    expect(notice.textContent).toContain('EXTRA_PACKS_DIR');
    expect(notice.textContent).toContain('§14.10');
    expect(screen.queryByTestId('extra-packs-list')).toBeNull();
  });

  it('lists the packs read and every one left out with its rule; Read again reads anew', async () => {
    const http = httpReturning(
      status({
        packs: [{ name: 'ticket-desk', summary: 'Ticket triage.', latestVersion: 1, warnings: [] }],
        skipped: [
          {
            name: 'org-broken',
            reason: 'org-broken/1/pack.yaml: summary is required',
          },
        ],
      }),
      status({
        packs: [
          { name: 'org-broken', summary: 'Fixed.', latestVersion: 1, warnings: [] },
          { name: 'ticket-desk', summary: 'Ticket triage.', latestVersion: 1, warnings: [] },
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

  it('legacy 705: a pack read with a warning says which later versions it cannot sit beside', async () => {
    const reason =
      'version 1: LinkType "ticket_on_host" range "Host" names an ObjectType pack "ops-hosts" declares at the version it requires but not at v3; it cannot be installed beside that version';
    render(
      <ExtraPacksSection
        http={httpReturning(
          status({
            packs: [
              { name: 'clean-pack', summary: 'Fine.', latestVersion: 1, warnings: [] },
              {
                name: 'ticket-desk',
                summary: 'Ticket triage.',
                latestVersion: 1,
                warnings: [reason],
              },
            ],
          }),
        )}
      />,
    );
    const warning = await screen.findByTestId('extra-pack-warnings-ticket-desk');
    expect(warning.textContent).toContain('不能和它依赖的包的某些更高版本一起装');
    expect(warning.textContent).toContain(reason);
    // The pack is still listed as read, and a clean pack carries no warning.
    expect(screen.getByTestId('extra-pack-ticket-desk').textContent).toContain('Ticket triage.');
    expect(screen.queryByTestId('extra-pack-warnings-clean-pack')).toBeNull();
    expect(screen.queryByTestId('extra-packs-skipped')).toBeNull();
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
