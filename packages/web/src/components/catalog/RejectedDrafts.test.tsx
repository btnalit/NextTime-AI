// @vitest-environment jsdom
import type { DraftRejectionWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { RejectedDrafts } from './RejectedDrafts.js';

afterEach(() => {
  cleanup();
});

const SKILL = '11111111-2222-4333-8444-555555555555';
const OWNER = '66666666-7777-4888-8999-000000000000';
const RECENT = new Date(Date.now() - 5 * 60_000).toISOString();

function rejection(patch: Partial<DraftRejectionWire> = {}): DraftRejectionWire {
  return {
    kind: 'skill',
    id: SKILL,
    version: 2,
    name: 'restart-web',
    reason: 'Step two repeats step one.',
    rejectedBy: OWNER,
    rejectedAt: RECENT,
    ...patch,
  };
}

function scriptedHttp(
  listRejections: (params: unknown) => unknown,
  role = 'member',
): CapabilityCaller & { readonly calls: { name: string; params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      if (name === 'get_workspace') {
        return {
          id: 'ws-1',
          name: 'Acme',
          createdAt: '2026-01-01T00:00:00Z',
          principalCount: 2,
          gatekeeperCount: 0,
          caller: { id: 'p-1', role, displayName: 'Reader', kind: 'human' },
        };
      }
      if (name === 'list_draft_rejections') return listRejections(params);
      if (name === 'resolve_refs') {
        return { items: [{ kind: 'principal', id: OWNER, name: 'Olivia', typeName: 'human' }] };
      }
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
}

function show(http: CapabilityCaller, kind: 'skill' | 'procedure' = 'skill', reloadKey = 0) {
  return render(
    <PermissionsProvider>
      <RejectedDrafts http={http} kind={kind} reloadKey={reloadKey} />
    </PermissionsProvider>,
  );
}

describe('RejectedDrafts (legacy 491)', () => {
  it('lists each rejection of my drafts: name, version, who, when, and the reason', async () => {
    const http = scriptedHttp(() => ({ items: [rejection()] }));
    show(http);
    const section = await screen.findByTestId('skill-rejected-drafts');
    expect(within(section).getByText('被拒绝的草稿')).toBeTruthy();
    const [item, ...more] = within(section).getAllByTestId('skill-rejected-drafts-item');
    expect(more).toEqual([]);
    expect(item?.textContent).toContain('restart-web');
    expect(item?.textContent).toContain('v2');
    await waitFor(() => expect(item?.textContent).toContain('Olivia'));
    expect(item?.textContent).toContain('拒绝人');
    expect(item?.textContent).toContain('5 分钟前');
    const reason = within(item as HTMLElement).getByTestId('skill-rejected-drafts-reason');
    expect(reason.textContent?.startsWith('原因：')).toBe(true);
    expect(reason.textContent?.endsWith('Step two repeats step one.')).toBe(true);
    // It asks for this tab's kind only.
    expect(http.calls.find((c) => c.name === 'list_draft_rejections')?.params).toEqual({
      kind: 'skill',
    });
  });

  it('a Procedure tab asks for Procedures and says 流程', async () => {
    const http = scriptedHttp(() => ({ items: [rejection({ kind: 'procedure' })] }));
    show(http, 'procedure');
    const section = await screen.findByTestId('procedure-rejected-drafts');
    expect(section.textContent).toContain('你提议的流程草稿');
    expect(http.calls.find((c) => c.name === 'list_draft_rejections')?.params).toEqual({
      kind: 'procedure',
    });
  });

  it('a rejection from before names were recorded, and a masked reason, read as such', async () => {
    const http = scriptedHttp(() => ({
      items: [rejection({ name: null, reason: 'Drop PGPASSWORD=[redacted] from step two.' })],
    }));
    show(http);
    const item = await screen.findByTestId('skill-rejected-drafts-item');
    expect(within(item).getByTestId('skill-rejected-drafts-name').textContent).toBe(
      '（拒绝时未记下名字）',
    );
    expect(item.textContent).toContain('[redacted] 处的内容看起来像密码、令牌或密钥');
  });

  it('shows nothing when there is none, or on a 403', async () => {
    const empty = scriptedHttp(() => ({ items: [] }));
    const { unmount } = show(empty);
    await waitFor(() =>
      expect(empty.calls.some((c) => c.name === 'list_draft_rejections')).toBe(true),
    );
    expect(screen.queryByTestId('skill-rejected-drafts')).toBeNull();
    unmount();

    const forbidden = scriptedHttp(() => {
      throw new HttpError('capability_error', 'human only', 'forbidden');
    });
    show(forbidden);
    await waitFor(() =>
      expect(forbidden.calls.some((c) => c.name === 'list_draft_rejections')).toBe(true),
    );
    expect(screen.queryByTestId('skill-rejected-drafts')).toBeNull();
    expect(screen.queryByTestId('skill-rejected-drafts-error')).toBeNull();
  });

  it('a failed read says so, and 重试 reads again (UX acceptance of #792, P3-3)', async () => {
    let fail = true;
    const http = scriptedHttp(() => {
      if (fail) throw new HttpError('capability_error', 'boom', 'internal');
      return { items: [rejection()] };
    });
    show(http);
    const banner = await screen.findByTestId('skill-rejected-drafts-error');
    expect(banner.textContent).toContain('无法读取被拒绝的草稿');
    fail = false;
    fireEvent.click(within(banner).getByRole('button', { name: /重试/ }));
    expect(await screen.findByTestId('skill-rejected-drafts-item')).toBeTruthy();
    expect(screen.queryByTestId('skill-rejected-drafts-error')).toBeNull();
  });

  it('a new reloadKey reads again', async () => {
    let items: DraftRejectionWire[] = [];
    const http = scriptedHttp(() => ({ items }));
    const view = show(http);
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_draft_rejections')).toHaveLength(1),
    );
    items = [rejection()];
    view.rerender(
      <PermissionsProvider>
        <RejectedDrafts http={http} kind="skill" reloadKey={1} />
      </PermissionsProvider>,
    );
    expect(await screen.findByTestId('skill-rejected-drafts-item')).toBeTruthy();
    expect(http.calls.filter((c) => c.name === 'list_draft_rejections')).toHaveLength(2);
  });
});
