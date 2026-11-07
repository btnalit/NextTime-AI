// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DRAFTS,
  MAX_DRAFTS_TOTAL_CHARS,
  MAX_DRAFT_CHARS,
  clearDrafts,
  draftScope,
  forgetDraft,
  keepDraftsOf,
  loadDraft,
  loadDraftValue,
  saveDraft,
  saveDraftValue,
} from './drafts.js';

/** drafts.test.ts: legacy 658 — the chat box's unsent text in this tab's sessionStorage. */

beforeEach(() => sessionStorage.clear());

describe('lib/drafts', () => {
  it('keeps a draft per caller and chat', () => {
    saveDraft(draftScope('p-1', 'chat-a'), 'one');
    saveDraft(draftScope('p-2', 'chat-a'), 'two');
    expect(loadDraft(draftScope('p-1', 'chat-a'))).toBe('one');
    expect(loadDraft(draftScope('p-2', 'chat-a'))).toBe('two');
    expect(loadDraft(draftScope('p-1', 'chat-b'))).toBeNull();
  });

  it('blank text removes the draft, and an empty store leaves no key behind', () => {
    const scope = draftScope('p-1', 'chat-a');
    saveDraft(scope, 'something');
    saveDraft(scope, '   ');
    expect(loadDraft(scope)).toBeNull();
    expect(sessionStorage.getItem('nexttime.drafts')).toBeNull();
  });

  it('keeps the newest drafts only', () => {
    for (let i = 0; i <= MAX_DRAFTS; i += 1) saveDraft(draftScope('p-1', `chat-${i}`), `d${i}`);
    expect(loadDraft(draftScope('p-1', 'chat-0'))).toBeNull();
    expect(loadDraft(draftScope('p-1', 'chat-1'))).toBe('d1');
    expect(loadDraft(draftScope('p-1', `chat-${MAX_DRAFTS}`))).toBe(`d${MAX_DRAFTS}`);
  });

  it('an edited draft counts as the newest', () => {
    for (let i = 0; i < MAX_DRAFTS; i += 1) saveDraft(draftScope('p-1', `chat-${i}`), `d${i}`);
    saveDraft(draftScope('p-1', 'chat-0'), 'edited');
    saveDraft(draftScope('p-1', 'chat-new'), 'new');
    expect(loadDraft(draftScope('p-1', 'chat-0'))).toBe('edited');
    expect(loadDraft(draftScope('p-1', 'chat-1'))).toBeNull();
  });

  it('a store that is not what this module wrote reads as empty', () => {
    sessionStorage.setItem('nexttime.drafts', '[1,2]');
    expect(loadDraft('x')).toBeNull();
    sessionStorage.setItem('nexttime.drafts', '{not json');
    expect(loadDraft('x')).toBeNull();
    sessionStorage.setItem('nexttime.drafts', JSON.stringify({ x: 42, y: 'ok' }));
    expect(loadDraft('x')).toBeNull();
    expect(loadDraft('y')).toBe('ok');
  });

  it('clearDrafts empties the store', () => {
    saveDraft(draftScope('p-1', 'chat-a'), 'one');
    clearDrafts();
    expect(sessionStorage.getItem('nexttime.drafts')).toBeNull();
  });
});

describe('lib/drafts keepDraftsOf', () => {
  it('keeps the drafts of the principals given and drops the rest', () => {
    saveDraft(draftScope('p-1', 'chat-a'), 'one');
    saveDraft(draftScope('p-2', 'chat-a'), 'two');
    saveDraft(draftScope('p-3', 'chat-b'), 'three');
    keepDraftsOf(['p-1', 'p-3']);
    expect(loadDraft(draftScope('p-1', 'chat-a'))).toBe('one');
    expect(loadDraft(draftScope('p-2', 'chat-a'))).toBeNull();
    expect(loadDraft(draftScope('p-3', 'chat-b'))).toBe('three');
    keepDraftsOf([]);
    expect(sessionStorage.getItem('nexttime.drafts')).toBeNull();
  });
});

describe('lib/drafts structured values (legacy 662)', () => {
  it('keeps an editor form as JSON and gives it back', () => {
    const scope = draftScope('p-1', 'skill:new');
    saveDraftValue(scope, { name: 'restart-web', steps: [{ key: 'step-1' }] });
    expect(loadDraftValue(scope)).toEqual({ name: 'restart-web', steps: [{ key: 'step-1' }] });
    forgetDraft(scope);
    expect(loadDraftValue(scope)).toBeNull();
  });

  it('a chat draft under the same key is not taken for a value', () => {
    saveDraft(draftScope('p-1', 'x'), 'plain text');
    expect(loadDraftValue(draftScope('p-1', 'x'))).toBeNull();
  });

  it('a draft past the size ceiling is not kept, and an older copy goes', () => {
    const scope = draftScope('p-1', 'skill:new');
    saveDraftValue(scope, { markdown: 'short' });
    saveDraftValue(scope, { markdown: 'x'.repeat(MAX_DRAFT_CHARS) });
    expect(loadDraftValue(scope)).toBeNull();
  });
});

describe('lib/drafts total size (legacy 667)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps all drafts together under the total ceiling, the oldest going first', () => {
    const big = 'x'.repeat(MAX_DRAFT_CHARS - 10);
    const scopes = Array.from({ length: 8 }, (_, i) => draftScope('p-1', `chat-${i}`));
    for (const scope of scopes) saveDraft(scope, big);
    const kept = scopes.filter((scope) => loadDraft(scope) !== null);
    expect(kept.length * big.length).toBeLessThanOrEqual(MAX_DRAFTS_TOTAL_CHARS);
    expect(kept).toEqual(scopes.slice(scopes.length - kept.length));
    expect(loadDraft(scopes[7] as string)).toBe(big);
  });

  it('a store the browser will not take drops the oldest drafts until it does', () => {
    saveDraft(draftScope('p-1', 'chat-a'), 'older');
    saveDraft(draftScope('p-1', 'chat-b'), 'newer');
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (value.length > 60) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    saveDraft(draftScope('p-1', 'chat-c'), 'newest');
    expect(loadDraft(draftScope('p-1', 'chat-a'))).toBeNull();
    expect(loadDraft(draftScope('p-1', 'chat-c'))).toBe('newest');
  });

  it('a draft forgotten while the store is full does not come back', () => {
    saveDraft(draftScope('p-1', 'chat-a'), 'sent already');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    saveDraft(draftScope('p-1', 'chat-b'), 'typed');
    expect(loadDraft(draftScope('p-1', 'chat-a'))).toBeNull();
  });
});
