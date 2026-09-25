import { CAPABILITY_REGISTRY, type Capability } from '@nexttime/shared';

/**
 * lib/entry-ceiling: S8 W4 item 2 (leftover "接 Claude Code / MCP 仍要手写 curl") — the console's
 * self-service `issue_handle` form needs to offer the same scope ceiling the kernel itself
 * computes (`packages/kernel/src/governance/capability/handles.ts`'s `ENTRY_CEILING_CAPABILITIES`,
 * `buildEntryCeilingCapabilityNames`), so a member picks from capabilities the Handle can actually
 * carry rather than the full registry (`issue_handle`'s handler silently drops anything outside
 * this ceiling — see `application/gateway/issue-handle-handler.ts`'s own doc comment — so an
 * unfiltered picker would let someone tick a name that quietly vanishes from the result).
 *
 * The kernel module is not importable from web (different package, and it is not re-exported
 * through `@nexttime/shared`), so this mirrors its two building blocks by hand:
 *   - every `group: 'graph'` capability (observe-only by construction) or `propose_*`-prefixed one
 *     — computed from the registry, never drifts;
 *   - the fixed extra names below, which must be kept in sync by hand with kernel's own
 *     `ENTRY_CEILING_EXTRA_CAPABILITY_NAMES` if that list ever changes.
 *
 * Deliberately omits kernel's `ENTRY_CEILING_GATE_OBSERVE_CAPABILITY_NAME` placeholder
 * (`'<gate>.<op>'`) — that is not a capability name `issue_handle`'s `scope.capabilities` accepts
 * (observe-mode gate access is structural, granted through `scope.resources.gatekeeper` instead,
 * which the console offers as a separate gate picker).
 */
const ENTRY_CEILING_EXTRA_CAPABILITY_NAMES: readonly string[] = [
  'get_task',
  'get_entry_context',
  'report_turn',
  'invoke_worker',
  'request_connection',
  'record_decision',
  'explain',
  'list_allowed_operations',
  'report_task_result',
  'observe_operation',
];

export function entryCeilingCapabilities(): readonly Capability[] {
  const names = new Set<string>(ENTRY_CEILING_EXTRA_CAPABILITY_NAMES);
  for (const capability of CAPABILITY_REGISTRY) {
    if (capability.group === 'graph' || capability.name.startsWith('propose_')) {
      names.add(capability.name);
    }
  }
  return CAPABILITY_REGISTRY.filter((capability) => names.has(capability.name));
}
