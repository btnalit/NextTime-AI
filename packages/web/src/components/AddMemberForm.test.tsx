// @vitest-environment jsdom
import type { UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { AddMemberForm } from './AddMemberForm.js';

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
  it('not a platform administrator: the login is typed, normalized like the kernel does, and validated', async () => {
    const http = scriptedHttp({ list_users: forbidden, add_member: () => added });
    const { onDone } = renderForm(http);
    await waitFor(() => expect(http.calls.some((call) => call.name === 'list_users')).toBe(true));

    const login = screen.getByLabelText(/登录名/) as HTMLInputElement;
    fireEvent.change(login, { target: { value: ' Bob ' } });
    expect(screen.getByText(/将保存为 bob/)).toBeTruthy();
    fireEvent.blur(login);
    expect(login.value).toBe('bob');
    // The directory stays out of sight for a non-administrator.
    expect(screen.queryByTestId('add-member-pick-instead')).toBeNull();
    expect(screen.queryByTestId('add-member-directory-error')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(addParams(http)).toEqual({ login: 'bob', role: 'member' });
  });

  it('an invalid login names the problem and keeps Add disabled', () => {
    const http = scriptedHttp({ list_users: forbidden });
    renderForm(http);
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
    const picker = (await screen.findByTestId('add-member-user')) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(3));
    expect([...picker.options].map((option) => option.textContent)).toContain('bob — Bob');
    expect(screen.queryByLabelText(/^登录名/)).toBeNull();

    const add = screen.getByRole('button', { name: '添加' });
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.change(picker, { target: { value: 'u-3' } });
    fireEvent.change(screen.getByLabelText(/^角色/), { target: { value: 'operator' } });
    fireEvent.click(add);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(addParams(http)).toEqual({ login: 'carol', role: 'operator' });
  });

  it('platformAdmin: the directory opens at once; "改为手动输入" carries the picked login over', async () => {
    const http = scriptedHttp({ list_users: () => ({ items: [user()] }), add_member: () => added });
    renderForm(http, true);
    const picker = screen.getByTestId('add-member-user') as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(2));
    fireEvent.change(picker, { target: { value: 'u-2' } });
    fireEvent.click(screen.getByTestId('add-member-type-instead'));
    expect((screen.getByLabelText(/登录名/) as HTMLInputElement).value).toBe('bob');
    // …and back.
    fireEvent.click(screen.getByTestId('add-member-pick-instead'));
    expect(screen.getByTestId('add-member-user')).toBeTruthy();
  });

  it('platformAdmin={false}: never reads the directory', async () => {
    const http = scriptedHttp({ add_member: () => added });
    renderForm(http, false);
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
});
