// @vitest-environment jsdom
import type { HandleWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import { HandlesList, type HandlesScope, distinctShortIds } from './HandlesList.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem('nexttime.lang');
});

function handle(patch: Partial<HandleWire> = {}): HandleWire {
  return {
    jti: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-mcp',
    sessionShortId: 'sessionm',
    sessionNote: null,
    sessionKind: 'mcp_session',
    holder: 'bearer',
    onBehalfOf: 'p-owner',
    onBehalfOfKind: 'human',
    onBehalfOfName: 'Alice',
    issuedAt: '2026-11-19T00:00:00.000Z',
    expiresAt: '2026-11-26T00:00:00.000Z',
    capabilities: ['list_tasks', 'get_task'],
    revocable: true,
    ...patch,
  };
}

type Answer = (name: string, params: Record<string, unknown>) => unknown;

/** Answers `get_workspace` with the reader's role (the revoke button follows it) and records
 *  every other call. */
function scriptedHttp(answer: Answer, role = 'owner') {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  const http: CapabilityCaller = {
    call: vi.fn(async (name: string, params?: unknown) => {
      if (name === 'get_workspace') {
        return {
          id: 'ws-1',
          name: 'Acme',
          createdAt: '2026-01-01T00:00:00Z',
          principalCount: 2,
          gatekeeperCount: 0,
          caller: { id: 'p-owner', role, displayName: 'Alice', kind: 'human' },
        };
      }
      const asked = (params ?? {}) as Record<string, unknown>;
      calls.push({ name, params: asked });
      return answer(name, asked);
    }) as CapabilityCaller['call'],
  };
  return { http, calls };
}

function show(
  http: CapabilityCaller,
  scope: HandlesScope = 'self',
  { lang = 'zh-CN', revision = 0 }: { lang?: 'zh-CN' | 'en'; revision?: number } = {},
) {
  localStorage.setItem('nexttime.lang', lang);
  return render(
    <LangProvider>
      <HandlesList http={http} scope={scope} revision={revision} />
    </LangProvider>,
  );
}

const ENTRY = handle({
  jti: '22222222-2222-4222-8222-222222222222',
  sessionId: 'session-entry',
  sessionKind: 'entry',
  holder: 'container',
  revocable: false,
});
const MCP_A = handle();
const MCP_B = handle({
  jti: '33333333-3333-4333-8333-333333333333',
  issuedAt: '2026-11-18T00:00:00.000Z',
  expiresAt: '2026-11-27T00:00:00.000Z',
  capabilities: ['get_task', 'search_facts'],
});
const SERVICE = handle({
  jti: '44444444-4444-4444-8444-444444444444',
  sessionId: 'session-service',
  sessionKind: 'service',
  onBehalfOf: 'p-ci',
  onBehalfOfKind: 'service',
  onBehalfOfName: 'ci-bot',
});

/** Legacy 168, console half: the Handles acting for the reader, or for service accounts. */
describe('HandlesList', () => {
  it('lists the reader’s own Handles by session: how each is held, when, what it may call; never a service account’s', async () => {
    const { http, calls } = scriptedHttp(() => ({ items: [ENTRY, MCP_A, MCP_B, SERVICE] }));
    show(http);
    const mcp = await screen.findByTestId('handle-session-session-mcp');
    expect(calls).toEqual([{ name: 'list_handles', params: {} }]);
    expect(mcp.textContent).toContain('平台外客户端（MCP）');
    expect(within(mcp).getByTestId('handle-session-holder-session-mcp').textContent).toBe(
      '客户端持有',
    );
    // One session, two Handles: the earliest issue, the latest expiry, both counted.
    expect(mcp.textContent).toContain('2 个凭证');
    const times = [...mcp.querySelectorAll('time')].map((el) => el.getAttribute('dateTime'));
    expect(times).toEqual(['2026-11-18T00:00:00.000Z', '2026-11-27T00:00:00.000Z']);
    // What the session may call, each capability once.
    expect(mcp.querySelector('summary')?.textContent).toBe('能调用 3 项能力');

    const entry = screen.getByTestId('handle-session-session-entry');
    expect(entry.textContent).toContain('入口智能体（对话）');
    expect(entry.textContent).toContain('平台持有');
    expect(screen.getByTestId('handle-session-ends-session-entry').textContent).toContain(
      '随它的对话或任务结束',
    );
    expect(within(entry).queryByRole('button', { name: '撤销' })).toBeNull();
    expect(screen.queryByTestId('handle-session-session-service')).toBeNull();
    expect(screen.getByTestId('handles-self').textContent).not.toContain('eyJ');
  });

  it('for an owner’s service scope, lists only service accounts’ sessions, named', async () => {
    const { http } = scriptedHttp(() => ({ items: [ENTRY, MCP_A, SERVICE] }));
    show(http, 'service');
    const row = await screen.findByTestId('handle-session-session-service');
    expect(row.textContent).toContain('服务账号会话');
    expect(row.textContent).toContain(' · ci-bot');
    expect(screen.queryByTestId('handle-session-session-mcp')).toBeNull();
    expect(screen.queryByTestId('handle-session-session-entry')).toBeNull();
  });

  it('revokes a client’s session after the confirm says how many Handles end, and reads again', async () => {
    let revoked = false;
    const { http, calls } = scriptedHttp((name) => {
      if (name === 'revoke_handle') {
        revoked = true;
        return {
          jti: MCP_A.jti,
          sessionId: 'session-mcp',
          sessionKind: 'mcp_session',
          revokedHandleCount: 2,
        };
      }
      return { items: revoked ? [ENTRY] : [ENTRY, MCP_A, MCP_B] };
    });
    show(http);
    fireEvent.click(await screen.findByTestId('handle-session-revoke-session-mcp'));
    const confirm = await screen.findByTestId('handle-session-revoke-confirm-session-mcp');
    expect(confirm.textContent).toContain('会话下的 2 个凭证立即失效');
    expect(confirm.textContent).toContain('要再用需要重新签发');
    fireEvent.click(within(confirm).getByRole('button', { name: '撤销' }));
    const done = await screen.findByTestId('handles-self-revoked');
    expect(done.tagName).toBe('OUTPUT');
    expect(done.textContent).toContain('2 个凭证已失效');
    expect(done.textContent).toContain('用它们的客户端');
    // The row and its button are gone: focus lands on the line saying what happened.
    await waitFor(() => expect(document.activeElement).toBe(done));
    await waitFor(() => expect(screen.queryByTestId('handle-session-session-mcp')).toBeNull());
    expect(calls.filter((call) => call.name === 'revoke_handle')).toEqual([
      { name: 'revoke_handle', params: { jti: MCP_A.jti } },
    ]);
    expect(calls.filter((call) => call.name === 'list_handles')).toHaveLength(2);
  });

  it('revoking a service account’s session names the account and says its automation stops', async () => {
    let revoked = false;
    const { http } = scriptedHttp((name) => {
      if (name === 'revoke_handle') {
        revoked = true;
        return {
          jti: SERVICE.jti,
          sessionId: 'session-service',
          sessionKind: 'service',
          revokedHandleCount: 1,
        };
      }
      return { items: revoked ? [] : [SERVICE] };
    });
    show(http, 'service');
    fireEvent.click(await screen.findByTestId('handle-session-revoke-session-service'));
    const confirm = await screen.findByTestId('handle-session-revoke-confirm-session-service');
    expect(confirm.textContent).toContain('撤销服务账号 ci-bot 的会话');
    expect(confirm.textContent).toContain('这个凭证立即失效');
    expect(confirm.textContent).toContain('用这个凭证的自动化（如采集器、脚本）立即被拒绝');
    expect(confirm.textContent).not.toContain('Claude Code');
    fireEvent.click(within(confirm).getByRole('button', { name: '撤销' }));
    const done = await screen.findByTestId('handles-service-revoked');
    expect(done.textContent).toBe(
      '已撤销：这个服务账号会话的凭证已失效，用它的自动化会被拒绝，要再用需要重新签发并换上新凭证。',
    );
  });

  it('a session already gone when revoked just reads the list again', async () => {
    let gone = false;
    const { http } = scriptedHttp((name) => {
      if (name === 'revoke_handle') {
        gone = true;
        throw new HttpError('capability_error', 'no such handle', 'handle_not_found');
      }
      return { items: gone ? [] : [MCP_A] };
    });
    show(http);
    fireEvent.click(await screen.findByTestId('handle-session-revoke-session-mcp'));
    const confirm = await screen.findByTestId('handle-session-revoke-confirm-session-mcp');
    fireEvent.click(within(confirm).getByRole('button', { name: '撤销' }));
    expect((await screen.findByTestId('handles-self-empty')).textContent).toBe(
      '现在没有代表你的会话凭证。',
    );
  });

  it('reads again when the page issued a Handle, pages with 加载更多, and says when none is live', async () => {
    const { http, calls } = scriptedHttp((_, params) =>
      params.cursor === 'c1' ? { items: [MCP_B] } : { items: [MCP_A], nextCursor: 'c1' },
    );
    const { rerender } = show(http);
    fireEvent.click(await screen.findByTestId('handles-self-more'));
    await waitFor(() => expect(screen.queryByTestId('handles-self-more')).toBeNull());
    expect(screen.getByTestId('handle-session-session-mcp').textContent).toContain('2 个凭证');
    rerender(
      <LangProvider>
        <HandlesList http={http} scope="self" revision={1} />
      </LangProvider>,
    );
    await waitFor(() =>
      expect(calls.filter((call) => call.name === 'list_handles').length).toBeGreaterThan(2),
    );
    cleanup();
    show(scriptedHttp(() => ({ items: [] })).http, 'service');
    expect((await screen.findByTestId('handles-service-empty')).textContent).toBe(
      '服务账号现在没有有效的会话凭证。',
    );
  });

  it('an auditor sees the sessions but no 撤销: the role can only look', async () => {
    const { http, calls } = scriptedHttp(() => ({ items: [MCP_A] }), 'auditor');
    show(http);
    const ends = await screen.findByTestId('handle-session-ends-session-mcp');
    await waitFor(() =>
      expect(ends.textContent).toContain('请平台管理员在「集成 → 外部运行时」里吊销'),
    );
    expect(screen.queryByTestId('handle-session-revoke-session-mcp')).toBeNull();
    expect(calls.map((call) => call.name)).toEqual(['list_handles']);
  });

  it('a first page holding only the other kind says to read on, not that there is none', async () => {
    const { http } = scriptedHttp(() => ({ items: [SERVICE], nextCursor: 'c1' }));
    show(http);
    expect((await screen.findByTestId('handles-self-empty')).textContent).toBe(
      '已读到的会话凭证里还没有这一类的，点「加载更多」接着读。',
    );
    expect(screen.getByTestId('handles-self-more')).toBeTruthy();
  });

  it('legacy 902: names each session by its short id and note, in the row and in the revoke confirm', async () => {
    const noted = handle({
      jti: '55555555-5555-4555-8555-555555555555',
      sessionId: '0f3a9c21-7b4e-4d6a-9e10-5c2b8a7d6e4f',
      sessionShortId: '0f3a9c21',
      sessionNote: '笔记本上的客户端',
    });
    const { http } = scriptedHttp(() => ({ items: [ENTRY, noted] }));
    show(http);
    const rowId = noted.sessionId;
    const row = await screen.findByTestId(`handle-session-${rowId}`);
    expect(within(row).getByTestId(`handle-session-short-${rowId}`).textContent).toBe(
      '会话 0f3a9c21',
    );
    expect(within(row).getByTestId(`handle-session-note-${rowId}`).textContent).toBe(
      '备注：笔记本上的客户端',
    );
    // A session no person issued has no note line.
    expect(screen.queryByTestId('handle-session-note-session-entry')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: '撤销' }));
    const confirm = await screen.findByTestId(`handle-session-revoke-confirm-${rowId}`);
    expect(confirm.textContent).toContain('撤销平台外客户端（MCP）的会话 0f3a9c21');
    expect(confirm.textContent).toContain('备注：笔记本上的客户端');
  });

  it('legacy 902: two listed sessions sharing a short id each show more of their id, until they differ', async () => {
    const first = handle({
      jti: '66666666-6666-4666-8666-666666666666',
      sessionId: '0f3a9c21-7b4e-4d6a-9e10-5c2b8a7d6e4f',
      sessionShortId: '0f3a9c21',
    });
    const second = handle({
      jti: '77777777-7777-4777-8777-777777777777',
      sessionId: '0f3a9c21-7b9f-4d6a-9e10-5c2b8a7d6e4f',
      sessionShortId: '0f3a9c21',
    });
    const { http } = scriptedHttp(() => ({ items: [first, second, ENTRY] }));
    show(http);
    expect((await screen.findByTestId(`handle-session-short-${first.sessionId}`)).textContent).toBe(
      '会话 0f3a9c217b4',
    );
    expect(screen.getByTestId(`handle-session-short-${second.sessionId}`).textContent).toBe(
      '会话 0f3a9c217b9',
    );
    expect(screen.getByTestId('handle-session-short-session-entry').textContent).toContain(
      ENTRY.sessionShortId,
    );
  });

  it('distinctShortIds keeps a unique short id and lengthens only the ones that collide', () => {
    const shown = distinctShortIds([
      { sessionId: 'AAAAAAAA-1111-4000-8000-000000000000', sessionShortId: 'aaaaaaaa' },
      { sessionId: 'aaaaaaaa-1112-4000-8000-000000000000', sessionShortId: 'aaaaaaaa' },
      { sessionId: 'aaaaaaaa-2000-4000-8000-000000000000', sessionShortId: 'aaaaaaaa' },
      { sessionId: 'bbbbbbbb-0000-4000-8000-000000000000', sessionShortId: 'bbbbbbbb' },
    ]);
    expect(shown.get('AAAAAAAA-1111-4000-8000-000000000000')).toBe('aaaaaaaa1111');
    expect(shown.get('aaaaaaaa-1112-4000-8000-000000000000')).toBe('aaaaaaaa1112');
    expect(shown.get('aaaaaaaa-2000-4000-8000-000000000000')).toBe('aaaaaaaa2');
    expect(shown.get('bbbbbbbb-0000-4000-8000-000000000000')).toBe('bbbbbbbb');
  });

  it('reads in English', async () => {
    const { http } = scriptedHttp(() => ({ items: [ENTRY, MCP_A] }));
    show(http, 'self', { lang: 'en' });
    const mcp = await screen.findByTestId('handle-session-session-mcp');
    expect(mcp.textContent).toContain('Client outside the platform (MCP)');
    expect(mcp.textContent).toContain('Held by a client');
    expect(within(mcp).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    fireEvent.click(within(mcp).getByRole('button', { name: 'Revoke' }));
    expect(
      (await screen.findByTestId('handle-session-revoke-confirm-session-mcp')).textContent,
    ).toContain('Revoke session sessionm: client outside the platform (MCP)');
    expect(screen.getByTestId('handle-session-ends-session-entry').textContent).toContain(
      'ends with its chat or Task',
    );
  });
});
