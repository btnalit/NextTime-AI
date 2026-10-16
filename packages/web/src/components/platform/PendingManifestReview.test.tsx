// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('UX acceptance of #573 P2: a refused Operation whose new definition declares a gate-owned param is not promised back by adopting and aligning', () => {
    render(
      <PendingManifestReview
        http={{ call: vi.fn() } as unknown as CapabilityCaller}
        gateId="gate-1"
        displayName="Orders"
        pending={{
          digest: 'digest-3',
          announcedAt: '2026-10-15T00:00:00.000Z',
          operationCount: 2,
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
            {
              name: 'orders.list',
              before: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              after: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              direction: 'neutral',
              otherChangedFields: ['binding'],
            },
          ],
          refusedOperations: ['orders.list', 'orders.lookup'],
        }}
        enablingWorkspaces={[{ id: 'ws-1', name: 'Acme' }]}
        enabledWorkspaceCount={1}
        onConfirmed={vi.fn()}
      />,
    );
    const notice = screen.getByTestId('gate-instance-pending-manifest-notice');
    expect(notice.textContent).toContain('对 orders.list 的调用会被拒绝');
    expect(notice.textContent).toContain(
      '对 orders.lookup 的调用会被拒绝，而且采用和对齐都恢复不了',
    );
    fireEvent.click(screen.getByTestId('gate-instance-pending-manifest-review'));
    const workspaces = screen.getByTestId('gate-instance-pending-manifest-workspaces');
    expect(workspaces.textContent).toContain('对 orders.list 的调用才会恢复');
    expect(workspaces.textContent).not.toContain('orders.lookup');
    expect(screen.getByTestId('gate-instance-pending-manifest-held').textContent).toContain(
      '要等门的维护者去掉这些参数',
    );
  });
  it('review #501 on #577 ③: an Operation the gate dropped is not promised back either; UX P3: no half-width space between Chinese sentences', () => {
    render(
      <PendingManifestReview
        http={{ call: vi.fn() } as unknown as CapabilityCaller}
        gateId="gate-1"
        displayName="Orders"
        pending={{
          digest: 'digest-4',
          announcedAt: '2026-10-15T00:00:00.000Z',
          operationCount: 1,
          added: [],
          removed: [
            {
              name: 'orders.cancel',
              mode: 'execute',
              blastRadius: 'medium',
              autoApprovable: false,
              readOnlyHint: null,
              destructiveHint: null,
              idempotentHint: null,
            },
          ],
          changed: [
            {
              name: 'orders.list',
              before: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              after: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              direction: 'neutral',
              otherChangedFields: ['binding'],
            },
          ],
          refusedOperations: ['orders.cancel', 'orders.list'],
        }}
        enablingWorkspaces={[{ id: 'ws-1', name: 'Acme' }]}
        enabledWorkspaceCount={1}
        onConfirmed={vi.fn()}
      />,
    );
    const notice = screen.getByTestId('gate-instance-pending-manifest-notice');
    expect(notice.textContent).toContain(
      '对 orders.list 的调用会被拒绝。门已经不再提供 orders.cancel，对它的调用会被拒绝，采用和对齐都恢复不了',
    );
    fireEvent.click(screen.getByTestId('gate-instance-pending-manifest-review'));
    const workspaces = screen.getByTestId('gate-instance-pending-manifest-workspaces');
    expect(workspaces.textContent).toContain('对 orders.list 的调用才会恢复');
    expect(workspaces.textContent).not.toContain('orders.cancel');
    expect(screen.getByTestId('gate-instance-pending-manifest-dropped').textContent).toContain(
      '采用后它会从清单里移除',
    );
  });

  it('UX acceptance of #577 P3: with only unrecoverable Operations, 「门已经在按新清单运行。」 runs straight into the next sentence', () => {
    render(
      <PendingManifestReview
        http={{ call: vi.fn() } as unknown as CapabilityCaller}
        gateId="gate-1"
        displayName="Orders"
        pending={{
          digest: 'digest-5',
          announcedAt: '2026-10-15T00:00:00.000Z',
          operationCount: 0,
          added: [],
          removed: [
            {
              name: 'orders.cancel',
              mode: 'execute',
              blastRadius: 'medium',
              autoApprovable: false,
              readOnlyHint: null,
              destructiveHint: null,
              idempotentHint: null,
            },
          ],
          changed: [],
          refusedOperations: ['orders.cancel'],
        }}
        enablingWorkspaces={[]}
        enabledWorkspaceCount={0}
        onConfirmed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('gate-instance-pending-manifest-notice').textContent).toContain(
      '门已经在按新清单运行。门已经不再提供',
    );
  });
});
