import { z } from 'zod';
import { AdminAgentRefusalReasonSchema } from '../enums.js';

/**
 * wire/admin-agent (S11 AA4c: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §5.7,
 * §5.9; the AA4 plan's F3–F5 and the AA4c plan's D1–D7). What the console's 「管理员智能体」 page
 * reads and changes on the platform plane — the switch, the trial workspaces where the
 * administrator may start their admin agent, the workspaces it may propose to — and the one read
 * the agent itself has of the latter.
 */

/** At most this many target workspaces per administrator and trial workspace. */
export const ADMIN_AGENT_TARGETS_MAX = 20;

/** A workspace the administrator lets their admin agent propose to, as the administrator reads it
 *  (the agent reads ids only). `status` is now: a workspace disabled since it was chosen stays in
 *  the list, and proposing to it is refused. */
export const AdminAgentTargetWireSchema = z
  .object({
    workspaceId: z.string(),
    name: z.string(),
    status: z.enum(['active', 'disabled']),
    chosenAt: z.string(),
  })
  .strict();
export type AdminAgentTargetWire = z.infer<typeof AdminAgentTargetWireSchema>;

/** The administrator's admin agent session in a trial workspace, while one is open. */
export const AdminAgentSessionWireSchema = z
  .object({
    sessionId: z.string(),
    startedAt: z.string(),
    expiresAt: z.string().nullable(),
  })
  .strict();
export type AdminAgentSessionWire = z.infer<typeof AdminAgentSessionWireSchema>;

/** A trial workspace the administrator is a member of, and whether their admin agent may start
 *  there now. */
export const AdminAgentTrialWorkspaceWireSchema = z
  .object({
    workspaceId: z.string(),
    name: z.string(),
    /** `null`: the admin agent may start here now. Otherwise the first reason it may not
     *  (`switched_off` when the platform has it off). */
    refusal: AdminAgentRefusalReasonSchema.nullable(),
    /** What every admin agent Chat of the administrator in this trial workspace may propose to — one
     *  choice for all of them (the agent's session is one per person and trial workspace). */
    targets: z.array(AdminAgentTargetWireSchema),
    session: AdminAgentSessionWireSchema.nullable(),
  })
  .strict();
export type AdminAgentTrialWorkspaceWire = z.infer<typeof AdminAgentTrialWorkspaceWireSchema>;

/** `get_admin_agent_status`. */
export const AdminAgentStatusWireSchema = z
  .object({
    /** `ADMIN_AGENT_ENABLED` on this deployment: a maintainer sets it in the host's environment;
     *  no page changes it. */
    enabled: z.boolean(),
    /** The trial workspaces the calling administrator is a person in, by name — disabled ones too
     *  (`refusal` says why the agent may not act there). */
    workspaces: z.array(AdminAgentTrialWorkspaceWireSchema),
  })
  .strict();
export type AdminAgentStatusWire = z.infer<typeof AdminAgentStatusWireSchema>;

/** `set_admin_agent_targets`: the targets as they now are, and what the call changed. */
export const AdminAgentTargetsResultWireSchema = z
  .object({
    trialWorkspaceId: z.string(),
    targets: z.array(AdminAgentTargetWireSchema),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  })
  .strict();
export type AdminAgentTargetsResultWire = z.infer<typeof AdminAgentTargetsResultWireSchema>;

/** `stop_admin_agent`. */
export const AdminAgentStopResultWireSchema = z
  .object({
    /** The admin agent sessions revoked, with their Handles. */
    revokedSessions: z.number().int().nonnegative(),
    /** The admin agent Turns that were running and were stopped. */
    stoppedTurns: z.number().int().nonnegative(),
  })
  .strict();
export type AdminAgentStopResultWire = z.infer<typeof AdminAgentStopResultWireSchema>;

/** `agent_list_proposal_targets` (the admin agent's own read): the workspaces its administrator
 *  lets it propose to, by id only — nothing of them. */
export const AgentProposalTargetsWireSchema = z
  .object({ targetWorkspaceIds: z.array(z.string()) })
  .strict();
export type AgentProposalTargetsWire = z.infer<typeof AgentProposalTargetsWireSchema>;
