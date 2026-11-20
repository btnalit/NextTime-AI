// @vitest-environment jsdom
import type { HandleWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import { HandlesList, type HandlesScope } from './HandlesList.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem('nexttime.lang');
});

function handle(patch: Partial<HandleWire> = {}): HandleWire {
  return {
    jti: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-mcp',
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
    await waitFor(() => expect(screen.queryByTestId('handle-session-session-mcp')).toBeNull());
    expect(calls.filter((call) => call.name === 'revoke_handle')).toEqual([
      { name: 'revoke_handle', params: { jti: MCP_A.jti } },
    ]);
    expect(calls.filter((call) => call.name === 'list_handles')).toHaveLength(2);
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
    await waitFor(() => expect(ends.textContent).toContain('你的角色只能查看，不能撤销'));
    expect(screen.queryByTestId('handle-session-revoke-session-mcp')).toBeNull();
    expect(calls.map((call) => call.name)).toEqual(['list_handles']);
  });

  it('reads in English', async () => {
    const { http } = scriptedHttp(() => ({ items: [ENTRY, MCP_A] }));
    show(http, 'self', { lang: 'en' });
    const mcp = await screen.findByTestId('handle-session-session-mcp');
    expect(mcp.textContent).toContain('Client outside the platform (MCP)');
    expect(mcp.textContent).toContain('Held by a client');
    expect(within(mcp).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(screen.getByTestId('handle-session-ends-session-entry').textContent).toContain(
      'ends with its chat or Task',
    );
  });
});
