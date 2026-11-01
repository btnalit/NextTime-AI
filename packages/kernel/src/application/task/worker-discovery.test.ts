import {
  type OutputSchema,
  WORKER_HINT_MIN_SAMPLE,
  WORKER_HINT_WINDOW_DAYS,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { NO_OBSERVE_EXCLUSIONS } from '../gates/index.js';
import {
  type GateAccessContext,
  emptyWorkerHints,
  workerContractOf,
  workerGateAccess,
  workerRefKey,
} from './worker-discovery.js';

/**
 * application/task/worker-discovery (S11 GO13): the pure halves — what a Worker's content declares
 * as its contract, and per declared gate what a Worker of it delegated with a given scope could do
 * there. The reads that feed them are `worker-discovery.integration.test.ts`'.
 */

const REPORT: OutputSchema = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
};

describe('workerContractOf', () => {
  it('carries the schemas a Worker declares, and leaves out one that does not parse', () => {
    expect(workerContractOf({ inputSchema: REPORT, outputSchema: REPORT })).toEqual({
      inputSchema: REPORT,
      outputSchema: REPORT,
    });
    expect(workerContractOf({ systemPrompt: 'x' })).toEqual({});
    // A root that is not an object is not a contract: never shown as if it were one.
    expect(workerContractOf({ inputSchema: { type: 'string' }, outputSchema: REPORT })).toEqual({
      outputSchema: REPORT,
    });
    expect(workerContractOf({ outputSchema: 'not a schema' })).toEqual({});
  });
});

describe('workerGateAccess', () => {
  const context = (overrides: Partial<GateAccessContext> = {}): GateAccessContext => ({
    gateNames: new Map([
      ['g-held', 'held'],
      ['g-open', 'open'],
      ['g-quiet', 'quiet'],
    ]),
    observable: new Set(['g-held', 'g-open']),
    exclusions: NO_OBSERVE_EXCLUSIONS,
    ...overrides,
  });
  const reading = { capabilities: ['observe_operation'], resources: {} };
  const acting = {
    capabilities: ['request_action', 'observe_operation'],
    resources: { gatekeeper: ['g-held'] },
  };

  it('a gate that is not here: none, gate_not_enabled, with no name', () => {
    expect(workerGateAccess(context(), ['g-gone'], acting)).toEqual([
      { gatekeeperId: 'g-gone', name: null, access: 'none', reason: 'gate_not_enabled' },
    ]);
  });

  it('act only with the gate carried and an execute-class capability', () => {
    expect(workerGateAccess(context(), ['g-held'], acting)).toEqual([
      { gatekeeperId: 'g-held', name: 'held', access: 'act' },
    ]);
    // Carried, but nothing execute-class: it can only read there.
    expect(
      workerGateAccess(context(), ['g-held'], {
        ...reading,
        resources: { gatekeeper: ['g-held'] },
      }),
    ).toEqual([{ gatekeeperId: 'g-held', name: 'held', access: 'observe' }]);
  });

  it('otherwise observe, or none by the reason enforcement uses', () => {
    expect(workerGateAccess(context(), ['g-open', 'g-quiet'], reading)).toEqual([
      { gatekeeperId: 'g-open', name: 'open', access: 'observe' },
      { gatekeeperId: 'g-quiet', name: 'quiet', access: 'none', reason: 'no_observable_operation' },
    ]);
    const capped = context({
      exclusions: { ...NO_OBSERVE_EXCLUSIONS, policyAllowedGatekeepers: ['g-held'] },
    });
    expect(workerGateAccess(capped, ['g-open'], reading)).toEqual([
      { gatekeeperId: 'g-open', name: 'open', access: 'none', reason: 'excluded_by_policy' },
    ]);
    const excluded = context({
      exclusions: { ...NO_OBSERVE_EXCLUSIONS, profileExcludedGatekeepers: ['g-open'] },
    });
    expect(workerGateAccess(excluded, ['g-open'], reading)).toEqual([
      { gatekeeperId: 'g-open', name: 'open', access: 'none', reason: 'excluded_by_profile' },
    ]);
  });

  it('a gate declared twice is listed once', () => {
    expect(workerGateAccess(context(), ['g-open', 'g-open'], reading)).toHaveLength(1);
  });
});

describe('emptyWorkerHints / workerRefKey', () => {
  it('no Task: nothing known, marked insufficient', () => {
    expect(emptyWorkerHints()).toEqual({
      windowDays: WORKER_HINT_WINDOW_DAYS,
      minSample: WORKER_HINT_MIN_SAMPLE,
      cost: { medianTokens: null, tasks: 0, sufficient: false },
      outcomes: { achieved: 0, total: 0, sufficient: false },
    });
    expect(workerRefKey({ definitionId: 'd', version: 3 })).toBe('d@3');
  });
});
