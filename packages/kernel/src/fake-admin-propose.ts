import {
  type AdminProposalItemIntentWire,
  AgentAdminProposalWireSchema,
  AgentProposalTargetsWireSchema,
} from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import { withWorkspace } from './adapters/db/pool.js';
import type { PoolLike } from './adapters/db/pool.js';
import { issueAdminAgentHandle } from './application/admin-agent/index.js';
import { loadConnectorPresets } from './application/gates/index.js';
import { dispatchCapability, resolveSourceBoundCaller } from './application/gateway/index.js';
import type { FakeAdminProposeOutcome, StartTurnInput } from './application/host-bridge/index.js';

/**
 * fake-admin-propose: S11 AA4d (AA4 plan F9) — the CI-only glue that lets the e2e stack's
 * `AGENT_RUNTIME=fake` kernel exercise a *real* admin agent call: an admin agent Turn whose prompt
 * carries `FAKE_ADMIN_PROPOSE_MARKER` makes `FakeAgentRuntime` call {@link
 * createFakeAdminProposeHandler}'s hook, which acts exactly as the admin agent's container would:
 *
 *   1. issues the Turn's admin agent Handle the way `AgentHostRuntime` does for a real admin Turn
 *      (`issueAdminAgentHandle`, under the session the Turn was recorded under — refused once that
 *      session has ended, and after the authority check: the switch, a trial workspace, an
 *      administrator who still is one);
 *   2. presents it the way a container-held Handle is presented (`resolveSourceBoundCaller`,
 *      `source`), so the per-call authority recheck in `authenticateHandle` runs as it would for
 *      the real agent;
 *   3. reads its targets (`agent_list_proposal_targets`) and proposes through the real dispatch
 *      (`propose_admin_proposal`: the admin-agent-only gate, the ceiling, the trial workspace
 *      (I-A6), the chosen targets, the quota, the credential and content checks, the audit row).
 *
 * The proposal is fixed: one workspace segment per chosen target, each the next version of a
 * Skill, and a platform segment creating one gate-host instance from the first connector preset
 * this deployment ships (`loadConnectorPresets`, by name order — the kernel names no system, §7.10)
 * at an address that resolves nowhere (`.invalid`). Its names carry part of the Turn id, so every
 * journey run proposes something new. Nothing here grants anything: what the Handle may do is the
 * kernel's to decide on each call, and a refusal ends the Turn `failed` with its message.
 *
 * Not under a layered directory, for the same reason as `fake-invoke-worker.ts` (read its doc
 * comment): composition-root glue, imported only by `index.ts`, wired only under
 * `FAKE_INVOKE_WORKER=1` with `AGENT_RUNTIME=fake` and a Handle keypair — never in a real
 * deployment. The real runtime has no counterpart: pi in the admin container proposes only what
 * the model writes.
 */

/** The Handle's life: one scripted call, well under the admin agent's hour. */
const FAKE_ADMIN_HANDLE_TTL_SECONDS = 600;

/** `sourceName` of every scripted proposal: a pack name no shipped pack has. */
export const FAKE_ADMIN_PROPOSAL_SOURCE_NAME = 'ci-admin-journey';

export interface FakeAdminProposeHandlerDeps {
  readonly pool: PoolLike;
  readonly privateKey: CryptoKey;
  /** `resolveSourceBoundCaller`'s own: omitted in `main()` (the mounted key files, as
   *  `fake-invoke-worker.ts`'s supervisor does); the integration test passes its own key. */
  readonly loadHandlePublicKey?: () => Promise<CryptoKey>;
  /** `loadConnectorPresets`'s directory: omitted in `main()` (`CONNECTOR_PRESETS_DIR`, else the
   *  repository's `connectors/`). */
  readonly presetsDir?: string;
}

/** The proposal the hook makes for `suffix` (a few characters of the Turn id), `targets` and the
 *  connector `preset` its platform segment instantiates. */
export function fakeAdminProposal(
  suffix: string,
  targets: readonly string[],
  preset: string,
): Record<string, unknown> {
  const skill: AdminProposalItemIntentWire = {
    kind: 'skill_version',
    skill: {
      name: `ci-admin-check-${suffix}`,
      description: `Check a knowledge base answer against its sources (CI admin journey ${suffix}).`,
      markdown:
        '# Check an answer\n\n1. Ask the knowledge base.\n2. Compare the answer with the passages it cites.\n',
    },
  };
  return {
    title: `CI admin proposal ${suffix}`,
    description:
      'Proposed by the CI admin agent journey: a Skill for each target and one knowledge base instance.',
    sourceName: FAKE_ADMIN_PROPOSAL_SOURCE_NAME,
    segments: targets.map((targetWorkspaceId) => ({ targetWorkspaceId, items: [skill] })),
    platform: {
      items: [
        {
          kind: 'gate_instance',
          gateId: `ci-kb-${suffix}`,
          displayName: `CI knowledge base ${suffix}`,
          preset,
          target: `https://kb-${suffix}.example.invalid`,
        },
      ],
    },
  };
}

/** Builds the `FakeAgentRuntime.onAdminPropose` hook — see this module's doc comment. */
export function createFakeAdminProposeHandler(
  deps: FakeAdminProposeHandlerDeps,
): (input: StartTurnInput) => Promise<FakeAdminProposeOutcome> {
  return async (input: StartTurnInput): Promise<FakeAdminProposeOutcome> => {
    const { workspaceId, principalId, sessionId } = input;
    if (input.agentKind !== 'admin_agent' || sessionId === undefined) {
      throw new Error('fake-admin-propose: not an admin agent Turn with its session');
    }
    const issued = await withWorkspace(deps.pool, { workspaceId, principalId }, (client) =>
      issueAdminAgentHandle(client, {
        workspaceId,
        principalId,
        sessionId,
        ttlSeconds: FAKE_ADMIN_HANDLE_TTL_SECONDS,
        privateKey: deps.privateKey,
      }),
    );
    const caller = await resolveSourceBoundCaller(issued.token, {
      pool: deps.pool,
      loadHandlePublicKey: deps.loadHandlePublicKey,
    });
    const { targetWorkspaceIds } = AgentProposalTargetsWireSchema.parse(
      await dispatchCapability({ pool: deps.pool }, caller, 'agent_list_proposal_targets', {}),
    );
    if (targetWorkspaceIds.length === 0) {
      throw new Error(
        'fake-admin-propose: no proposal targets chosen for this trial workspace — choose them on 平台 · 管理员智能体 first',
      );
    }
    const [preset] = await loadConnectorPresets({ presetsDir: deps.presetsDir });
    if (preset === undefined) {
      throw new Error('fake-admin-propose: this deployment ships no connector preset');
    }
    const suffix = input.turnId.replace(/[^a-z0-9]/g, '').slice(0, 8);
    const proposal = AgentAdminProposalWireSchema.parse(
      await dispatchCapability(
        { pool: deps.pool },
        caller,
        'propose_admin_proposal',
        fakeAdminProposal(suffix, targetWorkspaceIds, preset.name),
      ),
    );
    return { proposalId: proposal.id, title: proposal.title, status: proposal.status };
  };
}
