import type { PublishableStatus, Role } from '@nexttime/shared';
import { seesEveryDraft } from '../../governance/capability/index.js';

/**
 * application/worker/draft-visibility: the one read rule for **Skill and Procedure drafts**
 * (I16 read-privacy, extended by the D-26 reviewer rule). A draft is visible to its proposer and to
 * the workspace's draft reviewers — the owner and builders (`seesEveryDraft`,
 * governance/capability/publish-authority.ts, the same rule `operationVisibleTo` applies to
 * Operation drafts). Anyone else does not see it at all: a single-row read answers not found,
 * never 403. Published and deprecated rows are not drafts and are not narrowed here.
 *
 * Why reviewers: a member's Worker proposes a Skill through `report_task_result` on that member's
 * behalf (`proposedBy` = the member, application/task/result.ts), and since D-24 only its
 * proposer — if they clear the builder floor — or the owner may publish it. Without the owner
 * seeing the draft, a Worker-proposed Skill had no review surface.
 *
 * Every read applies this rule: `listSkills` / `getSkill` / `listProcedures` bind
 * `draftVisibilityBinds` into their SQL (`status = 'draft' and ($seesEvery or proposed_by =
 * $principal)`), and the publish / deprecate refusals (`requireSkillAuthority` /
 * `requireProcedureAuthority`) use `draftVisibleTo` to choose between not found (a draft the
 * caller cannot see) and 403 `not_proposer` (one they can). Seeing is not publishing: D-24's
 * proposer-or-owner rule is unchanged.
 *
 * On the Handle channel the viewer is the Handle's `obo` with that principal's own role, so an
 * agent never sees more drafts than the human it acts for (application/gateway/
 * skill-procedure-handlers.ts's `draftViewerOf`).
 *
 * WorkerDefinition drafts keep their own proposer-only rule (`listWorkerDefinitionsPage`'s
 * `includeOwnDrafts`, application/worker/definitions.ts): no Worker path proposes them, and that
 * capability's wire contract names the caller's own drafts.
 */

/** Who is reading the Skill / Procedure registries: the principal and their workspace role. */
export interface DraftViewer {
  readonly principalId: string;
  readonly role: Role;
}

/** Whether `viewer` may see `row` — always for a published or deprecated row; for a draft, its
 *  proposer and the workspace's reviewers (owner, builder) only. */
export function draftVisibleTo(
  viewer: DraftViewer,
  row: { readonly status: PublishableStatus; readonly proposedBy: string },
): boolean {
  if (row.status !== 'draft') return true;
  return seesEveryDraft(viewer.role) || row.proposedBy === viewer.principalId;
}

/** The same rule as SQL bind values for a registry query's draft branch:
 *  `status = 'draft' and ($seesEveryDraft::boolean or proposed_by = $principalId)`. */
export function draftVisibilityBinds(viewer: DraftViewer): {
  readonly seesEveryDraft: boolean;
  readonly principalId: string;
} {
  return { seesEveryDraft: seesEveryDraft(viewer.role), principalId: viewer.principalId };
}
