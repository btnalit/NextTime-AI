import { describe, expect, it } from 'vitest';
import {
  capabilityModeLabel,
  egressHostSuggestions,
  groupCapabilitiesByMode,
} from './catalog-pickers.js';

const t = <T>(zh: T, _en: T): T => zh;

describe('catalog-pickers', () => {
  it('groups capability rows by mode in registry order, sorted by name, and filters by name', () => {
    const rows = [
      { name: 'request_action', mode: 'execute' },
      { name: 'search', mode: 'observe' },
      { name: 'assert_fact', mode: 'write' },
      { name: 'get_object', mode: 'observe' },
      { name: 'odd', mode: 'zz-mode' },
    ];
    expect(
      groupCapabilitiesByMode(rows).map((group) => [group.mode, group.rows.map((r) => r.name)]),
    ).toEqual([
      ['observe', ['get_object', 'search']],
      ['write', ['assert_fact']],
      ['execute', ['request_action']],
      ['zz-mode', ['odd']],
    ]);
    expect(groupCapabilitiesByMode(rows, ' GET ').map((group) => group.mode)).toEqual(['observe']);
    expect(capabilityModeLabel('observe', t)).toBe('观察（只读）');
    expect(capabilityModeLabel('zz-mode', t)).toBe('zz-mode');
  });

  it('suggests the hosts of enabled gate instances that are not on the deny list yet', () => {
    const instances = [
      {
        target: 'https://Billing.example.com:8443/api',
        displayName: 'Billing',
        gatekeeperId: 'g1',
      },
      { target: 'https://billing.example.com/v2', displayName: 'Billing v2', gatekeeperId: 'g2' },
      { target: 'erp.example.com', displayName: 'ERP', gatekeeperId: 'g3' },
      { target: 'https://crm.example.com', displayName: 'CRM', gatekeeperId: null },
      { target: 'unix:///var/run/docker.sock', displayName: 'Docker', gatekeeperId: 'g4' },
    ];
    expect(egressHostSuggestions(instances, ['https://erp.example.com/'])).toEqual([
      { host: 'billing.example.com', systems: ['Billing', 'Billing v2'] },
    ]);
  });
});
