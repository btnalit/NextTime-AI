import type { PlatformGateAddressChangeWire } from '@nexttime/shared';
import { useState } from 'react';
import { useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../../lib/format.js';
import {
  approveGateAddressChangeErrors,
  gateAddressChangeImpactLines,
} from '../../../lib/gate-address-change.js';
import { useT } from '../../../lib/i18n.js';
import { transportKindLabel } from '../../../lib/labels.js';
import { Button } from '../../kit/button.js';
import { Confirm } from '../../kit/confirm.js';
import { ErrorBanner } from '../../kit/error-banner.js';
import { Field, describedBy } from '../../kit/field.js';
import { KeyValue } from '../../kit/key-value.js';
import { SkeletonRows } from '../../kit/skeleton.js';

/** `reject_gate_address_change`'s own bound on `reason` (capabilities.ts). */
export const GATE_ADDRESS_REJECTION_REASON_MAX = 500;

const OPEN_CHANGES: Readonly<Record<string, unknown>> = { status: 'proposed' };

export interface GateAddressChangesProps {
  readonly http: CapabilityCaller;
  /** A move was approved: the gate's address in 自己接入的门 changed — read the list again. */
  readonly onApplied: () => void;
}

/**
 * components/platform/integrations/GateAddressChanges (legacy 701): 集成 → 自己接入的门, above the
 * list — the proposals waiting for a platform administrator to move a gate a workspace connected
 * itself to a new address (`list_gate_address_changes`), each with 批准 / 驳回. The approval is the
 * point of the flow: the gate keeps its id, so whatever the workspace trusted it with (its
 * published Operations, grants, automatic approvals, the Worker definitions that use it) applies
 * at the new host from then on — each proposal lists that, as its owner saw it when proposing.
 *
 * Addresses show their scheme, host and port only, as the list below does. Nothing renders while
 * no proposal is open.
 */
export function GateAddressChanges({ http, onApplied }: GateAddressChangesProps) {
  const t = useT();
  const changes = useCapabilityList<PlatformGateAddressChangeWire>(
    http,
    'list_gate_address_changes',
    OPEN_CHANGES,
    { autoLoadAll: true },
  );

  if (changes.state.status === 'loading') {
    return (
      <SkeletonRows
        count={1}
        label={t('正在读取待审批的地址变更…', 'Reading the moves waiting for approval')}
        testId="gate-address-changes-loading"
      />
    );
  }
  if (changes.state.status === 'error') {
    return (
      <ErrorBanner
        error={changes.state.error}
        title={t('无法读取待审批的地址变更', 'Could not read the moves waiting for approval')}
        onRetry={() => void changes.reload()}
        testId="gate-address-changes-error"
      />
    );
  }
  const items = changes.state.data.items.filter((change) => change.status === 'proposed');
  if (items.length === 0) return null;

  function settled(id: string): void {
    changes.mutate((data) => ({ ...data, items: data.items.filter((row) => row.id !== id) }));
  }

  return (
    <section className="stack-s" data-testid="gate-address-changes">
      <span className="field-label">
        {t(
          `等你审批的换地址申请（${items.length}）`,
          `Moves waiting for your approval (${items.length})`,
        )}
      </span>
      <p className="text-3 text-small" style={{ margin: 0 }}>
        {t(
          '工作区所有者申请把自己接入的门换到新地址。门换过去还是同一扇门，下面列出的会全部跟过去。批准时会用新地址的连接密钥再问一次那里的门，它提供的 Operation 和申请时不一样就不会生效。24 小时内没人审批就过期。',
          'A workspace owner asks to move a gate they connected themselves to a new address. It stays the same gate, so everything listed below follows it. Approving asks the gate at the new address once more, with its connection secret; if it no longer offers the Operations it offered when proposed, nothing changes. A move nobody decides within 24 hours expires.',
        )}
      </p>
      <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((change) => (
          <GateAddressChangeRow
            key={change.id}
            http={http}
            change={change}
            onApproved={() => {
              settled(change.id);
              onApplied();
            }}
            onRejected={() => settled(change.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function GateAddressChangeRow({
  http,
  change,
  onApproved,
  onRejected,
}: {
  readonly http: CapabilityCaller;
  readonly change: PlatformGateAddressChangeWire;
  readonly onApproved: () => void;
  readonly onRejected: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const rowId = change.id;
  const reasonId = `gate-address-change-reason-${rowId}`;
  const impact = gateAddressChangeImpactLines(change.impact, t);
  const target = `${change.workspaceName} · ${change.target}`;

  function openChange(next: 'approve' | 'reject', isOpen: boolean): void {
    setOpen(isOpen ? next : null);
    if (!isOpen) setReason('');
  }

  return (
    // UX acceptance of #1158 (P3): at phone width 批准 / 驳回 take their own line under the move.
    <li
      className="data-row gate-address-change-row"
      data-testid={`gate-address-change-row-${rowId}`}
    >
      <div className="data-row-main stack-s">
        <div className="data-row-title">
          {/* UX acceptance of #1158 (P2): which gate — a workspace can connect several itself — as
              the confirm names it. */}
          <strong data-testid={`gate-address-change-title-${rowId}`}>{target}</strong>
          <span className="tag">{transportKindLabel(change.connector, t)}</span>
          {change.suspended ? (
            <span
              className="tag"
              title={t(
                '平台暂停了这个门；批准后它在新地址仍然暂停',
                'The platform suspended this gate; once moved it stays suspended at the new address',
              )}
              data-testid={`gate-address-change-suspended-${rowId}`}
            >
              {t('已暂停', 'Suspended')}
            </span>
          ) : null}
        </div>
        <KeyValue
          items={[
            { label: t('现在', 'Now'), value: change.fromEndpoint, mono: true },
            { label: t('换到', 'Moving to'), value: change.toEndpoint, mono: true },
            {
              label: t('申请人', 'Proposed by'),
              value: (
                <>
                  {change.proposedByName ?? t('工作区所有者', 'A workspace owner')}
                  {' · '}
                  <time dateTime={change.createdAt} title={formatDateTime(change.createdAt)}>
                    {formatRelative(change.createdAt)}
                  </time>
                </>
              ),
            },
            {
              label: t('过期于', 'Expires'),
              value: (
                <time dateTime={change.expiresAt} title={formatDateTime(change.expiresAt)}>
                  {formatRelative(change.expiresAt)}
                </time>
              ),
            },
          ]}
        />
        <ul
          className="stack-s text-small"
          style={{ margin: 0, paddingLeft: '1.2em' }}
          data-testid={`gate-address-change-impact-${rowId}`}
        >
          {impact.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div className="data-row-trailing">
        <Confirm
          tier="medium"
          open={open === 'approve'}
          onOpenChange={(isOpen) => openChange('approve', isOpen)}
          anchor={
            <Button
              variant="primary"
              size="s"
              onClick={() => openChange('approve', true)}
              data-testid={`gate-address-change-approve-${rowId}`}
            >
              {t('批准', 'Approve')}
            </Button>
          }
          title={t(`批准换到 ${change.toEndpoint}`, `Approve the move to ${change.toEndpoint}`)}
          description={t(
            '先用新地址的连接密钥再问一次那里的门；它提供的 Operation 和申请时一致，内核从下一次调用起改用新地址。',
            'The gate at the new address is asked once more, with its connection secret; if it offers the Operations it offered when proposed, the kernel calls the new address from the next call on.',
          )}
          target={target}
          impact={impact}
          confirmLabel={t('批准', 'Approve')}
          errorOverrides={approveGateAddressChangeErrors(t)}
          onConfirm={async () => {
            await http.call<PlatformGateAddressChangeWire>('approve_gate_address_change', {
              workspaceId: change.workspaceId,
              id: change.id,
              previewDigest: change.previewDigest,
            });
            setOpen(null);
            onApproved();
          }}
          testId={`gate-address-change-approve-confirm-${rowId}`}
        />
        <Confirm
          tier="medium"
          danger
          open={open === 'reject'}
          onOpenChange={(isOpen) => openChange('reject', isOpen)}
          anchor={
            <Button
              variant="ghost"
              size="s"
              onClick={() => openChange('reject', true)}
              data-testid={`gate-address-change-reject-${rowId}`}
            >
              {t('驳回', 'Reject')}
            </Button>
          }
          title={t(`驳回换到 ${change.toEndpoint}`, `Reject the move to ${change.toEndpoint}`)}
          target={target}
          impact={[
            t('门留在现在的地址', 'The gate stays where it is'),
            // UX acceptance of #1158 (P2): not "works as before" when both addresses reach the
            // same gate — it holds the new secret and refuses the current address until rotated.
            t(
              '新旧地址是同一扇门、门已经换上新密钥的话，现在的地址要等工作区所有者重新签发连接密钥、放进门之后才恢复',
              'If both addresses reach the same gate and it already holds the new secret, the current address works again only once the workspace owner issues a new connection secret and puts it in the gate',
            ),
            t(
              '工作区要换就重新申请，用新生成的连接密钥',
              'Moving it takes a new proposal, with a new connection secret',
            ),
          ]}
          confirmLabel={t('驳回', 'Reject')}
          onConfirm={async () => {
            const trimmed = reason.trim();
            await http.call<PlatformGateAddressChangeWire>('reject_gate_address_change', {
              workspaceId: change.workspaceId,
              id: change.id,
              ...(trimmed ? { reason: trimmed } : {}),
            });
            setOpen(null);
            setReason('');
            onRejected();
          }}
          testId={`gate-address-change-reject-confirm-${rowId}`}
        >
          <Field
            id={reasonId}
            label={t('原因（可选）', 'Reason (optional)')}
            hint={t(
              '记在这次驳回上，平台审计里能看到。',
              'Kept with this rejection; shown in the platform audit.',
            )}
          >
            <input
              id={reasonId}
              className="input"
              value={reason}
              maxLength={GATE_ADDRESS_REJECTION_REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby={describedBy(reasonId, true, false)}
              data-testid={`gate-address-change-reason-input-${rowId}`}
            />
          </Field>
        </Confirm>
      </div>
    </li>
  );
}
