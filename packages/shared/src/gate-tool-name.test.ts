import { describe, expect, it } from 'vitest';
import {
  type GateToolNameSource,
  TOOL_NAME_MAX_LENGTH,
  allocateGateToolName,
  sanitizeToolName,
} from './gate-tool-name.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

function namesOf(ops: readonly GateToolNameSource[], reserved: readonly string[] = []): string[] {
  const used = new Set(reserved);
  return ops.map((op) => allocateGateToolName(op, used));
}

describe('sanitizeToolName', () => {
  it('replaces every character outside [a-zA-Z0-9_-] and cuts to 64', () => {
    expect(sanitizeToolName('docker.container:restart')).toBe('docker_container_restart');
    expect(sanitizeToolName('a-b_C9')).toBe('a-b_C9');
    expect(sanitizeToolName('x'.repeat(80))).toHaveLength(TOOL_NAME_MAX_LENGTH);
  });
});

describe('allocateGateToolName (legacy 768)', () => {
  it('names a tool `<gate>_<op>`, and a later one of the same name by its gatekeeperId', () => {
    expect(
      namesOf([
        { gatekeeperId: FIRST, gateName: 'stock', name: 'stock.list' },
        { gatekeeperId: SECOND, gateName: 'stock', name: 'stock.list' },
      ]),
    ).toEqual(['stock_stock_list', `${SECOND}_stock_list`]);
  });

  it('leaves the consumer’s own tools alone: a gate tool that would take one falls back', () => {
    expect(
      namesOf([{ gatekeeperId: FIRST, gateName: 'report', name: 'result' }], ['report_result']),
    ).toEqual([`${FIRST}_result`]);
  });

  it('numbers a name whose gatekeeperId fallback is taken too', () => {
    // The second gate's two Operations sanitize to one name, which the first gate already holds.
    expect(
      namesOf([
        { gatekeeperId: FIRST, gateName: 'host', name: 'disk.usage' },
        { gatekeeperId: SECOND, gateName: 'host', name: 'disk.usage' },
        { gatekeeperId: SECOND, gateName: 'host', name: 'disk_usage' },
        { gatekeeperId: SECOND, gateName: 'host', name: 'disk:usage' },
      ]),
    ).toEqual([
      'host_disk_usage',
      `${SECOND}_disk_usage`,
      `${SECOND}_disk_usage_2`,
      `${SECOND}_disk_usage_3`,
    ]);
  });

  it('numbers names the 64-character cut makes equal, and keeps every one within 64', () => {
    // 57 characters: past the cut in both `<gate>_<op>` (10 + 57) and `<gatekeeperId>_<op>` (37 + 57).
    const shared = 'warehouse.shelf.items.count.by.location.zone.and.section.';
    const names = namesOf([
      { gatekeeperId: FIRST, gateName: 'inventory', name: `${shared}aisle` },
      { gatekeeperId: FIRST, gateName: 'inventory', name: `${shared}bay` },
      { gatekeeperId: FIRST, gateName: 'inventory', name: `${shared}level` },
    ]);
    expect(names[0]).toBe(sanitizeToolName(`inventory.${shared}aisle`));
    expect(names[1]).toBe(sanitizeToolName(`${FIRST}.${shared}bay`));
    expect(names[2]).toBe(`${sanitizeToolName(`${FIRST}.${shared}level`).slice(0, 62)}_2`);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(TOOL_NAME_MAX_LENGTH);
  });

  it('never hands out a name already taken, however the names line up', () => {
    // An Operation literally named like a numbered fallback comes later and still gets its own.
    const ops: GateToolNameSource[] = [
      { gatekeeperId: FIRST, gateName: 'g', name: 'a.b' },
      { gatekeeperId: FIRST, gateName: 'g', name: 'a_b' },
      { gatekeeperId: FIRST, gateName: 'g', name: 'a-b' },
      { gatekeeperId: FIRST, gateName: 'g', name: 'a:b' },
      { gatekeeperId: FIRST, gateName: FIRST, name: 'a_b_2' },
      { gatekeeperId: SECOND, gateName: 'g', name: 'a.b' },
      { gatekeeperId: SECOND, gateName: 'g', name: 'a_b' },
    ];
    const reserved = ['g_a_b_2', `${FIRST}_a_b_2`];
    const names = namesOf(ops, reserved);
    expect(new Set([...reserved, ...names]).size).toBe(reserved.length + names.length);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('gives the same list the same names every time', () => {
    const ops: GateToolNameSource[] = [
      { gatekeeperId: FIRST, gateName: 'host', name: 'disk.usage' },
      { gatekeeperId: FIRST, gateName: 'host', name: 'disk_usage' },
      { gatekeeperId: FIRST, gateName: 'host', name: 'disk:usage' },
    ];
    expect(namesOf(ops)).toEqual(namesOf(ops));
  });
});
