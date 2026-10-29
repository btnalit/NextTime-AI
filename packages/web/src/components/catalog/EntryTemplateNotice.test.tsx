// @vitest-environment jsdom
import type { EntryTemplateStatusWire, EntryTemplateUpgradeWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { Resource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import {
  EntryDraftChanges,
  EntryTemplateNotice,
  EntryTemplateSummary,
} from './EntryTemplateNotice.js';

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
    expect(notice.textContent).toMatch(
      /如果在这里改过系统提示词、能力，新草稿会用平台模板替换这些改动/,
    );
    // UX acceptance of #747 (P2-1): the capabilities first, outside the folded prompt difference,
    // each by what it does with its registry name beside it.
    const capabilities = screen.getByTestId('entry-template-capability-diff');
    const promptDiff = screen.getByTestId('entry-template-diff');
    expect(promptDiff.tagName).toBe('DETAILS');
    expect(promptDiff.contains(capabilities)).toBe(false);
    expect(
      capabilities.compareDocumentPosition(promptDiff) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(capabilities.textContent).toMatch(/入口 agent 能做的事与 v2 相比/);
    const added = within(capabilities).getByTestId('capability-changes-added');
    expect(added.textContent).toMatch(/新增 1 项能力/);
    const goal = added.querySelector('[data-capability="propose_goal"]');
    expect(goal?.textContent).toMatch(/^\+ 提议目标 propose_goal/);
    expect(goal?.textContent).toMatch(/你在控制台确认之前什么都不会执行/);
    expect(within(capabilities).queryByTestId('capability-changes-removed')).toBeNull();
    expect(within(promptDiff).getByText('查看系统提示词差异')).toBeTruthy();
    const diff = screen.getByTestId('entry-template-prompt-diff');
    const addedLines = [...diff.querySelectorAll('[data-change="added"]')].map(
      (el) => el.textContent,
    );
    expect(addedLines).toEqual(['+ Goals: propose one when work must keep going.']);
    expect(diff.querySelectorAll('[data-change="removed"]')).toHaveLength(0);

    fireEvent.click(await screen.findByTestId('entry-template-propose'));
    await waitFor(() => expect(onProposed).toHaveBeenCalledWith(upgrade(true)));
    expect(http.calls.filter((c) => c.name !== 'get_workspace')).toEqual([
      {
        name: 'propose_entry_template_upgrade',
        params: { templateDigest: DIGEST, basedOn: { definitionId: ENTRY, version: 2 } },
      },
    ]);
  });

  it('with only the capabilities different, lists them and folds no prompt difference', () => {
    inPermissions(
      <EntryTemplateNotice
        http={caller('owner')}
        status={ready(
          statusOf({
            template: { ...statusOf().template, systemPrompt: row.definition.systemPrompt },
            differs: ['capabilities'],
          }),
        )}
        row={{ ...row, definition: { ...row.definition, capabilities: ['search', 'own_tool'] } }}
        onProposed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('entry-template-notice').textContent).toMatch(
      /如果在这里改过能力，新草稿/,
    );
    expect(screen.queryByTestId('entry-template-diff')).toBeNull();
    const capabilities = screen.getByTestId('entry-template-capability-diff');
    const added = within(capabilities).getByTestId('capability-changes-added');
    expect(
      [...added.querySelectorAll('[data-capability]')].map((el) =>
        el.getAttribute('data-capability'),
      ),
    ).toEqual(['invoke_worker', 'propose_goal']);
    // A name the console has no words for shows as itself, once.
    const removed = within(capabilities).getByTestId('capability-changes-removed');
    expect(removed.textContent).toMatch(/去掉 1 项能力/);
    expect(removed.querySelector('[data-capability="own_tool"]')?.textContent).toBe('− own_tool');
  });

  it('opens a run of unchanged prompt lines in place (legacy 471)', () => {
    const own = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`);
    const template = [...own.slice(0, 3), 'new line', ...own.slice(3)];
    inPermissions(
      <EntryTemplateNotice
        http={caller('owner')}
        status={ready(
          statusOf({
            template: { ...statusOf().template, systemPrompt: template.join('\n') },
            differs: ['systemPrompt'],
          }),
        )}
        row={{ ...row, definition: { ...row.definition, systemPrompt: own.join('\n') } }}
        onProposed={vi.fn()}
      />,
    );
    const diff = screen.getByTestId('entry-template-prompt-diff');
    const sameLines = () =>
      [...diff.querySelectorAll('[data-change="same"]')].map((el) => el.textContent);
    expect(sameLines()).toEqual(['  line 2', '  line 3', '  line 4', '  line 5']);
    const gaps = within(diff).getAllByTestId('entry-template-prompt-diff-open-gap');
    expect(gaps.map((gap) => gap.textContent)).toEqual([
      '… 1 行未变，点开查看 …',
      '… 4 行未变，点开查看 …',
    ]);
    fireEvent.click(gaps[1] as HTMLElement);
    expect(within(diff).getAllByTestId('entry-template-prompt-diff-open-gap')).toHaveLength(1);
    expect(sameLines()).toEqual([
      '  line 2',
      '  line 3',
      '  line 4',
      '  line 5',
      '  line 6',
      '  line 7',
      '  line 8',
      '  line 9',
    ]);
    // Legacy 479: the button went away; focus is on the first line it opened, not the page.
    expect(document.activeElement?.textContent).toBe('  line 6');
    expect(document.activeElement?.getAttribute('data-opened')).toBe('');
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

describe('EntryDraftChanges (UX acceptance of #747, P2-1)', () => {
  const inUse = { version: 2, definition: row.definition };

  it('says, next to Publish, which capabilities the draft adds and takes out, and that the prompt differs', () => {
    render(
      <EntryDraftChanges
        draft={{
          definition: {
            ...row.definition,
            systemPrompt: 'You are the entry agent.\nGoals: propose one.\nAnswer briefly.',
            capabilities: ['search', 'propose_goal', 'list_goals'],
          },
        }}
        inUse={inUse}
      />,
    );
    const changes = screen.getByTestId('entry-draft-changes');
    expect(changes.textContent).toMatch(/与当前生效的 v2 相比/);
    const added = within(changes).getByTestId('capability-changes-added');
    expect(added.textContent).toMatch(/新增 2 项能力/);
    expect(added.textContent).toMatch(/提议目标 propose_goal/);
    expect(added.textContent).toMatch(/查看目标列表 list_goals/);
    const removed = within(changes).getByTestId('capability-changes-removed');
    expect(removed.textContent).toMatch(/去掉 1 项能力/);
    expect(removed.querySelector('[data-capability="invoke_worker"]')).not.toBeNull();
    expect(within(changes).getByTestId('entry-draft-prompt-change').textContent).toMatch(
      /系统提示词有改动/,
    );
  });

  it('says when the capabilities and the prompt are the same', () => {
    render(<EntryDraftChanges draft={{ definition: { ...row.definition } }} inUse={inUse} />);
    expect(screen.getByTestId('entry-draft-capabilities-same').textContent).toBe('能力相同。');
    expect(screen.getByTestId('entry-draft-prompt-change').textContent).toBe('系统提示词相同。');
    expect(screen.queryByTestId('capability-changes-added')).toBeNull();
  });
});
