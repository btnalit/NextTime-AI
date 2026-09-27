import { describe, expect, it } from 'vitest';
import { currentCorrelationId, runWithCorrelationId } from './index.js';

describe('substrate/correlation', () => {
  it('is undefined outside any call', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('carries the id through awaits and nested async work', async () => {
    const seen = await runWithCorrelationId('turn-1111-2222', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return Promise.all([
        Promise.resolve().then(() => currentCorrelationId()),
        new Promise<string | undefined>((resolve) =>
          setImmediate(() => resolve(currentCorrelationId())),
        ),
      ]);
    });
    expect(seen).toEqual(['turn-1111-2222', 'turn-1111-2222']);
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('an inner call overrides and restores', () => {
    runWithCorrelationId('outer-id-0000', () => {
      runWithCorrelationId('inner-id-0000', () => {
        expect(currentCorrelationId()).toBe('inner-id-0000');
      });
      expect(currentCorrelationId()).toBe('outer-id-0000');
    });
  });

  it('an invalid id runs with no context rather than a bad one', () => {
    runWithCorrelationId('outer-id-0000', () => {
      runWithCorrelationId('bad id', () => {
        expect(currentCorrelationId()).toBeUndefined();
      });
    });
  });
});
