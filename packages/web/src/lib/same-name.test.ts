import { describe, expect, it } from 'vitest';
import { sameNameIds, withSameNameId } from './same-name.js';

describe('sameNameIds / withSameNameId', () => {
  const rows = [
    { id: 'aaaaaaaa-1', name: 'orders' },
    { id: 'bbbbbbbb-2', name: 'orders' },
    { id: 'cccccccc-3', name: 'billing' },
    { id: 'dddddddd-4', name: '' },
    { id: 'eeeeeeee-5', name: '' },
  ];

  it('marks only ids whose name another id also carries; unnamed rows never collide', () => {
    const same = sameNameIds(
      rows,
      (row) => row.id,
      (row) => row.name,
    );
    expect([...same].sort()).toEqual(['aaaaaaaa-1', 'bbbbbbbb-2']);
  });

  it('the same id listed twice is not a collision', () => {
    const same = sameNameIds(
      [rows[0], rows[0]],
      (row) => row?.id ?? '',
      (row) => row?.name,
    );
    expect(same.size).toBe(0);
  });

  it('appends the short id only to colliding names', () => {
    const same = sameNameIds(
      rows,
      (row) => row.id,
      (row) => row.name,
    );
    expect(withSameNameId('orders', 'aaaaaaaa-1', same)).toBe('orders · aaaaaaaa');
    expect(withSameNameId('billing', 'cccccccc-3', same)).toBe('billing');
  });
});
