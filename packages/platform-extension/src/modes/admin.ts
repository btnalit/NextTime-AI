import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type AgentProposalTargetsWire, getCapability } from '@nexttime/shared';
import { type KernelClient, KernelError } from '../kernel-client.js';
import { gateToolParameters, toToolParameters } from '../tool-schema.js';
import { createGateToolProjector } from './gate-tool-projection.js';
import {
  type AllowedOperationWire,
  gateToolDescription,
  truncateToolResult,
} from './gate-tools.js';
import { resolveInvokeWorkerCallPlan } from './invoke-worker-call.js';

/**
 * `admin` mode (S11 AA4c-2; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §5, the
 * AA4c plan's D3 and D8): the pi extension inside a platform administrator's admin agent container
 * — a resident container of its own in a trial workspace, never the entry agent's
 * (worker-supervisor `resident-kind.ts`). Its system prompt is the platform's admin agent template
 * (`ontology/admin-agent.yaml`), its Handle holds the admin agent ceiling (kernel
 * `governance/capability/handles.ts` `ADMIN_AGENT_CEILING_CAPABILITY_NAMES`, I-A2), and its
 * container has no egress at all.
 *
 * What it registers is that ceiling, and nothing the ceiling does not hold: the static tools below
 * (`ADMIN_TOOL_CAPABILITY_NAMES`, pinned to the ceiling by the kernel's own guard test, see
 * `handles.test.ts`) and the workspace's observe-class `<gate>.<op>` tools, projected the way entry
 * mode projects them. The entry agent's per-call context (`get_entry_context`) and Turn report
 * (`report_turn`) are entry capabilities the admin agent's Handle does not carry, so neither is
 * called here: a Turn's outcome reaches the kernel from agent-host (`turnEnded`), as it does for
 * every Turn.
 *
 * Its proposal targets (D3): at the start of every Turn, one `agent_list_proposal_targets` read —
 * the ids of the workspaces its administrator chose in this trial workspace — goes into the
 * conversation as a "Proposal targets" message, so the model knows where it may propose before it
 * tries. Ids only: the agent learns nothing else about those workspaces from it. A failed read says
 * so instead of listing anything, and the model is told to read them again with the same tool.
 */

/** Every capability this mode registers as a pi tool, verbatim (`buildCapabilityTool`). Each is on
 *  the admin agent ceiling; of the ceiling, only `list_allowed_operations` (the gate projection's
 *  own read), `observe_operation` and `<gate>.<op>` (reached through the projected gate tools) are
 *  not here — the kernel's `handles.test.ts` pins exactly that difference. */
export const ADMIN_TOOL_CAPABILITY_NAMES = [
  // graph: the trial workspace's objects, Facts and what can run on them
  'get_object',
  'traverse',
  'search',
  'list_facts',
  'state_at',
  'graph_freshness',
  'graph_overview',
  'find_operations',
  'find_workers',
  'find_procedures',
  'explain',
  // definitions
  'list_skills',
  'get_skill',
  'get_skill_draft_verdicts',
  'list_procedures',
  'get_type',
  'list_types',
  'validate',
  'list_ontology_versions',
  'list_worker_definitions',
  // drafts in the trial workspace, private until a person publishes them
  'propose_skill',
  'propose_procedure',
  'propose_worker_definition',
  'propose_operation',
  'propose_ontology_change',
  // goals and Tasks, read only
  'get_goal',
  'list_goals',
  'get_goal_revision',
  'list_goal_unresolved_actions',
  'get_task',
  // the platform, redacted
  'platform_state_gates',
  'platform_state_connectors',
  'platform_state_audit',
  'platform_state_runtime',
  'platform_state_updates',
  'platform_state_invariants',
  // admin proposals, and the workspaces it may propose to
  'propose_admin_proposal',
  'agent_list_admin_proposals',
  'agent_get_admin_proposal',
  'agent_withdraw_admin_proposal',
  'agent_list_proposal_targets',
  // S11 AA5a-1: trying things out in the trial workspace — asking a person to connect a system
  // (they enter the credentials), and running a published Worker. The kernel refuses both outside
  // a trial workspace.
  'request_connection',
  'invoke_worker',
] as const;

/** The custom message each Turn's proposal targets go in. */
export const PROPOSAL_TARGETS_CUSTOM_TYPE = 'nexttime-admin-proposal-targets';

/** The marker agent-host puts on every prompt's first line (entry.ts `TURN_ID_MARKER`): stripped
 *  before the model sees it, and the Turn id it names becomes this process's correlation id. */
const TURN_ID_MARKER = /^<!--nexttime:turn_id=([A-Za-z0-9_-]+)-->\n?/;

export interface AdminModeOptions {
  kernelClient: KernelClient;
  /** Seed for the correlation id until the first prompt's marker names its Turn. */
  initialTurnId?: string;
  /** Per-refresh budget for the gate tool projection's read (overridden in tests). */
  toolRefreshTimeoutMs?: number;
}

function buildCapabilityTool(name: string, kernelClient: KernelClient): ToolDefinition {
  const capability = getCapability(name);
  if (!capability) {
    throw new Error(
      `@nexttime/platform-extension: capability "${name}" is missing from the shared registry (admin mode registers ADMIN_TOOL_CAPABILITY_NAMES verbatim)`,
    );
  }
  return {
    name: capability.name,
    label: capability.name,
    description: capability.description,
    parameters: toToolParameters(capability.paramsSchema),
    // A thrown error is the tool result, isError (entry.ts `buildCapabilityTool`). A refusal goes
    // back with its code ahead of its message: the admin agent's prompt names the codes it acts on
    // (`admin_proposal_target_not_chosen`) and tells it to report a refusal as it is.
    // `invoke_worker` is called the way every mode calls it (`invoke-worker-call.ts`): `wait`
    // defaults to false, and the call's timeout outlasts the kernel's spawn budget and wait.
    async execute(_toolCallId, params) {
      const plan = resolveInvokeWorkerCallPlan(capability.name, params);
      const result = await kernelClient
        .call(capability.name, plan.params, undefined, plan.timeoutMs)
        .catch((error: unknown) => {
          throw withRefusalCode(error);
        });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

/** A refusal from the kernel (`capability_error`) as `<code>: <message>`, so the model sees which
 *  refusal it got; any other error as it is. */
export function withRefusalCode(error: unknown): unknown {
  if (!(error instanceof KernelError) || error.kind !== 'capability_error' || !error.code) {
    return error;
  }
  return new KernelError(error.kind, `${error.code}: ${error.message}`, {
    code: error.code,
    cause: error,
  });
}

/** A projected observe-class gate tool — the same call entry mode's is (`observe_operation`). */
function buildGateObserveTool(
  op: AllowedOperationWire,
  name: string,
  label: string,
  kernelClient: KernelClient,
): ToolDefinition {
  return {
    name,
    label,
    description: gateToolDescription(op, label),
    parameters: gateToolParameters(op.operation.params_schema) as ToolDefinition['parameters'],
    async execute(_toolCallId, params) {
      const result = await kernelClient.call<Record<string, unknown>>('observe_operation', {
        gatekeeperId: op.gatekeeperId,
        operation: op.name,
        params,
      });
      return {
        content: [{ type: 'text', text: truncateToolResult(JSON.stringify(result, null, 2)) }],
        details: result,
      };
    },
  };
}

/** The "Proposal targets" message for one Turn: the ids its administrator chose, or why there are
 *  none to show. */
export function renderProposalTargets(targets: AgentProposalTargetsWire | undefined): string {
  const heading = '## Proposal targets';
  if (targets === undefined) {
    return [
      heading,
      'Your proposal targets could not be read at the start of this turn. Read them with `agent_list_proposal_targets` before you propose to another workspace.',
    ].join('\n\n');
  }
  if (targets.targetWorkspaceIds.length === 0) {
    return [
      heading,
      'Your administrator has not chosen any workspace for you to propose to: an admin proposal for another workspace would be refused. Proposals for the platform itself, and drafts in this trial workspace, are not affected.',
    ].join('\n\n');
  }
  return [
    heading,
    'The workspaces your administrator lets you propose to, by id:',
    targets.targetWorkspaceIds.map((id) => `- ${id}`).join('\n'),
  ].join('\n\n');
}

function isProposalTargets(value: unknown): value is AgentProposalTargetsWire {
  if (typeof value !== 'object' || value === null) return false;
  const ids = (value as { targetWorkspaceIds?: unknown }).targetWorkspaceIds;
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string');
}

export function registerAdminMode(pi: ExtensionAPI, options: AdminModeOptions): void {
  let currentTurnId = options.initialTurnId;
  options.kernelClient.setCorrelationId(currentTurnId);

  for (const name of ADMIN_TOOL_CAPABILITY_NAMES) {
    pi.registerTool(buildCapabilityTool(name, options.kernelClient));
  }

  const gateTools = createGateToolProjector(pi, {
    kernelClient: options.kernelClient,
    component: 'admin',
    include: (op) => op.operation.mode === 'observe',
    buildTool: (op, name, label) => buildGateObserveTool(op, name, label, options.kernelClient),
    timeoutMs: options.toolRefreshTimeoutMs,
  });

  pi.on('session_start', async () => {
    await gateTools.refresh({ reason: 'session_start', turnId: currentTurnId });
  });

  pi.on('input', (event) => {
    const match = TURN_ID_MARKER.exec(event.text);
    if (!match) return undefined;
    currentTurnId = match[1];
    options.kernelClient.setCorrelationId(currentTurnId);
    return { action: 'transform' as const, text: event.text.slice(match[0].length) };
  });

  async function readProposalTargets(): Promise<AgentProposalTargetsWire | undefined> {
    try {
      const result = await options.kernelClient.call<unknown>('agent_list_proposal_targets', {});
      if (isProposalTargets(result)) return result;
      console.error('nexttime-admin check=proposal_targets result=malformed');
      return undefined;
    } catch (error) {
      const message =
        error instanceof KernelError ? `${error.kind}: ${error.message}` : String(error);
      console.error(`nexttime-admin check=proposal_targets result=error error=${message}`);
      return undefined;
    }
  }

  // Once per prompt, after `input` (so the correlation id is this Turn's): the gate tools for this
  // run, and its proposal targets as one message ahead of the run (pi keeps it in the session, so
  // a later Turn's history shows what each earlier one was told; the newest is the current set).
  pi.on('before_agent_start', async () => {
    const [, targets] = await Promise.all([
      gateTools.refresh({ reason: 'turn', turnId: currentTurnId }),
      readProposalTargets(),
    ]);
    console.log(
      `nexttime-admin check=proposal_targets result=${
        targets === undefined ? 'unavailable' : 'ok'
      } count=${targets?.targetWorkspaceIds.length ?? 0}`,
    );
    return {
      message: {
        customType: PROPOSAL_TARGETS_CUSTOM_TYPE,
        content: renderProposalTargets(targets),
        display: false,
      },
    };
  });
}
