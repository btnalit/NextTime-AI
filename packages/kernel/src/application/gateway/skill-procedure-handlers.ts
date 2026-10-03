import {
  ProposeProcedureContentSchema,
  ProposeSkillContentSchema,
  type Role,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { DraftViewer, SkillRow } from '../../application/worker/index.js';
import {
  deprecateProcedure,
  deprecateSkill,
  getSkill,
  listProcedures,
  listSkills,
  proposeProcedure,
  proposeSkill,
  publishProcedure,
  publishSkill,
} from '../../application/worker/index.js';
import { currentPrincipalId } from '../chat/index.js';
import {
  type CapabilityHandler,
  type CapabilityHandlerContext,
  publishActorOf,
} from './capability-handler.js';

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
 * The three reads (`list_skills` / `get_skill` / `list_procedures`) narrow drafts for one
 * `DraftViewer` (`draftViewerOf` below; the rule is application/worker/draft-visibility.ts's
 * `draftVisibleTo`): a caller's own drafts, or every draft for the owner and builders.
 */

/**
 * Who a Skill / Procedure read is narrowed for. Human channel: the Principal dispatch.ts resolved.
 * These reads are `channel: 'handle'` too, and there the viewer is the Handle's `obo` (I13,
 * `ctx.principalId`) with that principal's own workspace role — an agent sees exactly the drafts
 * its human may see, never more. No `ctx` (a test driving the handler directly): the RLS session
 * principal, the same fallback `currentPrincipalId` gives every other handler here.
 */
async function draftViewerOf(
  client: PoolClient,
  workspaceId: string,
  ctx: CapabilityHandlerContext | undefined,
): Promise<DraftViewer> {
  if (ctx?.principal) return { principalId: ctx.principal.id, role: ctx.principal.role };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const result = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const role = result.rows[0]?.role;
  if (!role) {
    throw new Error(
      `draftViewerOf: principal ${principalId} not found in workspace ${workspaceId}`,
    );
  }
  return { principalId, role };
}

const proposeSkillHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { skill: rawSkill } = params as { skill: unknown };
  const content = ProposeSkillContentSchema.parse(rawSkill);
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const record = await proposeSkill(client, workspaceId, principalId, content);
  return {
    result: {
      id: record.id,
      version: record.version,
      status: record.status,
      name: record.name,
    },
    resourceType: 'skill',
    resourceId: record.id,
  };
};

const publishSkillHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { skillId } = params as { skillId: string };
  const actor = publishActorOf('publish_skill', ctx);
  const record = await publishSkill(client, workspaceId, actor.principalId, skillId, actor);
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'skill',
    resourceId: record.id,
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

function toWireSkillSummary(row: SkillRow) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    name: row.name,
    description: row.description,
    applicable: row.applicable,
    proposedBy: row.proposedBy,
  };
}

// S8 W1-C (leftover 48 pagination list): `limit`/`cursor` → `nextCursor`/`truncated` — no-`limit`
// behavior unchanged (`DEFAULT_LIST_SKILLS_LIMIT`, `application/worker/skills.ts`'s own doc
// comment).
const listSkillsHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { limit, cursor } = params as { limit?: number; cursor?: string };
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  const page = await listSkills(client, workspaceId, viewer, { limit, cursor });
  return {
    result: {
      items: page.items.map(toWireSkillSummary),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
    },
  };
};

// S8 W1-C (leftover 48 "无 get_skill"): the full-body counterpart to `listSkillsHandler` above.
const getSkillHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { skillId } = params as { skillId: string };
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  const row = await getSkill(client, workspaceId, viewer, skillId);
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

const proposeProcedureHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { procedure: rawProcedure } = params as { procedure: unknown };
  const content = ProposeProcedureContentSchema.parse(rawProcedure);
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const record = await proposeProcedure(client, workspaceId, principalId, content);
  return {
    result: {
      id: record.id,
      version: record.version,
      status: record.status,
      name: record.name,
    },
    resourceType: 'procedure',
    resourceId: record.id,
  };
};

const publishProcedureHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { procedureId } = params as { procedureId: string };
  const actor = publishActorOf('publish_procedure', ctx);
  const record = await publishProcedure(client, workspaceId, actor.principalId, procedureId, actor);
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'procedure',
    resourceId: record.id,
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

// S8 W1-C (leftover 48 pagination list): same shape as `listSkillsHandler` above.
const listProceduresHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { limit, cursor } = params as { limit?: number; cursor?: string };
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  const page = await listProcedures(client, workspaceId, viewer, { limit, cursor });
  return {
    result: {
      items: page.items.map((row) => ({
        id: row.id,
        version: row.version,
        status: row.status,
        name: row.name,
        description: row.description,
        steps: row.steps,
        proposedBy: row.proposedBy,
      })),
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
  proposeProcedureHandler,
  publishProcedureHandler,
  deprecateProcedureHandler,
  listProceduresHandler,
};
