import { describe, expect, it } from 'vitest';
import { PLATFORM_EVENT_NAMES, PlatformEventNameSchema } from './index.js';

describe('PLATFORM_EVENT_NAMES', () => {
  it('lists the nine canonical domain events from design doc §7.10', () => {
    expect(PLATFORM_EVENT_NAMES).toEqual([
      'TurnStarted',
      'TurnCompleted',
      'TaskUpdated',
      'ActionRequestPending',
      'ActionRequestUpdated',
      'ConnectionCreated',
      'FactAsserted',
      'EgressObserved',
      'BudgetWarning',
    ]);
  });

  it('accepts every listed event name via the Zod schema', () => {
    for (const name of PLATFORM_EVENT_NAMES) {
      expect(PlatformEventNameSchema.parse(name)).toBe(name);
    }
  });

  it('rejects an unknown event name', () => {
    expect(() => PlatformEventNameSchema.parse('NotARealEvent')).toThrow();
  });
});
