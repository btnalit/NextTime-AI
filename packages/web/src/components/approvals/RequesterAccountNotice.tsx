import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';

/**
 * Legacy 513: a pending request whose requester has not connected their own account on its gate
 * (`onBehalfOfAccount: 'not_connected'`, asked of the gate when a person reads the request) — said
 * before anyone approves, since the gate would refuse the call for want of a credential and no
 * approval changes that. Only the requester can connect it, so the notice says who and where.
 */
export function RequesterAccountNotice({
  own,
  testId,
}: {
  /** The reader is the requester. */
  readonly own: boolean;
  readonly testId: string;
}) {
  const t = useT();
  return (
    <Notice tone="warn" testId={testId}>
      {own
        ? t(
            '你还没有在这个门上连接自己的账户：即使批准，门也会因为没有可用凭证拒绝这次调用。请先在「系统与授权」里给这个门「录入我的凭证」。',
            'You have not connected your own account on this gate: even once approved, the gate would refuse the call for want of a credential. Use “Enter my credential” for the gate in Systems & access first.',
          )
        : t(
            '申请人还没有在这个门上连接自己的账户：批准后门会因为没有可用凭证拒绝这次调用。可以请申请人先在「系统与授权」里给这个门「录入我的凭证」，再审批。',
            'The requester has not connected their own account on this gate: once approved, the gate would refuse the call for want of a credential. Ask the requester to use “Enter my credential” for the gate in Systems & access first, then decide.',
          )}{' '}
      <a href={hrefs.systems()} data-testid={`${testId}-connect`}>
        {t('去「系统与授权」', 'Open Systems & access')}
      </a>
    </Notice>
  );
}
