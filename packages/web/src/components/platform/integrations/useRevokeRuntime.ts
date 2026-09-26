import type { ExternalRuntimeWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../../lib/clients.js';

export interface RevokeRuntimeState {
  readonly confirming: boolean;
  readonly setConfirming: (confirming: boolean) => void;
  readonly revoking: boolean;
  readonly error: unknown | null;
  readonly revoke: () => Promise<void>;
}

/**
 * components/platform/integrations/useRevokeRuntime: one external-runtime row's 吊销 Revoke —
 * split out of `PlatformIntegrationsPage`'s `ExternalRuntimeRow` (console redesign P1) because it
 * renders nothing and needs nothing from `components/ui/*`.
 */
export function useRevokeRuntime(
  http: CapabilityCaller,
  runtime: ExternalRuntimeWire,
  onRevoked: () => void,
): RevokeRuntimeState {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  async function revoke(): Promise<void> {
    if (revoking) return;
    setRevoking(true);
    setError(null);
    try {
      await http.call('revoke_external_runtime', {
        workspaceId: runtime.workspaceId,
        sessionId: runtime.sessionId,
      });
      onRevoked();
    } catch (err) {
      setError(err);
    } finally {
      setRevoking(false);
    }
  }

  return { confirming, setConfirming, revoking, error, revoke };
}
