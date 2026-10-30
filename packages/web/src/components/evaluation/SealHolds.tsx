import {
  EVAL_SEAL_HIT_PLACE_VALUES,
  EVAL_SEAL_HOLD_PLACE_KEY,
  EVAL_SEAL_HOLD_THRESHOLD,
  EVAL_SEAL_HOLD_WINDOW_HOURS,
  type EvalSealHitPlace,
  type EvalSealHoldWire,
} from '@nexttime/shared';
import { useCallback, useRef, useState } from 'react';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import { auditHref } from '../../lib/audit.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field, describedBy } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { Textarea } from '../kit/textarea.js';
import { useFocusAfterChange, useLoadWhen } from './hooks.js';

/** The seal's active pauses (`list_eval_seal_holds{status:'active'}`), read once the reader's role
 *  is known to allow it (the workspace owner or an auditor); `reload` reads them again. */
export function useSealHolds(http: CapabilityCaller): {
  readonly state: ReturnType<typeof useLoadWhen<readonly EvalSealHoldWire[]>>;
  readonly reload: () => void;
} {
  const can = useRoleCan(http);
  const [nonce, setNonce] = useState(0);
  const allowed = can('list_eval_seal_holds') === true;
  const state = useLoadWhen(allowed ? `seal-holds:${nonce}` : null, async () => {
    if (can('list_eval_seal_holds') !== true) return [];
    const page = await http.call<{ items: readonly EvalSealHoldWire[] }>('list_eval_seal_holds', {
      status: 'active',
    });
    return page.items;
  });
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, reload };
}

function placeLabel(place: EvalSealHitPlace, t: Translate): string {
  switch (place) {
    case 'capability_result':
      return t('调用结果', 'call results');
    case 'capability_error':
      return t('调用报错', 'call errors');
    case 'worker_start':
      return t('Worker 启动', 'Worker starts');
  }
}

/** "5 次被拦：调用结果 3 次、Worker 启动 2 次" — where the refusals that opened the pause were, for
 *  the people deciding whether to release it (no agent reads this). */
export function sealHoldHitsLine(hold: EvalSealHoldWire, t: Translate): string {
  const parts = EVAL_SEAL_HIT_PLACE_VALUES.flatMap((place) => {
    const n = hold.places[EVAL_SEAL_HOLD_PLACE_KEY[place]];
    return n > 0 ? [t(`${placeLabel(place, t)} ${n} 次`, `${placeLabel(place, t)} ${n}`)] : [];
  });
  return t(
    `${hold.hits} 次被拦：${parts.join('、')}`,
    `${hold.hits} refusals: ${parts.join(', ')}`,
  );
}

/** Whose agents a pause stopped: the reader's own, the person's name, or the evaluation's own
 *  agents. */
export function sealHoldWho(
  hold: EvalSealHoldWire,
  t: Translate,
  viewerId?: string | null,
): string {
  if (hold.principal.evaluation) return t('评测自己的智能体', 'The evaluation’s own agents');
  if (viewerId !== undefined && viewerId !== null && hold.principal.id === viewerId) {
    return t('你名下的智能体', 'Your own agents');
  }
  const name = hold.principal.displayName ?? t('（未命名）', '(unnamed)');
  return t(`${name} 名下的智能体`, `Agents acting for ${name}`);
}

/**
 * components/evaluation/SealHolds (S10 E3-2c, legacy 514): the evaluation seal's pauses on
 * 治理 → 评测, for the workspace owner and auditors. Every refusal of the seal tells whoever
 * provoked it one bit, so an agent that keeps trying candidate texts could read a held-out case
 * back; at `EVAL_SEAL_HOLD_THRESHOLD` refusals within `EVAL_SEAL_HOLD_WINDOW_HOURS` the kernel
 * pauses every agent acting for that person (or for evaluation) until the owner releases it. This
 * lists each active pause — whose, how many refusals and where, since when — and gives the owner
 * 解除, with a required reason the audit keeps (`release_eval_seal_hold`). Renders nothing while
 * nothing is paused.
 */
export function SealHoldsNotice({
  http,
  holds,
  onReleased,
}: {
  readonly http: CapabilityCaller;
  readonly holds: ReturnType<typeof useSealHolds>;
  /** After a release: the page reads what it started again (an evaluation's queued trials). */
  readonly onReleased: (hold: EvalSealHoldWire) => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const { principalId: viewerId } = useWorkspaceIdentity(http);
  const { state, reload } = holds;
  // Whose pause was released last: said where the row was, and focus moves there — the 解除 that
  // had it leaves with the row (and the whole note with the last row).
  const [released, setReleased] = useState<string | null>(null);
  const [statusRef, focusStatus] = useFocusAfterChange<HTMLOutputElement>();
  const status =
    released !== null ? (
      <output
        ref={statusRef}
        tabIndex={-1}
        className="text-3 text-small"
        style={{ display: 'block' }}
        data-testid="eval-seal-hold-released"
      >
        {t(`已解除：${released}，它们可以再运行了。`, `Released: ${released} may run again.`)}
      </output>
    ) : null;
  if (state.status === 'error') {
    return (
      <ErrorBanner
        error={state.error}
        title={t('无法读取评测防泄漏暂停', 'Could not load the evaluation seal’s pauses')}
        onRetry={reload}
        testId="eval-seal-holds-error"
      />
    );
  }
  if (state.status !== 'ready' || state.data === undefined || state.data.length === 0)
    return status;
  return (
    <>
      {status}
      <Notice tone="warn" testId="eval-seal-holds">
        <div className="stack-s">
          <strong>{t('评测防泄漏暂停了智能体', 'The evaluation seal paused agents')}</strong>
          <span>
            {t(
              `下面这些智能体在 ${EVAL_SEAL_HOLD_WINDOW_HOURS} 小时内 ${EVAL_SEAL_HOLD_THRESHOLD} 次差点拿到评测保留的内容，都被拦下了；反复这样试探能逐字拼出用例原文，所以它们已全部暂停：调用、Worker、对话和评测都不运行，直到工作区所有者解除。`,
              `The agents below were stopped from receiving content reserved for evaluation ${EVAL_SEAL_HOLD_THRESHOLD} times within ${EVAL_SEAL_HOLD_WINDOW_HOURS} hours; probing like that can piece a case’s text back together, so all of them are paused: no call, Worker, chat or evaluation runs until the workspace owner releases them.`,
            )}
          </span>
          <ul className="stack-s" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {state.data.map((hold) => (
              <li key={hold.id} className="row-wrap" data-testid="eval-seal-hold-row">
                <span style={{ fontWeight: 600 }}>{sealHoldWho(hold, t, viewerId)}</span>
                <span className="meta-sep" />
                <span className="tabular" data-testid="eval-seal-hold-hits">
                  {sealHoldHitsLine(hold, t)}
                </span>
                <span className="meta-sep" />
                <time className="text-3" title={formatDateTime(hold.openedAt)}>
                  {t(
                    `${formatRelative(hold.openedAt)}暂停`,
                    `paused ${formatRelative(hold.openedAt)}`,
                  )}
                </time>
                <span className="meta-sep" />
                {/* #838 UX P2-1: the refusals behind this pause — the seal's own rows, acted as
                    whoever it paused. */}
                <RouteLink
                  href={auditHref({
                    actorPrincipalId: hold.principal.id,
                    action: 'evaluation.content_withheld',
                  })}
                  className="link-inline"
                  testId="eval-seal-hold-audit"
                >
                  {t('在审计里看这些拦截', 'See these refusals in the audit trail')}
                </RouteLink>
                {hold.principal.evaluation ? (
                  <span className="text-3 text-small" data-testid="eval-seal-hold-evaluation">
                    {t(
                      '暂停期间不能开始试跑或草稿评测，排队的试跑等到解除后再跑。',
                      'While paused no trial or draft evaluation can start; queued trials wait until it is released.',
                    )}
                  </span>
                ) : null}
                <ReleaseSealHoldConfirm
                  http={http}
                  hold={hold}
                  who={sealHoldWho(hold, t, viewerId)}
                  onReleased={() => {
                    setReleased(sealHoldWho(hold, t, viewerId));
                    focusStatus();
                    reload();
                    onReleased(hold);
                  }}
                  onStale={reload}
                />
              </li>
            ))}
          </ul>
          {can('release_eval_seal_hold') !== false ? null : (
            <span className="text-3 text-small" data-testid="eval-seal-holds-owner-only">
              {t('只有工作区所有者能解除暂停。', 'Only the workspace owner can release a pause.')}
            </span>
          )}
        </div>
      </Notice>
    </>
  );
}

/** The owner's 解除 on one pause: a required reason, kept in the audit trail. A refusal shows in
 *  place (thrown), so the reason typed is not lost; one that says it was released already (409)
 *  re-reads the list once the dialog closes (#838 UX P3). Nothing for a role that may not
 *  release. */
function ReleaseSealHoldConfirm({
  http,
  hold,
  who,
  onReleased,
  onStale,
}: {
  readonly http: CapabilityCaller;
  readonly hold: EvalSealHoldWire;
  readonly who: string;
  readonly onReleased: () => void;
  /** The pause was released meanwhile: read the list again. */
  readonly onStale: () => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const stale = useRef(false);
  const testId = `eval-seal-hold-release-${hold.id}`;
  const reasonId = `${testId}-reason`;
  const trimmed = reason.trim();
  if (can('release_eval_seal_hold') === false) return null;
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setReason('');
          if (stale.current) {
            stale.current = false;
            onStale();
          }
        }
      }}
      anchor={
        <Button
          variant="ghost"
          size="s"
          onClick={() => setOpen(true)}
          data-testid="eval-seal-hold-release"
        >
          {t('解除', 'Release')}
        </Button>
      }
      title={t('解除评测防泄漏暂停', 'Release the evaluation seal’s pause')}
      description={
        <>
          {t('解除前先', 'Before releasing, check ')}
          <RouteLink
            href={auditHref({
              actorPrincipalId: hold.principal.id,
              action: 'evaluation.content_withheld',
            })}
            className="link-inline"
            testId="eval-seal-hold-release-audit"
          >
            {t('在审计里看清是哪些调用被拦下', 'in the audit trail which calls were refused')}
          </RouteLink>
          {t(
            '；如果是某个 Skill 或 Worker 在反复试探，先停用它。解除原因记入审计。',
            '; if a Skill or Worker keeps probing, retire it first. The reason is kept in the audit trail.',
          )}
        </>
      }
      target={who}
      impact={[
        t(
          '这些智能体恢复运行，拦截次数从零重新计算',
          'These agents run again and the refusals are counted afresh',
        ),
        ...(hold.principal.evaluation ? [t('排队中的试跑开始运行', 'Queued trials start')] : []),
      ]}
      confirmLabel={t('解除', 'Release')}
      confirmDisabled={trimmed === ''}
      errorOverrides={{
        conflict: t(
          '这个暂停已经被解除了，什么也没改。关掉后刷新查看。',
          'This pause was released already; nothing was changed. Close this and refresh.',
        ),
      }}
      onConfirm={async () => {
        try {
          await http.call('release_eval_seal_hold', { holdId: hold.id, reason: trimmed });
        } catch (err) {
          if (describeError(err).code === 'conflict') stale.current = true;
          throw err;
        }
        onReleased();
      }}
      testId={testId}
    >
      <Field
        id={reasonId}
        label={t('解除原因', 'Reason')}
        hint={t(
          '必填，记入审计：为什么可以让它们恢复运行',
          'Required — kept in the audit trail: why they may run again',
        )}
        required
      >
        <Textarea
          id={reasonId}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          aria-label={t('解除原因', 'Release reason')}
          aria-required
          aria-describedby={describedBy(reasonId, true, false)}
          data-testid="eval-seal-hold-release-reason"
        />
      </Field>
    </Confirm>
  );
}
