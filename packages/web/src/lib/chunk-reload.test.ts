// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_WINDOW_MS,
  hasUnsentInput,
  isChunkLoadError,
  reloadForChunkError,
} from './chunk-reload.js';

afterEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = '';
});

const ok = () => Promise.resolve(new Response('', { status: 200 }));

describe('isChunkLoadError (legacy 880)', () => {
  it('knows the chunk-load messages of Chromium, Firefox, Safari and Vite', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://x/assets/ChatPage-abc.js',
      'error loading dynamically imported module: https://x/assets/ChatPage-abc.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/ChatPage-abc.css',
    ]) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
    }
  });

  it('leaves every other error alone', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('reloadForChunkError (legacy 880)', () => {
  it('reloads once the server answers, and marks the tab', async () => {
    const reload = vi.fn();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => ok());
    await expect(reloadForChunkError({ fetchImpl, reload, now: () => 1_000_000 })).resolves.toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload again within the window after its own reload', async () => {
    const reload = vi.fn();
    await reloadForChunkError({ fetchImpl: ok, reload, now: () => 1_000_000 });
    const again = await reloadForChunkError({
      fetchImpl: ok,
      reload,
      now: () => 1_000_000 + CHUNK_RELOAD_WINDOW_MS - 1,
    });
    expect(again).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    // Past the window it may try again.
    const later = await reloadForChunkError({
      fetchImpl: ok,
      reload,
      now: () => 1_000_000 + CHUNK_RELOAD_WINDOW_MS,
    });
    expect(later).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload into a server that does not answer', async () => {
    const reload = vi.fn();
    const down = () => Promise.resolve(new Response('', { status: 502 }));
    await expect(reloadForChunkError({ fetchImpl: down, reload })).resolves.toBe(false);
    const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(reloadForChunkError({ fetchImpl: unreachable, reload })).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    // A failed probe leaves no marker: the next failure may still reload.
    await expect(reloadForChunkError({ fetchImpl: ok, reload })).resolves.toBe(true);
  });

  it('does not reload while the browser says it is offline', async () => {
    const reload = vi.fn();
    const fetchImpl = vi.fn(ok);
    await expect(reloadForChunkError({ fetchImpl, reload, online: () => false })).resolves.toBe(
      false,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when the tab cannot keep its marker (no loop guard)', async () => {
    const reload = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      await expect(reloadForChunkError({ fetchImpl: ok, reload })).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('hasUnsentInput (legacy 880)', () => {
  it('counts text in any field still on the page', () => {
    document.body.innerHTML =
      '<select><option>a</option></select><input type="checkbox" checked><input type="text">';
    expect(hasUnsentInput()).toBe(false);
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = '   ';
    expect(hasUnsentInput()).toBe(false);
    input.value = 'half a sentence';
    expect(hasUnsentInput()).toBe(true);
  });

  it('counts a textarea and an editable element', () => {
    document.body.innerHTML = '<textarea></textarea>';
    (document.querySelector('textarea') as HTMLTextAreaElement).value = 'draft';
    expect(hasUnsentInput()).toBe(true);
    document.body.innerHTML = '<div contenteditable="true"></div>';
    expect(hasUnsentInput()).toBe(false);
  });

  it('keeps a page with something typed from reloading by itself', async () => {
    const reload = vi.fn();
    const fetchImpl = vi.fn(ok);
    await expect(reloadForChunkError({ fetchImpl, reload, unsentInput: () => true })).resolves.toBe(
      false,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when something was typed while the server was checked', async () => {
    const reload = vi.fn();
    const answers = [false, true];
    await expect(
      reloadForChunkError({ fetchImpl: ok, reload, unsentInput: () => answers.shift() ?? true }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
