import { describe, expect, it } from 'vitest';
import {
  capabilityChanges,
  entryCapabilitiesOf,
  entryPromptOf,
  lineDiff,
} from './entry-template.js';

describe('lineDiff (legacy 145)', () => {
  it('shows a paragraph added in the middle as those lines, with a little context and the rest folded', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'new 1', 'new 2', 'e', 'f', 'g', 'h'].join('\n');
    expect(lineDiff(before, after, 1)).toEqual([
      { change: 'gap', count: 3 },
      { change: 'same', text: 'd' },
      { change: 'added', text: 'new 1' },
      { change: 'added', text: 'new 2' },
      { change: 'same', text: 'e' },
      { change: 'gap', count: 3 },
    ]);
  });

  it('shows a changed line as the old one removed and the new one added', () => {
    expect(lineDiff('keep\nold\nkeep too', 'keep\nnew\nkeep too')).toEqual([
      { change: 'same', text: 'keep' },
      { change: 'removed', text: 'old' },
      { change: 'added', text: 'new' },
      { change: 'same', text: 'keep too' },
    ]);
  });

  it('says nothing changed by folding everything', () => {
    expect(lineDiff('a\nb\nc\nd\ne\nf', 'a\nb\nc\nd\ne\nf')).toEqual([{ change: 'gap', count: 6 }]);
  });
});

describe('capabilityChanges (legacy 145)', () => {
  it('names what the template adds and what it takes out, in their own order', () => {
    expect(
      capabilityChanges(
        ['search', 'old_tool', 'get_task'],
        ['search', 'get_task', 'propose_goal', 'get_goal'],
      ),
    ).toEqual({
      added: ['propose_goal', 'get_goal'],
      removed: ['old_tool'],
    });
  });
});

describe('entry definition fields (UX acceptance of #747)', () => {
  it('reads the prompt and the capability names, and nothing when they are missing or malformed', () => {
    expect(entryPromptOf({ systemPrompt: 'hi' })).toBe('hi');
    expect(entryPromptOf({ systemPrompt: 3 })).toBe('');
    expect(entryCapabilitiesOf({ capabilities: ['search', 'propose_goal'] })).toEqual([
      'search',
      'propose_goal',
    ]);
    expect(entryCapabilitiesOf({ capabilities: 'search' })).toEqual([]);
    expect(entryCapabilitiesOf({})).toEqual([]);
  });
});
