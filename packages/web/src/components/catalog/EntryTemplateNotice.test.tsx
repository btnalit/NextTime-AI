// @vitest-environment jsdom
import type { EntryTemplateStatusWire, EntryTemplateUpgradeWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { Resource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { EntryTemplateNotice, EntryTemplateSummary } from './EntryTemplateNotice.js';

afterEach(cleanup);

const ENTRY = '33333333-3333-4333-8333-333333333333';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const row = {
  id: ENTRY,
  version: 2,
  definition: {
    systemPrompt: 'You are the entry agent.\nAnswer briefly.',
    capabilities: ['search', 'invoke_worker'],
    model: 'anthropic/x',
  },
};

function statusOf(patch: Partial<EntryTemplateStatusWire> = {}): EntryTemplateStatusWire {
  return {
    template: {
      digest: DIGEST,
      systemPrompt:
        'You are the entry agent.\nGoals: propose one when work must keep going.\nAnswer briefly.',
      capabilities: ['search', 'invoke_worker', 'propose_goal'],
    },
    current: { definitionId: ENTRY, version: 2, digest: `sha256:${'b'.repeat(64)}` },
    differs: ['systemPrompt', 'capabilities'],
    ...patch,
  };
}

function ready(data: EntryTemplateStatusWire | null): Resource<EntryTemplateStatusWire | null> {
  return {
    state: { status: 'ready', data, refreshing: false, refreshError: null },
    reload: vi.fn(async () => undefined),
    mutate: () => undefined,
  };
}

const upgrade = (created: boolean): EntryTemplateUpgradeWire => ({
  draft: {
    id: ENTRY,
    version: 3,
    kind: 'entry',
    status: 'draft',
    definition: {},
    proposedBy: 'p-owner',
    publishedBy: null,
    createdAt: '2026-10-23T08:00:00.000Z',
    publishedAt: null,
  },
  templateDigest: DIGEST,
  basedOn: { definitionId: ENTRY, version: 2 },
  differs: ['systemPrompt', 'capabilities'],
  created,
});

/** A caller that answers `get_workspace` with the reader's role and `propose` with `onPropose`. */
function caller(
  role: 'owner' | 'builder' | 'member',
  onPropose: (params: unknown) => Promise<unknown> = async () => upgrade(true),
): CapabilityCaller & { readonly calls: { name: string; params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: async <T,>(name: string, params?: unknown) => {
      calls.push({ name, params });
      if (name === 'get_workspace') {
        return {
          id: 'ws-1',
          name: 'Acme',
          createdAt: '2026-01-01T00:00:00Z',
          principalCount: 1,
          gatekeeperCount: 0,
          caller: { id: 'p-1', role, displayName: 'Reader', kind: 'human' },
        } as T;
      }
      if (name === 'propose_entry_template_upgrade') return (await onPropose(params)) as T;
      throw new Error(`unscripted capability ${name}`);
    },
  };
}

function inPermissions(node: ReactNode) {
  return render(<PermissionsProvider>{node}</PermissionsProvider>);
}

describe('EntryTemplateNotice (legacy 145)', () => {
  it('says what differs, shows the difference, and proposes the draft against what it showed', async () => {
    const http = caller('builder');
    const onProposed = vi.fn();
    inPermissions(
      <EntryTemplateNotice
        http={http}
        status={ready(statusOf())}
        row={row}
        onProposed={onProposed}
      />,
    );
    const notice = screen.getByTestId('entry-template-notice');
    expect(notice.textContent).toMatch(
      /当前生效的 v2 与这个平台版本自带的入口模板不同：系统提示词、能力/,
    );
    expect(notice.textContent).toMatch(/新草稿会用平台模板替换这些改动/);
    const diff = screen.getByTestId('entry-template-prompt-diff');
    const added = [...diff.querySelectorAll('[data-change="added"]')].map((el) => el.textContent);
    expect(added).toEqual(['+ Goals: propose one when work must keep going.']);
    expect(diff.querySelectorAll('[data-change="removed"]')).toHaveLength(0);
    expect(screen.getByTestId('entry-template-capability-diff').textContent).toMatch(
      /模板新增的能力：propose_goal/,
    );

    fireEvent.click(await screen.findByTestId('entry-template-propose'));
    await waitFor(() => expect(onProposed).toHaveBeenCalledWith(upgrade(true)));
    expect(http.calls.filter((c) => c.name !== 'get_workspace')).toEqual([
      {
        name: 'propose_entry_template_upgrade',
        params: { templateDigest: DIGEST, basedOn: { definitionId: ENTRY, version: 2 } },
      },
    ]);
  });

  it('reads the status again when what it showed moved, and says so where the button is', async () => {
    const status = ready(statusOf());
    const http = caller('owner', async () => {
      throw new HttpError('capability_error', 'changed', 'entry_template_changed');
    });
    inPermissions(
      <EntryTemplateNotice http={http} status={status} row={row} onProposed={vi.fn()} />,
    );
    fireEvent.click(await screen.findByTestId('entry-template-propose'));
    const error = await screen.findByTestId('entry-template-propose-error');
    expect(error.textContent).toMatch(/平台模板或当前生效的入口版本变了/);
    expect(status.reload).toHaveBeenCalled();
  });

  it('says it matches when nothing differs, and says nothing on a version not in use', () => {
    const { unmount } = inPermissions(
      <EntryTemplateNotice
        http={caller('owner')}
        status={ready(statusOf({ differs: [] }))}
        row={row}
        onProposed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('entry-template-current').textContent).toMatch(/一致/);
    unmount();
    inPermissions(
      <EntryTemplateNotice
        http={caller('owner')}
        status={ready(statusOf())}
        row={{ ...row, version: 1 }}
        onProposed={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('entry-template-notice')).toBeNull();
    expect(screen.queryByTestId('entry-template-current')).toBeNull();
  });

  it('without the role to propose, says who can', async () => {
    inPermissions(
      <EntryTemplateNotice
        http={caller('member')}
        status={ready(statusOf())}
        row={row}
        onProposed={vi.fn()}
      />,
    );
    expect((await screen.findByTestId('entry-template-propose-role')).textContent).toMatch(
      /构建者或所有者/,
    );
    expect(screen.queryByTestId('entry-template-propose')).toBeNull();
  });
});

describe('EntryTemplateSummary (legacy 145)', () => {
  it('shows under the entry definition only when the template differs, and opens the version in use', () => {
    const onOpen = vi.fn();
    const { unmount } = render(<EntryTemplateSummary status={ready(statusOf())} onOpen={onOpen} />);
    const summary = screen.getByTestId('entry-template-summary');
    expect(summary.textContent).toMatch(
      /当前生效的入口定义 v2 的系统提示词、能力与这个平台版本自带的入口模板不同/,
    );
    fireEvent.click(within(summary).getByTestId('entry-template-summary-open'));
    expect(onOpen).toHaveBeenCalledWith({ id: ENTRY, version: 2 });
    unmount();
    render(<EntryTemplateSummary status={ready(statusOf({ differs: [] }))} onOpen={onOpen} />);
    expect(screen.queryByTestId('entry-template-summary')).toBeNull();
    cleanup();
    render(<EntryTemplateSummary status={ready(null)} onOpen={onOpen} />);
    expect(screen.queryByTestId('entry-template-summary')).toBeNull();
  });
});
