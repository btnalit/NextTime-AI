import { useEffect, useState } from 'react';
import type { PushSource } from '../lib/clients.js';
import type { WsConnectionStatus } from '../lib/ws-client.js';

/** hooks/useWsStatus: subscribes to `WsClient`'s connection status for the sidebar indicator. */
export function useWsStatus(pushes: PushSource): WsConnectionStatus {
  const [status, setStatus] = useState<WsConnectionStatus>(() => pushes.getStatus());
  useEffect(() => {
    setStatus(pushes.getStatus());
    return pushes.onStatusChange(setStatus);
  }, [pushes]);
  return status;
}
