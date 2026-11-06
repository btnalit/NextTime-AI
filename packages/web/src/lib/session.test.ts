// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearApiKey,
  loadApiKey,
  loadSelectedWorkspaceId,
  reloadIntoWorkspace,
  saveApiKey,
  saveSelectedWorkspaceId,
} from './session.js';

/**
 * session.test.ts: the sessionStorage-backed stores in lib/session.ts. jsdom's sessionStorage is
 * shared across tests in one file (not reset automatically), so each test clears what it touches.
 */

afterEach(() => {
  sessionStorage.clear();
});

describe('API key store', () => {
  it('round-trips through save/load/clear', () => {
    expect(loadApiKey()).toBeNull();
    saveApiKey('sk-test');
    expect(loadApiKey()).toBe('sk-test');
    clearApiKey();
    expect(loadApiKey()).toBeNull();
  });
});

describe('selected workspace store (S4.1)', () => {
  it('round-trips through save/load, independent of the API key store', () => {
    expect(loadSelectedWorkspaceId()).toBeNull();
    saveSelectedWorkspaceId('ws-1');
    expect(loadSelectedWorkspaceId()).toBe('ws-1');
    expect(loadApiKey()).toBeNull();
  });
});

describe('reloadIntoWorkspace (legacy 649)', () => {
  it('selects the workspace, sets the destination without a hashchange, then reloads', () => {
    window.history.replaceState(null, '', '/#/platform/admin-agent');
    const onHashChange = vi.fn();
    window.addEventListener('hashchange', onHashChange);
    const reload = vi.fn();
    reloadIntoWorkspace('ws-trial', '#/work/chats?open=admin_agent', reload);
    window.removeEventListener('hashchange', onHashChange);
    expect(loadSelectedWorkspaceId()).toBe('ws-trial');
    expect(window.location.hash).toBe('#/work/chats?open=admin_agent');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onHashChange).not.toHaveBeenCalled();
  });
});
