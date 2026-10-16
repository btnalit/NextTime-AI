import type { SelfConnectionWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../../lib/clients.js';

/** `suspend_self_connection`'s own bound on `reason` (capabilities.ts). */
export const SUSPENSION_REASON_MAX = 500;

export interface SelfConnectionSuspensionState {
  /** The 暂停 / 恢复 confirm is open (one at a time — the row shows the one that applies). */
  readonly confirmOpen: boolean;
  readonly onConfirmOpenChange: (open: boolean) => void;
  /** 暂停's optional reason, as typed; trimmed and left out when blank. */
  readonly reason: string;
  readonly setReason: (reason: string) => void;
  /** Suspends or resumes, whichever applies to the row now. Throws on failure — `kit/confirm`
   *  shows it inline and stays open. */
  readonly apply: () => Promise<void>;
}

/**
 * components/platform/integrations/useSelfConnectionSuspension: one self-connected gate's 暂停 /
 * 恢复 (P0b, STATUS leftover 118 remainder ①) — the platform's per-connection cut-off for a gate
 * a workspace connected itself. Renders nothing; the row replaces itself with the returned
 * `SelfConnectionWire`, so 状态 / 暂停人 / 原因 come from the kernel, never from local guesses.
 */
export function useSelfConnectionSuspension(
  http: CapabilityCaller,
  connection: SelfConnectionWire,
  onChanged: (updated: SelfConnectionWire) => void,
): SelfConnectionSuspensionState {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');

  function onConfirmOpenChange(open: boolean): void {
    setConfirmOpen(open);
    if (!open) setReason('');
  }

  async function apply(): Promise<void> {
    const target = { workspaceId: connection.workspaceId, gatekeeperId: connection.gatekeeperId };
    const trimmed = reason.trim();
    const updated =
      connection.suspendedAt === null
        ? await http.call<SelfConnectionWire>('suspend_self_connection', {
            ...target,
            ...(trimmed ? { reason: trimmed } : {}),
          })
        : await http.call<SelfConnectionWire>('resume_self_connection', target);
    onChanged(updated);
    setReason('');
  }

  return { confirmOpen, onConfirmOpenChange, reason, setReason, apply };
}
