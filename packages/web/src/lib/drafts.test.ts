// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_DRAFTS, clearDrafts, draftScope, loadDraft, saveDraft } from './drafts.js';

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
