import { describe, expect, it } from 'vitest';
import { rebaseTargets } from './admin-agent.js';

describe('rebaseTargets (legacy 648)', () => {
  it('puts the reader’s additions and removals on the targets as saved now', () => {
    expect(rebaseTargets(['a', 'b', 'c'], ['d'], ['b'])).toEqual(['a', 'c', 'd']);
  });

  it('adds nothing twice and removes what is not there without complaint', () => {
    expect(rebaseTargets(['a', 'd'], ['d'], ['x'])).toEqual(['a', 'd']);
  });

  it('keeps a target added since the dialog opened', () => {
    expect(rebaseTargets(['a', 'n'], [], ['a'])).toEqual(['n']);
  });
});
