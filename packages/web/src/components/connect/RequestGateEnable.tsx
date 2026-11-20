import type { AvailableGateInstanceWire, ConnectionRequestWire } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { cancelConnectionRequestOverrides } from '../../lib/connections.js';
import type { ErrorOverrides } from '../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { InlineError } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';

/** The reader's own open request to enable an instance, as `list_available_gate_instances` reads
 *  it back (`myEnableRequest`). */
export type MyEnableRequest = NonNullable<AvailableGateInstanceWire['myEnableRequest']>;

export interface RequestGateEnableProps {
  readonly http: CapabilityCaller;
  readonly gateId: string;
  readonly gateName: string;
  /** What the server last said (`myEnableRequest` on the catalog row): the source of truth, so
   *  「已申请」 survives a refresh and a request withdrawn or answered elsewhere goes away. */
  readonly myEnableRequest: MyEnableRequest | undefined;
  /** The caller keeps its catalog row in step with what this control just did. */
  readonly onChange?: (next: MyEnableRequest | undefined) => void;
  /** One line for a table cell or card (the catalog row); otherwise a notice that says how it goes. */
  readonly compact?: boolean;
  readonly testId: string;
}

/**
 * components/connect/RequestGateEnable (legacy 254): where a reader who is not the workspace owner
 * would enable a platform gate instance, they ask the owner to (`request_gate_instance_enable`) —
 * a request the owner sees in 「系统与授权 → 连接申请」 and answers by enabling the instance. Before
 * this there was only a sentence to copy to the owner (`AskOwnerToEnable`, still what a role that
 * may not ask sees). The reader's open request reads back from the server; 「撤回」 asks first and
 * withdraws it (`cancel_connection_request`). Asking again while one is open returns that one.
 */
export function RequestGateEnable({
  http,
  gateId,
  gateName,
  myEnableRequest,
  onChange,
  compact = false,
  testId,
}: RequestGateEnableProps) {
  const t = useT();
  const [current, setCurrent] = useState<MyEnableRequest | undefined>(myEnableRequest);
  const [submitting, setSubmitting] = useState(false);
  const [askError, setAskError] = useState<unknown>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // A new read from the server (a refresh, the launcher's poll) replaces what this control holds.
  const readId = myEnableRequest?.id;
  const readAt = myEnableRequest?.requestedAt;
  useEffect(() => {
    setCurrent(
      readId !== undefined && readAt !== undefined
        ? { id: readId, requestedAt: readAt }
        : undefined,
    );
  }, [readId, readAt]);

  async function ask(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setAskError(null);
    try {
      const request = await http.call<ConnectionRequestWire>('request_gate_instance_enable', {
        gateId,
      });
      const next = { id: request.id, requestedAt: request.requestedAt };
      setCurrent(next);
      onChange?.(next);
    } catch (err) {
      setAskError(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function withdraw(): Promise<void> {
    if (current === undefined) return;
    // A refusal stays in the confirm (already enabled or declined: refresh to see it).
    await http.call('cancel_connection_request', { connectionRequestId: current.id });
    setCurrent(undefined);
    onChange?.(undefined);
  }

  const requestedAt =
    current === undefined ? null : (
      <time
        className="text-3 text-small"
        dateTime={current.requestedAt}
        title={formatDateTime(current.requestedAt)}
        data-testid={`${testId}-requested-at`}
      >
        {formatRelative(current.requestedAt, t)}
      </time>
    );
  const control =
    current === undefined ? (
      <Button
        variant="secondary"
        size="s"
        disabled={submitting}
        aria-busy={submitting || undefined}
        onClick={() => void ask()}
        data-testid={`${testId}-ask`}
      >
        {submitting ? t('正在申请…', 'Asking…') : t('申请启用', 'Ask to enable')}
      </Button>
    ) : (
      <Confirm
        tier="medium"
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        anchor={
          <Button
            variant="ghost"
            size="s"
            onClick={() => setConfirmOpen(true)}
            data-testid={`${testId}-withdraw`}
          >
            {t('撤回', 'Withdraw')}
          </Button>
        }
        title={t('撤回启用申请', 'Withdraw the enable request')}
        description={t(
          '所有者那里不再有这条申请，这个门实例在本工作区仍未启用。以后需要时可以再申请。',
          'The owner no longer sees the request, and the instance stays not enabled here. You can ask again later.',
        )}
        target={gateName}
        confirmLabel={t('撤回申请', 'Withdraw request')}
        cancelLabel={t('保留', 'Keep')}
        onConfirm={withdraw}
        errorOverrides={cancelConnectionRequestOverrides(t)}
        testId={`${testId}-withdraw-confirm`}
      />
    );
  const error = (
    <InlineError error={askError} overrides={askOverrides(t)} testId={`${testId}-error`} />
  );

  if (compact) {
    return (
      <span className="stack-s" data-testid={testId}>
        <span className="row-wrap" style={{ alignItems: 'center' }}>
          <span className="text-2" data-testid={`${testId}-state`}>
            {current === undefined
              ? t('由工作区所有者启用', 'The workspace owner enables it')
              : t('已申请，等所有者启用', 'Asked; waiting for the owner')}
          </span>
          {requestedAt}
          {control}
        </span>
        {error}
      </span>
    );
  }
  return (
    <Notice testId={testId}>
      <span className="stack-s">
        <span data-testid={`${testId}-state`}>
          {current === undefined
            ? t(
                `在本工作区启用「${gateName}」由工作区所有者完成。申请后，所有者会在「系统与授权 → 连接申请」里看到它；启用并授权给你之后，它会出现在你的「系统与授权」里。`,
                `The workspace owner enables “${gateName}” in this workspace. Once you ask, the owner sees it under Systems & access → Connection requests; once it is enabled and granted to you, it shows up under Systems & access.`,
              )
            : t(
                `你已申请在本工作区启用「${gateName}」，等工作区所有者启用。启用并授权给你之后，它会出现在你的「系统与授权」里。`,
                `You asked for “${gateName}” to be enabled in this workspace; it waits for the workspace owner. Once it is enabled and granted to you, it shows up under Systems & access.`,
              )}
        </span>
        <span className="row-wrap" style={{ alignItems: 'center' }}>
          {requestedAt}
          {control}
        </span>
        {error}
      </span>
    </Notice>
  );
}

/** Why the kernel would not take the request, in this place's words: the reasons it also refuses
 *  the owner's enable, and an instance this workspace already enabled. */
function askOverrides(t: Translate): ErrorOverrides {
  return {
    gate_already_enabled: t(
      '本工作区已经启用了这个门实例，刷新后就能看到。',
      'This workspace has already enabled the instance; refresh to see it.',
    ),
    gate_not_enabled: t(
      '平台侧现在没有启用这个门实例，所有者暂时也启用不了，所以没有提交申请。',
      'The platform has not enabled this instance right now, so the owner could not enable it either; nothing was asked.',
    ),
    connector_not_preset: t(
      '这个门实例已不再向工作区开放（接入包不是平台预置），没有提交申请。',
      'This instance is no longer offered to workspaces (its connector is not platform preset); nothing was asked.',
    ),
    gate_not_found: t(
      '平台目录里已经没有这个门实例，没有提交申请。',
      'The platform catalog no longer has this instance; nothing was asked.',
    ),
  };
}
