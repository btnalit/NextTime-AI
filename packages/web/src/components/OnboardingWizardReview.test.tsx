// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import type { GraphObjectRow } from '../lib/connections.js';
import { OnboardingWizardReview, loadGateOperations } from './OnboardingWizardReview.js';

afterEach(cleanup);

function operationObject(gatekeeperId: string, name: string): GraphObjectRow {
  return {
    id: `obj-${gatekeeperId}-${name}`,
    objectType: 'Operation',
    identityKey: { gatekeeperId, name },
    properties: {
      name,
      params_schema: { type: 'object' },
      mode: 'observe',
      blast_radius: 'low',
      auto_approvable: true,
      status: 'published',
    },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

/** A kernel with three `search` pages: the first two hold only other gates' Operations (the ones
 *  that used to push this gate's rows past the old single-page cap), the third holds this gate's. */
function pagedHttp() {
  const params: unknown[] = [];
  const pages: Record<string, { items: GraphObjectRow[]; nextCursor?: string }> = {
    first: {
      items: Array.from({ length: 5 }, (_, i) => operationObject('gk-other', `other_${i}`)),
      nextCursor: 'c1',
    },
    c1: {
      items: [operationObject('gk-other', 'other_x'), operationObject('gk-1', 'first_op')],
      nextCursor: 'c2',
    },
    c2: { items: [operationObject('gk-1', 'late_op')] },
  };
  const http = {
    call: vi.fn(async (name: string, p?: unknown) => {
      if (name !== 'search') throw new Error(`unscripted ${name}`);
      params.push(p);
      const cursor = (p as { cursor?: string }).cursor ?? 'first';
      return pages[cursor];
    }) as CapabilityCaller['call'],
  };
  return { http: http as CapabilityCaller, params };
}

describe('loadGateOperations', () => {
  it('follows nextCursor through every page and keeps only this gate’s Operations', async () => {
    const { http, params } = pagedHttp();
    const rows = await loadGateOperations(http, 'gk-1');
    expect(rows.map((row) => row.name)).toEqual(['first_op', 'late_op']);
    expect(params).toEqual([
      { query: 'gk-1', objectType: 'Operation', limit: 200 },
      { query: 'gk-1', objectType: 'Operation', limit: 200, cursor: 'c1' },
      { query: 'gk-1', objectType: 'Operation', limit: 200, cursor: 'c2' },
    ]);
  });

  it('stops when the kernel repeats a cursor instead of looping forever', async () => {
    const http = {
      call: vi.fn(async () => ({
        items: [operationObject('gk-1', 'op')],
        nextCursor: 'same',
      })) as CapabilityCaller['call'],
    } as CapabilityCaller;
    const rows = await loadGateOperations(http, 'gk-1');
    expect(rows.length).toBe(2);
    expect(http.call).toHaveBeenCalledTimes(2);
  });

  it('still accepts the older bare-array search answer', async () => {
    const http = {
      call: vi.fn(async () => [operationObject('gk-1', 'op')]) as CapabilityCaller['call'],
    } as CapabilityCaller;
    expect((await loadGateOperations(http, 'gk-1')).map((row) => row.name)).toEqual(['op']);
  });
});

describe('OnboardingWizardReview', () => {
  it('lists Operations found on a later page instead of saying the gate imported none', async () => {
    const { http } = pagedHttp();
    render(<OnboardingWizardReview http={http} gatekeeperId="gk-1" onDone={vi.fn()} />);
    expect(await screen.findByText('late_op')).toBeTruthy();
    expect(screen.getByText('first_op')).toBeTruthy();
    expect(screen.queryByText('这个门没有导入任何 Operation')).toBeNull();
    // Table headers are translated, not English-only.
    expect(screen.getByText('影响范围')).toBeTruthy();
  });

  it('still says so when the gate really has no Operations', async () => {
    const http = {
      call: vi.fn(async () => ({ items: [] })) as CapabilityCaller['call'],
    } as CapabilityCaller;
    render(<OnboardingWizardReview http={http} gatekeeperId="gk-1" onDone={vi.fn()} />);
    expect(await screen.findByText('这个门没有导入任何 Operation')).toBeTruthy();
  });
});
