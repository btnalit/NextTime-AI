// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import type { GraphObjectRow } from '../lib/connections.js';
import { operationDetailFromObject } from '../lib/connections.js';
import { HttpError } from '../lib/http-client.js';
import {
  OnboardingWizardReview,
  currentRevisions,
  loadGateOperations,
} from './OnboardingWizardReview.js';

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

describe('currentRevisions (#541 acceptance P3 ③)', () => {
  function revision(name: string, version: number, status: string) {
    const object = operationObject('gk-1', name);
    const row = operationDetailFromObject({
      ...object,
      id: `${object.id}-v${version}`,
      identityKey: { gatekeeperId: 'gk-1', name, version },
      properties: { ...object.properties, status },
    });
    if (row === undefined) throw new Error('not an Operation');
    return row;
  }

  it('keeps one row per name: the draft under review, else the published one, newest first', () => {
    const rows = [
      revision('stock.get', 1, 'deprecated'),
      revision('stock.get', 2, 'published'),
      revision('stock.get', 3, 'draft'),
      revision('stock.put', 1, 'published'),
      revision('stock.put', 2, 'published'),
      revision('stock.old', 1, 'deprecated'),
      revision('stock.old', 2, 'deprecated'),
    ];
    expect(currentRevisions(rows).map((row) => `${row.name}@${row.version}:${row.status}`)).toEqual(
      ['stock.get@3:draft', 'stock.put@2:published', 'stock.old@2:deprecated'],
    );
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
      call: vi.fn(async (name: string) => {
        if (name === 'get_workspace') throw new Error('no role read in this test');
        return { items: [] };
      }) as CapabilityCaller['call'],
    } as CapabilityCaller;
    render(<OnboardingWizardReview http={http} gatekeeperId="gk-1" onDone={vi.fn()} />);
    expect(await screen.findByText('这个门没有导入任何 Operation')).toBeTruthy();
  });
});

// Review N1 of #567: an Operation whose definition declares a param only the gate sets can never be
// published, so a reclassification of it would only leave one more stuck draft behind.
describe('OnboardingWizardReview — an Operation held back for a gate-owned param', () => {
  it('is marked with its params and offers no reclassification; the others still do', async () => {
    const held = operationObject('gk-1', 'orders.lookup');
    const heldDraft = { ...held, properties: { ...held.properties, status: 'draft' } };
    const http = {
      call: vi.fn(async (name: string) => {
        if (name === 'search') return { items: [operationObject('gk-1', 'stock.get'), heldDraft] };
        if (name === 'list_operations') {
          return {
            items: [
              { gatekeeperId: 'gk-1', name: 'stock.get', status: 'published' },
              {
                gatekeeperId: 'gk-1',
                name: 'orders.lookup',
                status: 'draft',
                gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
              },
            ],
          };
        }
        throw new Error(`unscripted ${name}`);
      }) as CapabilityCaller['call'],
    } as CapabilityCaller;
    render(<OnboardingWizardReview http={http} gatekeeperId="gk-1" onDone={vi.fn()} />);
    const mark = await screen.findByTestId('wizard-review-held');
    expect(mark.textContent).toContain('Authorization（请求头）');
    const rows = screen.getAllByTestId('wizard-review-row');
    const heldRow = rows.find((row) => row.textContent?.includes('orders.lookup')) as HTMLElement;
    const okRow = rows.find((row) => row.textContent?.includes('stock.get')) as HTMLElement;
    expect(within(heldRow).queryByRole('button', { name: '提议重分类' })).toBeNull();
    expect(within(heldRow).getByTestId('wizard-review-reclassify-held').textContent).toContain(
      '不能重分类',
    );
    expect(within(okRow).getByRole('button', { name: '提议重分类' })).toBeTruthy();
  });
});

// Decision 2026-10-09 "二次确认": the reclassification's publish is refused while its definition
// carries suspected credentials; the row asks, and the next Submit carries the confirmation.
describe('OnboardingWizardReview — credential confirmation', () => {
  it('a refused publish keeps the draft, opens the question, and the confirmed Submit publishes', async () => {
    const calls: { name: string; params: unknown }[] = [];
    const http = {
      call: vi.fn(async (name: string, p?: unknown) => {
        if (name === 'search') return { items: [operationObject('gk-1', 'rotate_key')] };
        calls.push({ name, params: p });
        if (name === 'propose_operation') return { governanceChange: null };
        if (name === 'publish_operation') {
          if (calls.filter((c) => c.name === 'publish_operation').length === 1) {
            throw new HttpError(
              'capability_error',
              'operation carries suspected credentials',
              'credentials_review_required',
              {
                subject: 'operation',
                suspectedSecretValues: 1,
              },
            );
          }
          return { status: 'published' };
        }
        throw new Error(`unscripted ${name}`);
      }) as CapabilityCaller['call'],
    } as CapabilityCaller;
    render(<OnboardingWizardReview http={http} gatekeeperId="gk-1" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.click(within(form).getByRole('button', { name: /提交/ }));

    const review = await within(form).findByTestId('credential-review');
    expect(review.getAttribute('data-count')).toBe('1');
    expect(within(form).getByTestId('wizard-review-draft-kept')).toBeTruthy();
    const submit = within(form).getByRole('button', { name: /提交/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(within(form).getByTestId('credential-review-confirm'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(calls.filter((c) => c.name === 'publish_operation').map((c) => c.params)).toEqual([
        { gatekeeperId: 'gk-1', name: 'rotate_key' },
        { gatekeeperId: 'gk-1', name: 'rotate_key', credentialsReviewed: true },
      ]),
    );
  });

  it('legacy 174: a tick given for one draft never goes out with a different draft', async () => {
    const calls: { name: string; params: unknown }[] = [];
    const digests = ['sha256:d1', 'sha256:d2', 'sha256:d2'];
    let publishes = 0;
    const http = {
      call: vi.fn(async (name: string, p?: unknown) => {
        if (name === 'search') return { items: [operationObject('gk-1', 'rotate_key')] };
        calls.push({ name, params: p });
        if (name === 'propose_operation') {
          return { governanceChange: null, draftDigest: digests.shift() };
        }
        if (name === 'publish_operation') {
          publishes += 1;
          if (publishes <= 2) {
            throw new HttpError(
              'capability_error',
              'operation carries suspected credentials',
              'credentials_review_required',
              { subject: 'operation', suspectedSecretValues: publishes },
            );
          }
          return { status: 'published' };
        }
        throw new Error(`unscripted ${name}`);
      }) as CapabilityCaller['call'],
    } as CapabilityCaller;
    render(<OnboardingWizardReview http={http} gatekeeperId="gk-1" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    const submit = () => fireEvent.click(within(form).getByRole('button', { name: /提交/ }));
    submit();
    await within(form).findByTestId('credential-review');
    fireEvent.click(within(form).getByTestId('credential-review-confirm'));
    // The gate was re-imported in between: this Submit proposes a different draft (d2), so the
    // tick given for d1 is not sent and the kernel asks again, about d2.
    submit();
    await waitFor(() =>
      expect(within(form).getByTestId('credential-review').getAttribute('data-count')).toBe('2'),
    );
    fireEvent.click(within(form).getByTestId('credential-review-confirm'));
    submit();
    await waitFor(() =>
      expect(calls.filter((c) => c.name === 'publish_operation').map((c) => c.params)).toEqual([
        { gatekeeperId: 'gk-1', name: 'rotate_key', draftDigest: 'sha256:d1' },
        { gatekeeperId: 'gk-1', name: 'rotate_key', draftDigest: 'sha256:d2' },
        {
          gatekeeperId: 'gk-1',
          name: 'rotate_key',
          credentialsReviewed: true,
          draftDigest: 'sha256:d2',
        },
      ]),
    );
  });
});

// S11 「门确认不存在」 B-a: a reclassification keeps the definition, so the draft of an Operation
// declaring answers that mean "not there" publishes only with the person's confirmation — asked
// before Submit, since the definition says so.
describe('OnboardingWizardReview — confirming the answers that mean “not there”', () => {
  it('asks before Submit, keeps it disabled until ticked, and the publish carries the confirmation', async () => {
    const calls: { name: string; params: unknown }[] = [];
    const declaring = operationObject('gk-1', 'record_get');
    const http = {
      call: vi.fn(async (name: string, p?: unknown) => {
        if (name === 'search') {
          return {
            items: [
              {
                ...declaring,
                properties: {
                  ...declaring.properties,
                  binding: {
                    kind: 'http',
                    method: 'GET',
                    path: '/records/{id}',
                    absent_statuses: [404],
                  },
                  // A stamp on the published version is never proposed again.
                  absentAnswersReviewedBy: 'p-owner',
                  absentAnswersReviewedAt: '2026-10-24T01:00:00Z',
                },
              },
            ],
          };
        }
        calls.push({ name, params: p });
        if (name === 'propose_operation')
          return { governanceChange: null, draftDigest: 'sha256:r1' };
        if (name === 'publish_operation') return { status: 'published' };
        throw new Error(`unscripted ${name}`);
      }) as CapabilityCaller['call'],
    } as CapabilityCaller;
    render(<OnboardingWizardReview http={http} gatekeeperId="gk-1" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /提议重分类/ }));
    const form = await screen.findByTestId('wizard-review-reclassify-form');
    expect(within(form).getByTestId('operation-absent-review').textContent).toContain(
      '目标回答 404 时',
    );
    const submit = within(form).getByRole('button', { name: /提交/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(within(form).getByTestId('operation-absent-review-confirm'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(calls.filter((c) => c.name === 'publish_operation').map((c) => c.params)).toEqual([
        {
          gatekeeperId: 'gk-1',
          name: 'record_get',
          absentAnswersReviewed: true,
          draftDigest: 'sha256:r1',
        },
      ]),
    );
    const proposed = calls.find((c) => c.name === 'propose_operation')?.params as {
      operation: Record<string, unknown>;
    };
    expect(proposed.operation).not.toHaveProperty('absentAnswersReviewedBy');
    expect(proposed.operation).not.toHaveProperty('absentAnswersReviewedAt');
  });

  it('a tick is for the answers it was given: when the row is read again declaring others, it is cleared', async () => {
    // Review #501 on #757 (P3-2): the rows reload after any row publishes. If the gate re-imported
    // in between and the definition now declares other answers, the tick must not carry over to
    // answers the person never saw.
    const calls: { name: string; params: unknown }[] = [];
    let reimported = false;
    const other = operationObject('gk-1', 'record_list');
    const declaring = operationObject('gk-1', 'record_get');
    const declaringWith = (statuses: number[]): GraphObjectRow => ({
      ...declaring,
      properties: {
        ...declaring.properties,
        binding: { kind: 'http', method: 'GET', path: '/records/{id}', absent_statuses: statuses },
      },
    });
    const http = {
      call: vi.fn(async (name: string, p?: unknown) => {
        if (name === 'search') {
          return { items: [other, declaringWith(reimported ? [404, 410] : [404])] };
        }
        calls.push({ name, params: p });
        if (name === 'propose_operation')
          return { governanceChange: null, draftDigest: 'sha256:r1' };
        if (name === 'publish_operation') {
          // The gate re-imported meanwhile: the next read of the rows sees the new declaration.
          reimported = true;
          return { status: 'published' };
        }
        throw new Error(`unscripted ${name}`);
      }) as CapabilityCaller['call'],
    } as CapabilityCaller;
    render(<OnboardingWizardReview http={http} gatekeeperId="gk-1" onDone={vi.fn()} />);
    const [otherOpen, declaringOpen] = await screen.findAllByRole('button', {
      name: /提议重分类/,
    });
    fireEvent.click(declaringOpen as HTMLElement);
    const declaringForm = await screen.findByTestId('wizard-review-reclassify-form');
    fireEvent.click(within(declaringForm).getByTestId('operation-absent-review-confirm'));
    expect(
      (within(declaringForm).getByRole('button', { name: /提交/ }) as HTMLButtonElement).disabled,
    ).toBe(false);

    // Another row publishes; the rows are read again, and this one now declares 404 or 410.
    fireEvent.click(otherOpen as HTMLElement);
    const forms = await screen.findAllByTestId('wizard-review-reclassify-form');
    const otherForm = forms.find((form) => form !== declaringForm) as HTMLElement;
    fireEvent.click(within(otherForm).getByRole('button', { name: /提交/ }));

    const reread = await screen.findByTestId('wizard-review-reclassify-form');
    await waitFor(() =>
      expect(within(reread).getByTestId('operation-absent-review').textContent).toContain(
        '404 或 410',
      ),
    );
    expect(
      (within(reread).getByTestId('operation-absent-review-confirm') as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (within(reread).getByRole('button', { name: /提交/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.filter((c) => c.name === 'publish_operation').map((c) => c.params)).toEqual([
      { gatekeeperId: 'gk-1', name: 'record_list', draftDigest: 'sha256:r1' },
    ]);
  });
});
