import { useEffect } from 'react';
import { useToast } from '../components/ui/Toast.js';
import type { PushSource } from '../lib/clients.js';
import { humanizeKind, shortId } from '../lib/format.js';
import { type NavSection, hrefs, navigate } from '../lib/router.js';
import { statusChipStyle } from '../lib/status-tone.js';

/**
 * hooks/usePushToasts: turns the three principal-scoped pushes into toasts. `action.pending` is
 * always announced (it asks for a human decision); `action.updated`/`task.updated` are announced
 * only when the reader is not already looking at that section — the page itself shows the change.
 */
export function usePushToasts(pushes: PushSource, active: NavSection): void {
  const toast = useToast();
  useEffect(() => {
    const unsubPending = pushes.onActionPending((event) => {
      toast.push({
        tone: 'warn',
        key: `action:${event.actionRequestId}`,
        title: event.title || `Approval needed: ${event.actionKind.label}`,
        description: event.awaitDecision ? 'A Worker is blocked until you decide.' : undefined,
        action: { label: 'Review', onClick: () => navigate(hrefs.approval(event.actionRequestId)) },
        durationMs: 8000,
      });
    });
    const unsubUpdated = pushes.onActionUpdated((event) => {
      if (active === 'approvals') return;
      const style = statusChipStyle('actionRequest', event.status);
      toast.push({
        tone: style.tone === 'danger' ? 'danger' : style.tone === 'ok' ? 'ok' : 'info',
        key: `action:${event.actionRequestId}`,
        title: `Action ${shortId(event.actionRequestId)}: ${style.label.toLowerCase()}`,
        action: { label: 'Open', onClick: () => navigate(hrefs.approval(event.actionRequestId)) },
      });
    });
    const unsubTask = pushes.onTaskUpdated((event) => {
      if (active === 'tasks') return;
      const style = statusChipStyle('task', event.status);
      if (style.tone === 'neutral' || style.tone === 'info') return; // queued/running: noise
      toast.push({
        tone: style.tone === 'danger' ? 'danger' : style.tone === 'ok' ? 'ok' : 'warn',
        key: `task:${event.taskId}`,
        title: `Task ${shortId(event.taskId)} ${humanizeKind(style.label).toLowerCase()}`,
        action: { label: 'Open', onClick: () => navigate(hrefs.task(event.taskId)) },
      });
    });
    return () => {
      unsubPending();
      unsubUpdated();
      unsubTask();
    };
  }, [pushes, active, toast]);
}
