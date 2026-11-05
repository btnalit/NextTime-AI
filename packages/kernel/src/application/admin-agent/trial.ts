import type { PoolClient } from 'pg';
import { ADMIN_AGENT_SESSION_KIND } from '../../governance/capability/index.js';
import {
  ADMIN_TRIAL_WORKSPACE_PURPOSE,
  AdminAgentRefused,
  adminAgentRefusalOf,
  readAdminAgentAuthorityFacts,
} from './identity.js';

/**
 * application/admin-agent/trial (S11 AA5a-1; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
 * §5.8 steps 2 and 4, the AA5 plan's F1 and F2): what holds the admin agent's two trial-run
 * capabilities — `request_connection` and `invoke_worker` — to its trial workspace, and the one
 * exception a trial workspace makes to the platform's connector modes.
 *
 * **Trial workspace only.** The dispatcher already refuses every admin agent call outside a trial
 * workspace (`adminAgentRefusalOf`, `not_trial_workspace`). These two capabilities reach a system
 * and start a Worker, so their handlers check the workspace's purpose again themselves
 * ({@link assertAdminAgentInTrialWorkspace}), reading the session row instead of trusting how the
 * caller was built; and the database refuses to record either for any other workspace (task 0013,
 * governance 0037). The prompt is not one of these layers.
 *
 * **Self-connecting in a trial workspace** (F1(a)). A workspace may connect a system of its own only
 * while the platform keeps that kind's generic connector in `self_serve` (R-40, D-19). A trial
 * workspace is a platform administrator's sandbox for trying a system out before proposing it for
 * production, so there an `http` or `mcp` connection is allowed while the platform runs that kind
 * itself (`platform_preset`) — provided the Principal asking (the admin agent's person) and the one
 * completing it (a person, on the human channel) is, at that moment, a platform administrator
 * acting in an active trial workspace ({@link isPlatformAdminInTrialWorkspace}). A kind the
 * platform switched off (`disabled`) stays off here too: no exception passes it (coordinator
 * 2026-11-05 — what is taken out of use grants nothing, as with a disabled trial workspace). Each
 * use of the exception leaves its own
 * audit row (`connection.trial_self_connect`), and the connection is a self connection like any
 * other: the platform sees it and can suspend it. Production still goes through a platform
 * segment's `gate_instance`.
 */

/** The connection kinds a trial workspace may self-connect though the connector is not `self_serve`
 *  (F1). */
export const TRIAL_SELF_CONNECT_KINDS: ReadonlySet<string> = new Set(['http', 'mcp']);

/** The one connector mode besides `self_serve` the trial exception passes; `disabled` it never does
 *  (coordinator 2026-11-05). */
export const TRIAL_SELF_CONNECT_PASSES_MODE = 'platform_preset' as const;

/** The audit action written each time the trial exception lets a connection through. */
export const TRIAL_SELF_CONNECT_AUDIT_ACTION = 'connection.trial_self_connect';

/** What these checks read of a capability call's caller (`CapabilityHandlerContext`). */
export interface TrialCaller {
  readonly principalId: string;
  readonly channel?: string;
  readonly claims?: { readonly sid?: string };
  /** Set by the dispatcher after its authority check (S11 AA2). */
  readonly adminAgent?: { readonly sessionId: string };
}

/** The admin agent session `caller` came through, or `undefined` for any other caller. A Handle
 *  call's session kind is read from its row, so a caller built without the dispatcher's
 *  `adminAgent` field is recognised too. */
export async function adminAgentSessionOf(
  client: PoolClient,
  workspaceId: string,
  caller: TrialCaller,
): Promise<string | undefined> {
  if (caller.adminAgent !== undefined) return caller.adminAgent.sessionId;
  const sid = caller.channel === 'handle' ? caller.claims?.sid : undefined;
  if (sid === undefined) return undefined;
  const session = await client.query<{ kind: string }>(
    'select kind from sessions where workspace_id = $1 and id = $2',
    [workspaceId, sid],
  );
  return session.rows[0]?.kind === ADMIN_AGENT_SESSION_KIND ? sid : undefined;
}

/**
 * For an admin agent's call, refuses ({@link AdminAgentRefused}, `not_trial_workspace` — 403
 * `admin_agent_refused` at the dispatcher) unless `workspaceId` is a trial workspace, and returns
 * the admin agent session to record. Any other caller passes untouched (`undefined`).
 */
export async function assertAdminAgentInTrialWorkspace(
  client: PoolClient,
  workspaceId: string,
  caller: TrialCaller,
): Promise<string | undefined> {
  const sessionId = await adminAgentSessionOf(client, workspaceId, caller);
  if (sessionId === undefined) return undefined;
  const workspace = await client.query<{ purpose: string }>(
    'select purpose from workspaces where id = $1',
    [workspaceId],
  );
  if (workspace.rows[0]?.purpose !== ADMIN_TRIAL_WORKSPACE_PURPOSE) {
    throw new AdminAgentRefused('not_trial_workspace', caller.principalId);
  }
  return sessionId;
}

/**
 * Whether `principalId` is, now, a platform administrator acting in an active trial workspace: the
 * admin agent's own authority rule (`adminAgentRefusalOf`) read for the person — a person, not
 * disabled, in an active trial workspace, with an active user who is an effective platform
 * administrator (the environment's administrator list wins, as everywhere). The admin agent's
 * `ADMIN_AGENT_ENABLED` switch is not part of it: the switch stops the agent, and a platform
 * administrator in the console could open the connector to self-serve anyway.
 */
export async function isPlatformAdminInTrialWorkspace(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const facts = await readAdminAgentAuthorityFacts(client, workspaceId, principalId);
  return adminAgentRefusalOf(facts, true) === null;
}
