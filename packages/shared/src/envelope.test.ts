import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listEnvelope } from './envelope.js';

describe('listEnvelope', () => {
  const schema = listEnvelope(z.object({ id: z.string() }));

  it('accepts items with no cursor and no truncated flag', () => {
    const result = schema.safeParse({ items: [{ id: 'a' }, { id: 'b' }] });
    expect(result.success).toBe(true);
  });

  it('accepts items with a nextCursor', () => {
    const result = schema.safeParse({ items: [{ id: 'a' }], nextCursor: 'cursor-1' });
    expect(result.success).toBe(true);
  });

  it('accepts truncated: true', () => {
    const result = schema.safeParse({ items: [], truncated: true });
    expect(result.success).toBe(true);
  });

  it('rejects truncated: false (must be omitted, never false)', () => {
    const result = schema.safeParse({ items: [], truncated: false });
    expect(result.success).toBe(false);
  });

  it('rejects a bare array (no items wrapper)', () => {
    const result = schema.safeParse([{ id: 'a' }]);
    expect(result.success).toBe(false);
  });

  it('rejects an item that fails the inner schema', () => {
    const result = schema.safeParse({ items: [{ id: 1 }] });
    expect(result.success).toBe(false);
  });
});
