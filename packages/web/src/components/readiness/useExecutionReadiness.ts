import type { ExecutionReadinessWire } from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import type { Resource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';

/**
 * components/readiness/useExecutionReadiness: the one `execution_readiness` read both J1 surfaces
 * (`ExecutionReadinessCard`, `ExecutionPrerequisiteBar`) call. No `principalId` is ever passed —
 * every mount reads the signed-in caller's own readiness (the capability's own default), matching
 * this lane's scope decision to skip the optional operator "check another member" picker (see the
 * PR report). `http` only: `execution_readiness` is `group:'governance'`, not `chat` — the `ws`
 * client only carries `chat`-group capabilities (`lib/clients.ts`'s own doc comment).
 */
export function useExecutionReadiness(http: CapabilityCaller): Resource<ExecutionReadinessWire> {
  return useCapability<ExecutionReadinessWire>(http, 'execution_readiness', {});
}
