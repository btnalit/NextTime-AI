import { useEffect } from 'react';
import { useToast } from '../components/ui/Toast.js';
import type { PushSource } from '../lib/clients.js';
import { humanizeKind, shortId } from '../lib/format.js';
import { type NavSection, hrefs, navigate } from '../lib/router.js';
import { type ChipStyle, statusChipStyle } from '../lib/status-tone.js';

/** `actionRequest`/`task` are still English-only machines (out of this lane's scope), so this is
 *  always the plain-string branch at runtime — narrows `ChipStyle.label`'s S8 W1-A9 union type for
 *  the toast copy below, which stays English either way. */
function chipLabelText(label: ChipStyle['label']): string {
  return typeof label === 'string' ? label : label.en;
}

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
        key: `action:${event.id}`,
        title: `Action ${shortId(event.id)}: ${chipLabelText(style.label).toLowerCase()}`,
        action: { label: 'Open', onClick: () => navigate(hrefs.approval(event.id)) },
      });
    });
    const unsubTask = pushes.onTaskUpdated((event) => {
      if (active === 'tasks') return;
      const style = statusChipStyle('task', event.status);
      if (style.tone === 'neutral' || style.tone === 'info') return; // queued/running: noise
      toast.push({
        tone: style.tone === 'danger' ? 'danger' : style.tone === 'ok' ? 'ok' : 'warn',
        key: `task:${event.id}`,
        title: `Task ${shortId(event.id)} ${humanizeKind(chipLabelText(style.label)).toLowerCase()}`,
        action: { label: 'Open', onClick: () => navigate(hrefs.task(event.id)) },
      });
    });
    return () => {
      unsubPending();
      unsubUpdated();
      unsubTask();
    };
  }, [pushes, active, toast]);
}
