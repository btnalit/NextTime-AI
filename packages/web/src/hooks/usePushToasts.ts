import { useEffect } from 'react';
import { useToast } from '../components/ui/Toast.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { shortId } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { type NavSection, hrefs, navigate } from '../lib/router.js';
import { labelText, statusChipStyle } from '../lib/status-tone.js';
import { useCanOpen } from './useCanOpen.js';

/**
 * hooks/usePushToasts: turns the three principal-scoped pushes into toasts. `action.pending` is
 * always announced (it asks for a human decision); `action.updated`/`task.updated` are announced
 * only when the reader is not already looking at that section — the page itself shows the change.
 *
 * #541 review N2: the kernel also pushes `action.pending`/`action.updated` to the member an action
 * was requested for, who may not open approvals — for that reader the toast says who decides and
 * carries no action onto a page they cannot read (`hooks/useCanOpen`).
 */
export function usePushToasts(
  pushes: PushSource,
  active: NavSection,
  http: CapabilityCaller | undefined,
): void {
  const toast = useToast();
  const t = useT();
  const canOpen = useCanOpen(http);
  const opensApprovals = canOpen(hrefs.approvals()) !== false;
  useEffect(() => {
    const unsubPending = pushes.onActionPending((event) => {
      toast.push(
        opensApprovals
          ? {
              tone: 'warn',
              key: `action:${event.actionRequestId}`,
              title:
                event.title ||
                t(
                  `待审批：${event.actionKind.label}`,
                  `Approval needed: ${event.actionKind.label}`,
                ),
              description: event.awaitDecision
                ? t('有一个 Worker 在等你决定。', 'A Worker is blocked until you decide.')
                : undefined,
              action: {
                label: t('去审批', 'Review'),
                onClick: () => navigate(hrefs.approval(event.actionRequestId)),
              },
              durationMs: 8000,
            }
          : {
              tone: 'info',
              key: `action:${event.actionRequestId}`,
              title:
                event.title ||
                t(
                  `已提交审批：${event.actionKind.label}`,
                  `Sent for approval: ${event.actionKind.label}`,
                ),
              description: t(
                '等待 operator 或工作区所有者处理；结果会显示在对话里。',
                'Waiting for an operator or the workspace owner; the result shows up in the chat.',
              ),
              durationMs: 8000,
            },
      );
    });
    const unsubUpdated = pushes.onActionUpdated((event) => {
      if (active === 'approvals') return;
      const style = statusChipStyle('actionRequest', event.status);
      toast.push({
        tone: style.tone === 'danger' ? 'danger' : style.tone === 'ok' ? 'ok' : 'info',
        key: `action:${event.id}`,
        title: t(
          `审批请求 ${shortId(event.id)}：${labelText(style, t)}`,
          `Action ${shortId(event.id)}: ${labelText(style, t).toLowerCase()}`,
        ),
        ...(opensApprovals
          ? {
              action: {
                label: t('打开', 'Open'),
                onClick: () => navigate(hrefs.approval(event.id)),
              },
            }
          : {}),
      });
    });
    const unsubTask = pushes.onTaskUpdated((event) => {
      if (active === 'tasks') return;
      const style = statusChipStyle('task', event.status);
      if (style.tone === 'neutral' || style.tone === 'info') return; // queued/running: noise
      toast.push({
        tone: style.tone === 'danger' ? 'danger' : style.tone === 'ok' ? 'ok' : 'warn',
        key: `task:${event.id}`,
        title: t(
          `任务 ${shortId(event.id)}：${labelText(style, t)}`,
          `Task ${shortId(event.id)}: ${labelText(style, t).toLowerCase()}`,
        ),
        action: { label: t('打开', 'Open'), onClick: () => navigate(hrefs.task(event.id)) },
      });
    });
    return () => {
      unsubPending();
      unsubUpdated();
      unsubTask();
    };
  }, [pushes, active, toast, t, opensApprovals]);
}
