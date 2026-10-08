// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { DISMISSED_STORAGE_KEY } from '../../lib/platform-updates.js';
import { UpdateReminder } from './UpdateReminder.js';
import {
  availablePlatformUpdate,
  feedFreshness,
  piUpdate,
  platformUpdates,
} from './test-fixtures.js';

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function scriptedHttp(answer: () => unknown | Promise<unknown>): CapabilityCaller {
  return {
    call: vi.fn(async (name: string) => {
      if (name !== 'platform_updates') throw new Error(`unscripted capability ${name}`);
      return answer();
    }) as CapabilityCaller['call'],
  };
}

function renderReminder(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <UpdateReminder http={http} />
    </PermissionsProvider>,
  );
}

describe('UpdateReminder', () => {
  it('platform release: title, fact line, notes link, upgrade command and checklist — and no upgrade button', async () => {
    renderReminder(
      scriptedHttp(() => platformUpdates({ platformUpdate: availablePlatformUpdate() })),
    );

    const notice = await screen.findByTestId('update-notice-platform');
    expect(within(notice).getByTestId('update-notice-platform-title').textContent).toBe(
      'v0.43.0 可用',
    );
    expect(within(notice).getByTestId('update-notice-platform-facts').textContent).toMatch(
      /^内置 pi 1\.0\.2 · 迁移 core 0041 · 非 breaking$/,
    );
    const link = within(notice).getByTestId('update-notice-platform-link');
    expect(link.getAttribute('href')).toBe('https://github.com/example/repo/releases/tag/v0.43.0');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toBe('发版说明');

    const steps = within(notice).getByTestId('update-notice-platform-steps');
    expect(steps.tagName).toBe('DETAILS');
    expect(steps.textContent).toContain('升级步骤');
    const command = within(steps).getByTestId('update-notice-platform-command');
    expect(command.tagName).toBe('CODE');
    expect(command.textContent).toBe('sh scripts/apply-release.sh --pull v0.43.0');
    expect(steps.textContent).toContain('先备份');
    expect(within(steps).getByTestId('update-notice-platform-migrations').textContent).toContain(
      'core 0041',
    );
    expect(within(steps).getByTestId('update-notice-platform-rollback').textContent).toContain(
      'v0.42.0',
    );
    expect(steps.textContent).toContain('docs/runbooks/release.md §5');
    // Decisions 2/3: the only button is 知道了.
    expect(
      within(notice)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['知道了']);
  });

  it('several newer releases are said to span N; breaking is a warn tone with its own wording; no migrations says so', async () => {
    const base = availablePlatformUpdate();
    const first = base.newerReleases[0];
    if (!first) throw new Error('fixture');
    renderReminder(
      scriptedHttp(() =>
        platformUpdates({
          platformUpdate: availablePlatformUpdate({
            latestVersion: 'v0.44.0',
            breaking: true,
            migrations: [],
            newerReleases: [
              { ...first, version: 'v0.44.0', migrations: [], breaking: true },
              first,
            ],
          }),
        }),
      ),
    );
    const notice = await screen.findByTestId('update-notice-platform');
    expect(within(notice).getByTestId('update-notice-platform-title').textContent).toBe(
      'v0.44.0 可用（跨 2 个发版）',
    );
    expect(within(notice).getByTestId('update-notice-platform-facts').textContent).toBe(
      '内置 pi 1.0.2 · 无迁移 · 含 breaking 变更',
    );
    expect(notice.className).toContain('notice-warn');
  });

  it('pi pending_release: says so, mentions the manual checks, links the run', async () => {
    renderReminder(
      scriptedHttp(() =>
        platformUpdates({
          piUpdate: piUpdate({
            state: 'pending_release',
            upstreamLatest: '1.0.2',
            runUrl: 'https://github.com/example/repo/actions/runs/42',
          }),
        }),
      ),
    );
    const notice = await screen.findByTestId('update-notice-pi-pending');
    expect(notice.textContent).toContain('pi 1.0.2 可用，兼容性初查通过，等待平台发版');
    expect(notice.textContent).toContain('SDK 套件已通过');
    expect(notice.textContent).toContain('docs/runbooks/pi-upgrade.md §2');
    const link = within(notice).getByTestId('update-notice-pi-pending-link');
    expect(link.getAttribute('href')).toBe('https://github.com/example/repo/actions/runs/42');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('pi incompatible: warn tone, failure summary, run link', async () => {
    renderReminder(
      scriptedHttp(() =>
        platformUpdates({
          piUpdate: piUpdate({
            state: 'incompatible',
            upstreamLatest: '1.1.0',
            sdkSuite: 'fail',
            failureSummary: 'translatePiEvent threw on tool_execution_update',
            runUrl: 'https://github.com/example/repo/actions/runs/43',
          }),
        }),
      ),
    );
    const notice = await screen.findByTestId('update-notice-pi-incompatible');
    expect(notice.className).toContain('notice-warn');
    expect(notice.textContent).toContain('pi 1.1.0 与本平台不兼容，暂不可升');
    expect(within(notice).getByTestId('update-notice-pi-incompatible-summary').textContent).toBe(
      'translatePiEvent threw on tool_execution_update',
    );
    expect(within(notice).getByTestId('update-notice-pi-incompatible-link')).toBeTruthy();
  });

  it('feed stale: how many days, and where to look; hours when under a day', async () => {
    const days = Date.now() - 3 * 86_400_000 - 3_600_000;
    renderReminder(
      scriptedHttp(() =>
        platformUpdates({
          feedFreshness: feedFreshness({
            status: 'stale',
            fetchedAt: new Date(days).toISOString(),
          }),
        }),
      ),
    );
    const notice = await screen.findByTestId('update-notice-feed-stale');
    expect(within(notice).getByTestId('update-notice-feed-stale-title').textContent).toBe(
      '版本信息已 3 天未更新',
    );
    expect(notice.textContent).toContain('update-feed');
    cleanup();

    const hours = Date.now() - 5 * 3_600_000 - 60_000;
    renderReminder(
      scriptedHttp(() =>
        platformUpdates({
          feedFreshness: feedFreshness({
            status: 'stale',
            fetchedAt: new Date(hours).toISOString(),
          }),
        }),
      ),
    );
    expect((await screen.findByTestId('update-notice-feed-stale-title')).textContent).toBe(
      '版本信息已 5 小时未更新',
    );
  });

  it('feed invalid: danger tone, the detail only behind 技术细节', async () => {
    renderReminder(
      scriptedHttp(() =>
        platformUpdates({
          platformUpdate: null,
          feedFreshness: feedFreshness({
            status: 'invalid',
            fetchedAt: null,
            detail: 'channel.json: platform.releases[0].version does not match',
          }),
        }),
      ),
    );
    const notice = await screen.findByTestId('update-notice-feed-invalid');
    expect(notice.className).toContain('notice-danger');
    expect(notice.textContent).toContain('版本信息异常');
    expect(notice.textContent).toContain('内核拒绝了下载到的版本记录');
    const detail = within(notice).getByTestId('update-notice-feed-invalid-detail');
    expect(detail.closest('details')).not.toBeNull();
    expect(detail.textContent).toContain('platform.releases[0].version');
  });

  it('renders nothing for the quiet state, a missing feed, a failed read and while loading', async () => {
    const quiet = scriptedHttp(() => platformUpdates());
    const { container, unmount } = renderReminder(quiet);
    await waitFor(() => expect(quiet.call).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    unmount();

    const missing = scriptedHttp(() =>
      platformUpdates({
        platformUpdate: null,
        feedFreshness: feedFreshness({ status: 'missing', fetchedAt: null, generatedAt: null }),
      }),
    );
    const second = renderReminder(missing);
    await waitFor(() => expect(missing.call).toHaveBeenCalled());
    expect(second.container.textContent).toBe('');
    second.unmount();

    const failing = scriptedHttp(() => {
      throw new Error('boom');
    });
    const third = renderReminder(failing);
    await waitFor(() => expect(failing.call).toHaveBeenCalled());
    expect(third.container.textContent).toBe('');
    third.unmount();

    const pending = scriptedHttp(() => new Promise(() => undefined));
    const fourth = renderReminder(pending);
    expect(fourth.container.textContent).toBe('');
  });

  it('知道了 hides that notice, persists it, and a different version shows again', async () => {
    const http = scriptedHttp(() => platformUpdates({ platformUpdate: availablePlatformUpdate() }));
    const first = renderReminder(http);
    await screen.findByTestId('update-notice-platform');
    fireEvent.click(screen.getByTestId('update-notice-platform-dismiss'));
    expect(screen.queryByTestId('update-notice-platform')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(DISMISSED_STORAGE_KEY) ?? '[]')).toEqual([
      'platform:v0.43.0',
    ]);
    first.unmount();

    // A fresh mount (page reload) still hides v0.43.0 ...
    const again = scriptedHttp(() =>
      platformUpdates({ platformUpdate: availablePlatformUpdate() }),
    );
    const second = renderReminder(again);
    await waitFor(() => expect(again.call).toHaveBeenCalled());
    expect(screen.queryByTestId('update-notice-platform')).toBeNull();
    second.unmount();

    // ... but v0.44.0 shows.
    const base = availablePlatformUpdate();
    const first044 = base.newerReleases[0];
    if (!first044) throw new Error('fixture');
    renderReminder(
      scriptedHttp(() =>
        platformUpdates({
          platformUpdate: availablePlatformUpdate({
            latestVersion: 'v0.44.0',
            newerReleases: [{ ...first044, version: 'v0.44.0' }, first044],
          }),
        }),
      ),
    );
    const notice = await screen.findByTestId('update-notice-platform');
    expect(notice.textContent).toContain('v0.44.0 可用');
  });

  it('dismissing one notice leaves the others; a changed feed state shows again', async () => {
    const stale = (fetchedAt: string) =>
      platformUpdates({
        platformUpdate: availablePlatformUpdate(),
        feedFreshness: feedFreshness({ status: 'stale', fetchedAt }),
      });
    const first = renderReminder(scriptedHttp(() => stale('2026-10-01T00:00:00.000Z')));
    await screen.findByTestId('update-notice-feed-stale');
    fireEvent.click(screen.getByTestId('update-notice-feed-stale-dismiss'));
    expect(screen.queryByTestId('update-notice-feed-stale')).toBeNull();
    expect(screen.getByTestId('update-notice-platform')).toBeTruthy();
    first.unmount();

    // Same stale download: still hidden. A newer download that is stale again: shown.
    const same = scriptedHttp(() => stale('2026-10-01T00:00:00.000Z'));
    const second = renderReminder(same);
    await screen.findByTestId('update-notice-platform');
    expect(screen.queryByTestId('update-notice-feed-stale')).toBeNull();
    second.unmount();

    renderReminder(scriptedHttp(() => stale('2026-10-03T00:00:00.000Z')));
    expect(await screen.findByTestId('update-notice-feed-stale')).toBeTruthy();
  });

  it('a throwing localStorage does not crash: notices show, dismissal holds for this view', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderReminder(
      scriptedHttp(() => platformUpdates({ platformUpdate: availablePlatformUpdate() })),
    );
    await screen.findByTestId('update-notice-platform');
    fireEvent.click(screen.getByTestId('update-notice-platform-dismiss'));
    expect(screen.queryByTestId('update-notice-platform')).toBeNull();
  });
});
