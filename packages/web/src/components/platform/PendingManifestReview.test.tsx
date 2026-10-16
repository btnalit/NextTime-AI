// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { PendingManifestReview } from './PendingManifestReview.js';

afterEach(cleanup);

describe('PendingManifestReview', () => {
  it('UX acceptance of #567 P3: an added entry that declares a gate-owned param says it cannot be published, before it is adopted', () => {
    render(
      <PendingManifestReview
        http={{ call: vi.fn() } as unknown as CapabilityCaller}
        gateId="gate-1"
        displayName="Orders"
        pending={{
          digest: 'digest-1',
          announcedAt: '2026-10-15T00:00:00.000Z',
          operationCount: 2,
          added: [
            {
              name: 'orders.lookup',
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
            },
            {
              name: 'orders.list',
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
            },
          ],
          removed: [],
          changed: [],
          refusedOperations: [],
        }}
        enablingWorkspaces={[]}
        enabledWorkspaceCount={0}
        onConfirmed={vi.fn()}
      />,
    );
    const review = screen.getByTestId('gate-instance-pending-manifest');
    expect(review.textContent).toContain(
      '发布不了：声明了只能由门自己设置的参数 Authorization（请求头）',
    );
    expect(review.textContent?.match(/发布不了/g)).toHaveLength(1);
  });

  it('review #501 on #571 ③: a changed entry that now declares a gate-owned param is marked too', () => {
    render(
      <PendingManifestReview
        http={{ call: vi.fn() } as unknown as CapabilityCaller}
        gateId="gate-1"
        displayName="Orders"
        pending={{
          digest: 'digest-2',
          announcedAt: '2026-10-15T00:00:00.000Z',
          operationCount: 1,
          added: [],
          removed: [],
          changed: [
            {
              name: 'orders.lookup',
              before: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              after: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              direction: 'neutral',
              otherChangedFields: ['params_schema'],
              gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
            },
          ],
          refusedOperations: ['orders.lookup'],
        }}
        enablingWorkspaces={[]}
        enabledWorkspaceCount={0}
        onConfirmed={vi.fn()}
      />,
    );
    const review = screen.getByTestId('gate-instance-pending-manifest');
    expect(review.textContent).toContain(
      'orders.lookup 发布不了：新定义声明了只能由门自己设置的参数 Authorization（请求头）',
    );
  });
});
