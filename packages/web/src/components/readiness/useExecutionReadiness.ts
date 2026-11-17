import type { ExecutionReadinessWire } from '@nexttime/shared';
import { useEffect } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import type { Resource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';

/** The window event `announceReadinessChange` fires; every mounted readiness read reloads on it. */
const READINESS_CHANGED_EVENT = 'nexttime:execution-readiness-changed';

/**
 * Console audit P1-4: a page that changes what readiness is computed from — publishing or
 * deprecating a Worker definition or an Operation — calls this so a readiness card already on
 * screen (能力目录 mounts one above the tabs) re-reads instead of still saying "publish a Worker"
 * after one was published. Pages the card is not on need nothing: a mount re-reads anyway.
 *
 * The cached read is kept, not dropped: a mounted read reloads in the background (the current
 * data stays on screen, marked refreshing), so a grant or a revoke on 系统与授权 — whose whole
 * list is drawn from this read — does not blank the page and close the drawer it was made from.
 * Every session shares the one window event; `http` drops a read of it still in flight, which
 * began before the change and must not answer the reloads that follow it (legacy 245).
 */
export function announceReadinessChange(http: CapabilityCaller): void {
  inFlight.delete(http);
  window.dispatchEvent(new Event(READINESS_CHANGED_EVENT));
}

/** Legacy 245: the read in flight per session. A page can mount more than one readiness read (能力
 *  目录's card above the tabs and its Workers tab), and each reloads on the event above — they
 *  share one `execution_readiness` call instead of asking twice for the same answer. */
const inFlight = new WeakMap<CapabilityCaller, Promise<ExecutionReadinessWire>>();

function readShared(caller: CapabilityCaller): Promise<ExecutionReadinessWire> {
  const pending = inFlight.get(caller);
  if (pending !== undefined) return pending;
  const read = caller.call<ExecutionReadinessWire>('execution_readiness', {});
  inFlight.set(caller, read);
  const settle = () => {
    if (inFlight.get(caller) === read) inFlight.delete(caller);
  };
  read.then(settle, settle);
  return read;
}

/**
 * components/readiness/useExecutionReadiness: the one `execution_readiness` read the J1 surface
 * (`ExecutionReadinessCard`) calls. No `principalId` is ever passed —
 * every mount reads the signed-in caller's own readiness (the capability's own default), matching
 * this lane's scope decision to skip the optional operator "check another member" picker (see the
 * PR report). `http` only: `execution_readiness` is `group:'governance'`, not `chat` — the `ws`
 * client only carries `chat`-group capabilities (`lib/clients.ts`'s own doc comment).
 */
export function useExecutionReadiness(
  http: CapabilityCaller,
  options: { readonly enabled?: boolean } = {},
): Resource<ExecutionReadinessWire> {
  const readiness = useCapability<ExecutionReadinessWire>(
    http,
    'execution_readiness',
    {},
    {
      ...options,
      load: ({ caller }) => readShared(caller),
    },
  );
  const { reload } = readiness;
  useEffect(() => {
    const onChange = () => void reload();
    window.addEventListener(READINESS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(READINESS_CHANGED_EVENT, onChange);
  }, [reload]);
  return readiness;
}
