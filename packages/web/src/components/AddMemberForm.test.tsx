// @vitest-environment jsdom
import type { UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { AddMemberForm } from './AddMemberForm.js';
import {
  comboboxOptionTexts,
  findComboboxOption,
  openCombobox,
  pickComboboxOption,
} from './kit/combobox.test-helpers.js';

afterEach(cleanup);

type Handlers = Record<string, (params: unknown) => unknown | Promise<unknown>>;

function scriptedHttp(
  handlers: Handlers,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function user(overrides: Partial<UserWire> = {}): UserWire {
  return {
    id: 'u-2',
    login: 'bob',
    displayName: 'Bob',
    platformRole: 'user',
    status: 'active',
    hasPassword: true,
    mustChangePassword: false,
    dailyCallLimit: null,
    monthlyTokenBudget: null,
    lastLoginAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    memberships: [],
    ...overrides,
  };
}

const forbidden = () => {
  throw new HttpError('capability_error', 'requires a platform administrator', 'forbidden');
};

const added = { id: 'p-9', role: 'member', displayName: 'Bob' };

function renderForm(http: CapabilityCaller, platformAdmin?: boolean) {
  const onDone = vi.fn();
  const utils = render(
    <PermissionsProvider>
      <AddMemberForm
        http={http}
        onDone={onDone}
        onCancel={vi.fn()}
        {...(platformAdmin === undefined ? {} : { platformAdmin })}
      />
    </PermissionsProvider>,
  );
  return { ...utils, onDone };
}

function addParams(http: ReturnType<typeof scriptedHttp>): unknown {
  return http.calls.find((call) => call.name === 'add_member')?.params;
}

describe('AddMemberForm', () => {
  it('not a platform administrator, typing instead: the login is normalized like the kernel does, and validated', async () => {
    const http = scriptedHttp({ list_users: forbidden, add_member: () => added });
    const { onDone } = renderForm(http);
    await waitFor(() => expect(http.calls.some((call) => call.name === 'list_users')).toBe(true));
    fireEvent.click(screen.getByTestId('add-member-type-instead'));

    const login = screen.getByLabelText(/登录名/) as HTMLInputElement;
    fireEvent.change(login, { target: { value: ' Bob ' } });
    expect(screen.getByText(/将保存为 bob/)).toBeTruthy();
    fireEvent.blur(login);
    expect(login.value).toBe('bob');
    // The directory stays out of sight for a non-administrator; the search is one click back.
    expect(screen.queryByTestId('add-member-pick-instead')).toBeNull();
    expect(screen.queryByTestId('add-member-directory-error')).toBeNull();
    expect(screen.getByTestId('add-member-lookup-instead')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(addParams(http)).toEqual({ login: 'bob', role: 'member' });
  });

  it('an invalid login names the problem and keeps Add disabled', () => {
    const http = scriptedHttp({ list_users: forbidden });
    renderForm(http, false);
    fireEvent.click(screen.getByTestId('add-member-type-instead'));
    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'a b' } });
    expect(screen.getByRole('alert').textContent).toMatch(/不能包含「 」/);
    expect(screen.getByRole('button', { name: '添加' }).hasAttribute('disabled')).toBe(true);
  });

  it('a platform administrator gets the user directory: search, pick, and the picked login is sent', async () => {
    const http = scriptedHttp({
      list_users: () => ({
        items: [user(), user({ id: 'u-3', login: 'carol', displayName: 'Carol' })],
      }),
      add_member: () => added,
    });
    const { onDone } = renderForm(http);
    const picker = await screen.findByTestId('add-member-user');
    await findComboboxOption(picker, 'carol — Carol');
    expect(comboboxOptionTexts(picker)).toEqual(['bob — Bob', 'carol — Carol']);
    expect(screen.queryByLabelText(/^登录名/)).toBeNull();

    const add = screen.getByRole('button', { name: '添加' });
    expect(add.hasAttribute('disabled')).toBe(true);
    await pickComboboxOption(picker, 'carol — Carol');
    fireEvent.change(screen.getByLabelText(/^角色/), { target: { value: 'operator' } });
    fireEvent.click(add);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(addParams(http)).toEqual({ login: 'carol', role: 'operator' });
  });

  it('legacy 153 ⑤: a user who is already a member of this workspace is listed but cannot be picked', async () => {
    const http = scriptedHttp({
      list_users: () => ({
        items: [
          user({
            id: 'u-1',
            login: 'admin',
            displayName: 'Admin',
            memberships: [
              {
                workspaceId: 'ws-1',
                workspaceName: 'Default',
                workspacePurpose: 'standard',
                workspaceStatus: 'active',
                principalId: 'p-1',
                role: 'owner',
                disabled: false,
              },
            ],
          }),
          user(),
        ],
      }),
      add_member: () => added,
    });
    render(
      <PermissionsProvider>
        <AddMemberForm
          http={http}
          onDone={vi.fn()}
          onCancel={vi.fn()}
          platformAdmin
          workspaceId="ws-1"
        />
      </PermissionsProvider>,
    );
    const picker = screen.getByTestId('add-member-user');
    const member = await findComboboxOption(picker, 'admin — Admin');
    expect(member.getAttribute('aria-disabled')).toBe('true');
    expect(member.textContent).toContain('已是本工作区成员');
    fireEvent.click(member);
    expect(screen.getByRole('button', { name: '添加' }).hasAttribute('disabled')).toBe(true);
    await pickComboboxOption(picker, 'bob — Bob');
    expect(screen.getByRole('button', { name: '添加' }).hasAttribute('disabled')).toBe(false);
  });

  // Legacy 725: `add_member` adds a person removed from this workspace back, as a new membership.
  it('legacy 725: a user removed from this workspace can be picked, and the form says what that adds', async () => {
    const removed = user({
      memberships: [
        {
          workspaceId: 'ws-1',
          workspaceName: 'Default',
          workspacePurpose: 'standard',
          workspaceStatus: 'active',
          principalId: 'p-2',
          role: 'member',
          disabled: true,
        },
      ],
    });
    const carol = user({ id: 'u-3', login: 'carol', displayName: 'Carol' });
    const http = scriptedHttp({
      list_users: () => ({ items: [removed, carol] }),
      add_member: () => added,
    });
    const onDone = vi.fn();
    render(
      <PermissionsProvider>
        <AddMemberForm
          http={http}
          onDone={onDone}
          onCancel={vi.fn()}
          platformAdmin
          workspaceId="ws-1"
        />
      </PermissionsProvider>,
    );
    const picker = screen.getByTestId('add-member-user');
    const option = await findComboboxOption(picker, 'bob — Bob');
    expect(option.getAttribute('aria-disabled')).not.toBe('true');
    expect(option.textContent).toContain('曾被移出本工作区');
    await pickComboboxOption(picker, 'carol — Carol');
    expect(screen.queryByTestId('add-member-readd')).toBeNull();
    await pickComboboxOption(picker, 'bob — Bob');
    expect(screen.getByTestId('add-member-readd').textContent).toBe(
      `这个人曾被移出本工作区。添加会新建一条成员资格，原来那条留着供审计溯源；这个人看不到移出前的${'草稿和目标'}。`,
    );
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(addParams(http)).toEqual({ login: 'bob', role: 'member' });
  });

  it('platformAdmin: the directory opens at once; "改为手动输入" carries the picked login over', async () => {
    const http = scriptedHttp({ list_users: () => ({ items: [user()] }), add_member: () => added });
    renderForm(http, true);
    await pickComboboxOption(screen.getByTestId('add-member-user'), 'bob — Bob');
    fireEvent.click(screen.getByTestId('add-member-type-instead'));
    expect((screen.getByLabelText(/登录名/) as HTMLInputElement).value).toBe('bob');
    // …and back.
    fireEvent.click(screen.getByTestId('add-member-pick-instead'));
    expect(screen.getByTestId('add-member-user')).toBeTruthy();
  });

  it('platformAdmin={false}: never reads the directory, and types a login when asked to', async () => {
    const http = scriptedHttp({ add_member: () => added });
    renderForm(http, false);
    fireEvent.click(screen.getByTestId('add-member-type-instead'));
    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'dana' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(addParams(http)).toEqual({ login: 'dana', role: 'member' }));
    expect(http.calls.some((call) => call.name === 'list_users')).toBe(false);
  });

  it('a reader who started typing before the directory answered keeps the text box, with a way to switch', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const http = scriptedHttp({
      list_users: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    renderForm(http);
    fireEvent.click(screen.getByTestId('add-member-type-instead'));
    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'dana' } });
    answer({ items: [user()] });
    expect(await screen.findByTestId('add-member-pick-instead')).toBeTruthy();
    expect((screen.getByLabelText(/登录名/) as HTMLInputElement).value).toBe('dana');
  });

  it('a directory read that fails for another reason says so, with a retry, while typing still works', async () => {
    let attempts = 0;
    const http = scriptedHttp({
      list_users: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        return { items: [user()] };
      },
    });
    renderForm(http);
    // The form opens on the owner's search; the directory's failure is said where it is offered.
    expect(screen.getByTestId('add-member-lookup')).toBeTruthy();
    fireEvent.click(screen.getByTestId('add-member-type-instead'));
    const banner = await screen.findByTestId('add-member-directory-error');
    expect(screen.getByLabelText(/登录名/)).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: /重试/ }));
    // Nothing typed yet, so a successful retry opens the directory.
    expect(await screen.findByTestId('add-member-user')).toBeTruthy();
    expect(screen.queryByTestId('add-member-directory-error')).toBeNull();
  });

  it('a 403 is remembered for the session: the next form does not ask again', async () => {
    const http = scriptedHttp({ list_users: forbidden });
    const { rerender } = render(
      <PermissionsProvider>
        <AddMemberForm key="first" http={http} onDone={vi.fn()} onCancel={vi.fn()} />
      </PermissionsProvider>,
    );
    await waitFor(() => expect(http.calls.filter((c) => c.name === 'list_users')).toHaveLength(1));
    rerender(
      <PermissionsProvider>
        <AddMemberForm key="second" http={http} onDone={vi.fn()} onCancel={vi.fn()} />
      </PermissionsProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(http.calls.filter((c) => c.name === 'list_users')).toHaveLength(1);
  });

  describe('legacy 150: an owner who is not a platform administrator searches with lookup_users', () => {
    const dana = { login: 'dana', displayName: 'Dana' };
    const danny = { login: 'danny', displayName: 'Danny Ho' };

    it('asks nothing under 2 characters, then lists the matches and sends the picked login', async () => {
      const http = scriptedHttp({
        lookup_users: () => ({ items: [dana, danny] }),
        add_member: () => added,
      });
      const { onDone } = renderForm(http, false);
      const lookup = screen.getByTestId('add-member-lookup');
      expect(screen.getByTestId('add-member-missing').textContent).toContain('选择用户');

      fireEvent.change(lookup, { target: { value: 'd' } });
      openCombobox(lookup);
      expect(screen.getByTestId('add-member-lookup-empty').textContent).toBe(
        '输入至少 2 个字符开始查找。',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(http.calls.some((call) => call.name === 'lookup_users')).toBe(false);

      fireEvent.change(lookup, { target: { value: ' Da ' } });
      await findComboboxOption(lookup, 'danny — Danny Ho');
      expect(comboboxOptionTexts(lookup)).toEqual(['dana — Dana', 'danny — Danny Ho']);
      expect(http.calls.find((call) => call.name === 'lookup_users')?.params).toEqual({
        query: 'Da',
      });

      await pickComboboxOption(lookup, 'danny — Danny Ho');
      expect((lookup as HTMLInputElement).value).toBe('danny — Danny Ho');
      fireEvent.click(screen.getByRole('button', { name: '添加' }));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(addParams(http)).toEqual({ login: 'danny', role: 'member' });
      expect(http.calls.some((call) => call.name === 'list_users')).toBe(false);
    });

    it('a cut-off answer says to type more; no match says who is left out', async () => {
      const http = scriptedHttp({
        lookup_users: (params) =>
          (params as { query: string }).query === 'da'
            ? { items: [dana, danny], truncated: true }
            : { items: [] },
      });
      renderForm(http, false);
      const lookup = screen.getByTestId('add-member-lookup');
      fireEvent.change(lookup, { target: { value: 'da' } });
      await findComboboxOption(lookup, 'dana — Dana');
      expect(screen.getByText('只列出最先匹配的 20 个，输入更多字符缩小范围。')).toBeTruthy();

      fireEvent.change(lookup, { target: { value: 'zz' } });
      await waitFor(() =>
        expect(screen.getByTestId('add-member-lookup-empty').textContent).toBe(
          '没有可以添加的匹配用户。已是本工作区成员的人和已停用的账户不会列出。',
        ),
      );
      expect(screen.queryByText(/只列出最先匹配/)).toBeNull();
    });

    it('"改为手动输入" carries the picked login over, and the search is one click back', async () => {
      const http = scriptedHttp({ lookup_users: () => ({ items: [dana] }) });
      renderForm(http, false);
      const lookup = screen.getByTestId('add-member-lookup');
      fireEvent.change(lookup, { target: { value: 'dan' } });
      await pickComboboxOption(lookup, 'dana — Dana');
      fireEvent.click(screen.getByTestId('add-member-type-instead'));
      expect((screen.getByLabelText(/登录名/) as HTMLInputElement).value).toBe('dana');
      fireEvent.click(screen.getByTestId('add-member-lookup-instead'));
      expect((screen.getByTestId('add-member-lookup') as HTMLInputElement).value).toBe(
        'dana — Dana',
      );
    });

    it('a failed search says so, with a retry', async () => {
      let attempts = 0;
      const http = scriptedHttp({
        lookup_users: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('network down');
          return { items: [dana] };
        },
      });
      renderForm(http, false);
      const lookup = screen.getByTestId('add-member-lookup');
      fireEvent.change(lookup, { target: { value: 'da' } });
      const banner = await screen.findByTestId('add-member-lookup-error');
      expect(banner.textContent).toContain('无法查找用户');
      fireEvent.click(within(banner).getByRole('button', { name: /重试/ }));
      await findComboboxOption(lookup, 'dana — Dana');
      expect(screen.queryByTestId('add-member-lookup-error')).toBeNull();
    });

    it('a pick made before the directory answered keeps the search', async () => {
      let answer: (value: unknown) => void = () => undefined;
      const http = scriptedHttp({
        list_users: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
        lookup_users: () => ({ items: [dana] }),
      });
      renderForm(http);
      const lookup = screen.getByTestId('add-member-lookup');
      fireEvent.change(lookup, { target: { value: 'da' } });
      await pickComboboxOption(lookup, 'dana — Dana');
      answer({ items: [user()] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByTestId('add-member-lookup')).toBeTruthy();
      expect(screen.queryByTestId('add-member-user')).toBeNull();
    });
  });
});
