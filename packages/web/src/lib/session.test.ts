// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearApiKey,
  loadApiKey,
  loadSelectedWorkspaceId,
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
