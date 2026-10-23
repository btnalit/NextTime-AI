import { describe, expect, it } from 'vitest';
import { entryCeilingCapabilities } from './entry-ceiling.js';

describe('lib/entry-ceiling', () => {
  it('offers what an entry agent uses for goals: proposing one and reading its own (S11 GO5c), none of the operations', () => {
    const names = entryCeilingCapabilities().map((capability) => capability.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'propose_goal',
        'get_goal',
        'list_goals',
        'get_goal_revision',
        'list_goal_unresolved_actions',
      ]),
    );
    for (const operation of ['confirm_goal', 'pause_goal', 'revise_goal', 'cancel_goal']) {
      expect(names).not.toContain(operation);
    }
  });
});
