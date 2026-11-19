import { OPERATION_BINDING_KEYS, type PendingGateManifestWire } from '@nexttime/shared';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { LangProvider } from '../../lib/i18n.js';
import { BINDING_FIELD_LABELS } from '../../lib/labels.js';
import { governanceFields } from '../connect/governance-fixtures.test-helpers.js';
import { PendingManifestReview } from './PendingManifestReview.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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
              before: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
              after: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
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
              before: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
              after: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
              direction: 'neutral',
              otherChangedFields: ['params_schema'],
              gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
            },
            {
              name: 'orders.list',
              before: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
              after: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
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
              before: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
              after: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
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

  describe('legacy 477: the answers that mean "does not exist"', () => {
    type Change = PendingGateManifestWire['changed'][number];
    const observe = governanceFields({ mode: 'observe', blastRadius: 'low', autoApprovable: true });
    function renderChange(change: Partial<Change>, added: PendingGateManifestWire['added'] = []) {
      render(
        <LangProvider>
          <PendingManifestReview
            http={{ call: vi.fn() } as unknown as CapabilityCaller}
            gateId="gate-1"
            displayName="Orders"
            pending={{
              digest: 'digest-477',
              announcedAt: '2026-10-15T00:00:00.000Z',
              operationCount: 1,
              added,
              removed: [],
              changed:
                Object.keys(change).length === 0
                  ? []
                  : [
                      {
                        name: 'orders.lookup',
                        before: observe,
                        after: observe,
                        direction: 'neutral',
                        otherChangedFields: ['binding'],
                        ...change,
                      },
                    ],
              refusedOperations: [],
            }}
            enablingWorkspaces={[]}
            enabledWorkspaceCount={0}
            onConfirmed={vi.fn()}
          />
        </LangProvider>,
      );
      return screen.getByTestId('gate-instance-pending-manifest').textContent ?? '';
    }

    it('an added Operation says what it would read as absent', () => {
      const text = renderChange({}, [
        {
          name: 'orders.get',
          mode: 'observe',
          blastRadius: 'low',
          autoApprovable: true,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          absentAnswers: { statuses: [404] },
        },
      ]);
      expect(text).toMatch(/orders\.get \(.*目标系统回答 404 时记为“不存在”\)/);
    });

    it('a changed one names the keys of its call target that changed, and the declaration before and after', () => {
      const text = renderChange({
        bindingChangedFields: ['absent_statuses', 'path'],
        absentAnswers: { before: null, after: { statuses: [404, 410] } },
      });
      expect(text).toContain('orders.lookup 的定义变了：调用目标（表示不存在的回答、路径）');
      expect(text).toContain(
        'orders.lookup 新声明：目标系统回答 404 或 410 时，表示要查的东西不存在，观察记为“不存在”，不算调用失败',
      );
    });

    it('a dropped declaration says such an answer now fails the call', () => {
      const text = renderChange({
        bindingChangedFields: ['absent_exit_codes'],
        absentAnswers: { before: { exitCodes: [4] }, after: null },
      });
      expect(text).toContain(
        'orders.lookup 不再声明表示不存在的回答：原来命令以退出码 4 结束时记为“不存在”，按新定义算调用失败',
      );
    });

    it('a changed declaration says both', () => {
      const text = renderChange({
        bindingChangedFields: ['absent_statuses'],
        absentAnswers: { before: { statuses: [404] }, after: { statuses: [404, 410] } },
      });
      expect(text).toContain(
        'orders.lookup 表示不存在的回答变了：原来是目标系统回答 404 时，现在是目标系统回答 404 或 410 时',
      );
    });

    it('review #501 on #1485 O2: a reordered declaration is said to mean the same', () => {
      const text = renderChange({
        bindingChangedFields: ['absent_statuses'],
        absentAnswers: { before: { statuses: [404, 410] }, after: { statuses: [410, 404] } },
      });
      expect(text).toContain(
        'orders.lookup 表示不存在的回答只换了顺序（目标系统回答 410 或 404 时），含义不变',
      );
      expect(text).not.toContain('变了：原来是');
    });

    it('a call-target change without the keys keeps the plain field name', () => {
      const text = renderChange({ otherChangedFields: ['binding', 'params_schema'] });
      expect(text).toContain('orders.lookup 的定义变了：调用目标、参数定义');
    });

    it('in English the keys go in parentheses, lower-case', () => {
      localStorage.setItem('nexttime.lang', 'en');
      const text = renderChange({
        bindingChangedFields: ['absent_statuses', 'path'],
        absentAnswers: { before: { statuses: [404] }, after: null },
      });
      expect(text).toContain(
        'orders.lookup definition changed: Call target (answers that mean absent, path)',
      );
      expect(text).toContain(
        'orders.lookup: no longer declares answers that mean absent, so what it recorded as “not there” (when the target answers 404) is a failed call under the new definition',
      );
    });

    it('every key a binding can carry has words', () => {
      for (const key of OPERATION_BINDING_KEYS)
        expect(Object.hasOwn(BINDING_FIELD_LABELS, key)).toBe(true);
    });
  });
});
