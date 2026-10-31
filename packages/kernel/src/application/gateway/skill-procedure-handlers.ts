import { ProposeProcedureContentSchema, ProposeSkillContentSchema } from '@nexttime/shared';
import type { ProcedureRow, SkillRow } from '../../application/worker/index.js';
import {
  deprecateProcedure,
  deprecateSkill,
  getSkill,
  latestPublishedProcedures,
  latestPublishedSkills,
  listProcedures,
  listSkills,
  procedureDraftDigest,
  procedureReviewContent,
  proposeProcedure,
  proposeSkill,
  publishProcedure,
  publishSkill,
  readSkillDraftVerdicts,
  skillDraftDigest,
  skillReviewContent,
} from '../../application/worker/index.js';
import { countSuspectedSecrets, credentialReviewAudit } from '../../governance/redaction/index.js';
import { currentPrincipalId } from '../chat/index.js';
import { procedureTemplateProblems } from '../goal/index.js';
import { readProcedureStats, readSkillStats } from '../task/index.js';
import { type CapabilityHandler, publishActorOf } from './capability-handler.js';
import { draftViewerOf } from './draft-viewer.js';

/**
 * application/gateway/skill-procedure-handlers: `propose_skill` / `publish_skill` /
 * `deprecate_skill` / `list_skills` and their Procedure counterparts (design doc §5.1.4 Skill/
 * Procedure, §5.4 I16; docs/development-tasks.md S2.14) — same split-file-from-handlers.ts
 * convention `operation-manifest-handlers.ts` (S2.4) already established for `propose_operation`/
 * `publish_operation`/`deprecate_operation`, kept here to match rather than growing handlers.ts's
 * own map body with eight more entries inline.
 *
 * `propose_skill`/`propose_procedure` are `channel:'handle'` capabilities (packages/shared/src/
 * capabilities.ts) whose registered `paramsSchema` deliberately leaves `skill`/`procedure` as an
 * opaque record (mirroring `propose_operation`'s own `operation: jsonRecord` — the shared registry
 * cannot express a nested Zod object per capability without duplicating `@nexttime/shared`'s own
 * content schemas into the registry file) — these handlers are where that opaque payload is
 * actually parsed against `ProposeSkillContentSchema`/`ProposeProcedureContentSchema`.
 *
 * `get_skill_stats` (S11 W1a E2-1) counts a family's use and outcomes; its builder floor sees every
 * draft already, so it does not narrow.
 *
 * The three reads (`list_skills` / `get_skill` / `list_procedures`) narrow drafts for one
 * `DraftViewer` (`draftViewerOf`, draft-viewer.ts; the rule is application/worker/draft-visibility.ts's
 * `draftVisibleTo`): a caller's own drafts, or every draft for the owner and builders.
 */

// S11 W1a E2-0 (legacy 48 ②): `skillId` proposes the next version of that family; without it, a
// new family as before (application/worker/family-version.ts).
const proposeSkillHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { skill: rawSkill, skillId } = params as { skill: unknown; skillId?: string };
  const content = ProposeSkillContentSchema.parse(rawSkill);
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const record = await proposeSkill(client, workspaceId, principalId, {
    ...content,
    ...(skillId !== undefined ? { skillId } : {}),
  });
  return {
    result: {
      id: record.id,
      version: record.version,
      status: record.status,
      name: record.name,
      draftDigest: skillDraftDigest(record),
    },
    resourceType: 'skill',
    resourceId: record.id,
  };
};

const publishSkillHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { skillId, version, draftDigest, credentialsReviewed } = params as {
    skillId: string;
    version: number;
    draftDigest: string;
    credentialsReviewed?: boolean;
  };
  const actor = {
    ...publishActorOf('publish_skill', ctx),
    credentialsReviewed,
    reviewedVersion: version,
    reviewedDraftDigest: draftDigest,
  };
  const record = await publishSkill(client, workspaceId, actor.principalId, skillId, actor);
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'skill',
    resourceId: record.id,
    // The published row is the locked draft the service counted (publishing changes no content).
    auditPayload: credentialReviewAudit(countSuspectedSecrets(skillReviewContent(record))),
  };
};

const deprecateSkillHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { skillId } = params as { skillId: string };
  const record = await deprecateSkill(
    client,
    workspaceId,
    skillId,
    publishActorOf('deprecate_skill', ctx),
  );
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'skill',
    resourceId: record.id,
  };
};

/** The ids of a page's draft rows — whose family's published version, if any, is `inUse`. */
function draftIdsOf(rows: readonly { readonly id: string; readonly status: string }[]): string[] {
  return rows.filter((row) => row.status === 'draft').map((row) => row.id);
}

/** UX acceptance of #764 (P2-1): a draft row with its family's latest published version, the one in
 *  use until the draft is published; a published row, or a family with none, as it is. */
function withInUse<Row extends { readonly id: string; readonly status: string }, Wire>(
  wire: Wire,
  row: Row,
  inUse: ReadonlyMap<string, Row>,
  toWire: (row: Row) => Wire,
): Wire | (Wire & { readonly inUse: Wire }) {
  const published = row.status === 'draft' ? inUse.get(row.id) : undefined;
  return published ? { ...wire, inUse: toWire(published) } : wire;
}

/** Review #493 on #764 (F1): a draft carries the digest `publish_skill` takes back. */
function toWireSkillSummary(row: SkillRow) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    name: row.name,
    description: row.description,
    applicable: row.applicable,
    proposedBy: row.proposedBy,
    ...(row.status === 'draft' ? { draftDigest: skillDraftDigest(row) } : {}),
  };
}

// S8 W1-C (leftover 48 pagination list): `limit`/`cursor` → `nextCursor`/`truncated` — no-`limit`
// behavior unchanged (`DEFAULT_LIST_SKILLS_LIMIT`, `application/worker/skills.ts`'s own doc
// comment).
const listSkillsHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { limit, cursor } = params as { limit?: number; cursor?: string };
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  const page = await listSkills(client, workspaceId, viewer, { limit, cursor });
  // UX acceptance of #764 (P2-1): a draft row names the version in use beside it.
  const inUse = await latestPublishedSkills(client, workspaceId, draftIdsOf(page.items));
  return {
    result: {
      items: page.items.map((row) =>
        withInUse(toWireSkillSummary(row), row, inUse, toWireSkillSummary),
      ),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
    },
  };
};

// S8 W1-C (leftover 48 "无 get_skill"): the full-body counterpart to `listSkillsHandler` above.
const getSkillHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { skillId, version } = params as { skillId: string; version?: number };
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  const row = await getSkill(client, workspaceId, viewer, skillId, version);
  if (!row) return { result: null, resourceType: 'skill', resourceId: skillId };
  return {
    result: {
      ...toWireSkillSummary(row),
      markdown: row.markdown,
      publishedBy: row.publishedBy,
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    },
    resourceType: 'skill',
    resourceId: skillId,
  };
};

// S11 W1a E2-1: a Skill family's statistics, counted when read (application/task/skill-stats.ts).
// No draft narrowing: the capability's builder floor already sees every draft (D-26), and a
// draft-only family has no runs to count.
const getSkillStatsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { skillId } = params as { skillId: string };
  const stats = await readSkillStats(client, workspaceId, skillId);
  return { result: stats, resourceType: 'skill', resourceId: skillId };
};

// S10 E3-3 (I-E4, §5.5 封闭): the dev verdicts of the evaluations of the caller's own drafts of one
// Skill — on a Handle, its obo's (`draftViewerOf`), whatever their role: no one is told of another's
// drafts here (application/worker/draft-verdicts.ts).
const getSkillDraftVerdictsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { skillId } = params as { skillId: string };
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  const result = await readSkillDraftVerdicts(client, workspaceId, viewer.principalId, skillId);
  return { result, resourceType: 'skill', resourceId: skillId };
};

// S11 W1a E2-2: a Procedure family's statistics, counted when read
// (application/task/procedure-stats.ts) — the same audience and reasoning as `get_skill_stats`.
const getProcedureStatsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { procedureId } = params as { procedureId: string };
  const stats = await readProcedureStats(client, workspaceId, procedureId);
  return { result: stats, resourceType: 'procedure', resourceId: procedureId };
};

// S11 W1a E2-0: `procedureId` proposes the next version of that family, as `skillId` above.
const proposeProcedureHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { procedure: rawProcedure, procedureId } = params as {
    procedure: unknown;
    procedureId?: string;
  };
  const content = ProposeProcedureContentSchema.parse(rawProcedure);
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const record = await proposeProcedure(client, workspaceId, principalId, {
    ...content,
    ...(procedureId !== undefined ? { procedureId } : {}),
  });
  return {
    result: {
      id: record.id,
      version: record.version,
      status: record.status,
      name: record.name,
      draftDigest: procedureDraftDigest(record),
    },
    resourceType: 'procedure',
    resourceId: record.id,
  };
};

const publishProcedureHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { procedureId, version, draftDigest, credentialsReviewed } = params as {
    procedureId: string;
    version: number;
    draftDigest: string;
    credentialsReviewed?: boolean;
  };
  const actor = {
    ...publishActorOf('publish_procedure', ctx),
    credentialsReviewed,
    reviewedVersion: version,
    reviewedDraftDigest: draftDigest,
  };
  // S11 GO5d-2: a Procedure that says how a goal's plan is made from it is published only when
  // that plan passes.
  const record = await publishProcedure(
    client,
    workspaceId,
    actor.principalId,
    procedureId,
    actor,
    {
      templateProblems: procedureTemplateProblems,
    },
  );
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'procedure',
    resourceId: record.id,
    auditPayload: credentialReviewAudit(
      countSuspectedSecrets(procedureReviewContent(record), { secretFields: true }),
    ),
  };
};

const deprecateProcedureHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { procedureId } = params as { procedureId: string };
  const record = await deprecateProcedure(
    client,
    workspaceId,
    procedureId,
    publishActorOf('deprecate_procedure', ctx),
  );
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'procedure',
    resourceId: record.id,
  };
};

/** Review #493 on #764 (F1): as `toWireSkillSummary`. */
function toWireProcedureSummary(row: ProcedureRow) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    name: row.name,
    description: row.description,
    steps: row.steps,
    parameters: row.parameters as Record<string, unknown> | null,
    proposedBy: row.proposedBy,
    ...(row.status === 'draft' ? { draftDigest: procedureDraftDigest(row) } : {}),
  };
}

// S8 W1-C (leftover 48 pagination list): same shape as `listSkillsHandler` above.
const listProceduresHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { limit, cursor } = params as { limit?: number; cursor?: string };
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  const page = await listProcedures(client, workspaceId, viewer, { limit, cursor });
  const inUse = await latestPublishedProcedures(client, workspaceId, draftIdsOf(page.items));
  return {
    result: {
      items: page.items.map((row) =>
        withInUse(toWireProcedureSummary(row), row, inUse, toWireProcedureSummary),
      ),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
    },
  };
};

export {
  proposeSkillHandler,
  publishSkillHandler,
  deprecateSkillHandler,
  listSkillsHandler,
  getSkillHandler,
  getSkillStatsHandler,
  getSkillDraftVerdictsHandler,
  proposeProcedureHandler,
  publishProcedureHandler,
  deprecateProcedureHandler,
  listProceduresHandler,
  getProcedureStatsHandler,
};
