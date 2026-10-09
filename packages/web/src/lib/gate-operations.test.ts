import type { OperationSummaryWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { operationChoices } from './gate-operations.js';

function op(overrides: Partial<OperationSummaryWire>): OperationSummaryWire {
  return {
    gatekeeperId: 'gk-1',
    name: 'op',
    mode: 'execute',
    blastRadius: 'low',
    autoApprovable: false,
    version: 1,
    status: 'published',
    ...overrides,
  };
}

describe('operationChoices', () => {
  it('keeps published Operations only, one per name, sorted', () => {
    expect(
      operationChoices([
        op({ name: 'restart', blastRadius: 'medium', description: 'Restart a container' }),
        op({ name: 'prune', status: 'draft' }),
        op({ name: 'old', status: 'deprecated' }),
        op({ name: 'inspect', mode: 'observe' }),
      ]),
    ).toEqual([
      { name: 'inspect', blastRadius: 'low', gateCount: 1 },
      {
        name: 'restart',
        blastRadius: 'medium',
        description: 'Restart a container',
        gateCount: 1,
      },
    ]);
  });

  it('folds the same name across gates, keeping the blast radius only when every gate agrees', () => {
    expect(
      operationChoices([
        op({ gatekeeperId: 'gk-1', name: 'restart', blastRadius: 'medium' }),
        op({ gatekeeperId: 'gk-2', name: 'restart', blastRadius: 'high' }),
        op({ gatekeeperId: 'gk-1', name: 'inspect' }),
        op({ gatekeeperId: 'gk-2', name: 'inspect' }),
      ]),
    ).toEqual([
      { name: 'inspect', blastRadius: 'low', gateCount: 2 },
      { name: 'restart', blastRadius: null, gateCount: 2 },
    ]);
  });
});
