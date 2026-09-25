import { describe, expect, it } from 'vitest';
import { taskNeed } from './tasks.js';

/**
 * lib/tasks.test: `taskNeed` (S8 W4, audit R7 "行副标题直接显示原始 JSON 输入") — the conventional
 * `invoke_worker` input shapes `TasksPage`'s row subtitle recognizes before falling back to a raw
 * JSON excerpt of the opaque `input` blob.
 */
describe('taskNeed', () => {
  it('returns a bare string input as-is', () => {
    expect(taskNeed('restart web-1')).toBe('restart web-1');
  });

  it.each(['need', 'intent', 'prompt', 'summary', 'task'])(
    'reads the %s key off an object input',
    (key) => {
      expect(taskNeed({ [key]: 'Inventory the Docker containers' })).toBe(
        'Inventory the Docker containers',
      );
    },
  );

  it('prefers need over a later key when both are present', () => {
    expect(taskNeed({ need: 'from need', intent: 'from intent' })).toBe('from need');
  });

  it('returns undefined for an object with none of the conventional keys, or a non-string value', () => {
    expect(taskNeed({ foo: 'bar' })).toBeUndefined();
    expect(taskNeed({ intent: 42 })).toBeUndefined();
    expect(taskNeed(null)).toBeUndefined();
    expect(taskNeed(undefined)).toBeUndefined();
  });
});
