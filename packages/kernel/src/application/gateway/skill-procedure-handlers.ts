import { ProposeProcedureContentSchema, ProposeSkillContentSchema } from '@nexttime/shared';
import type { SkillRow } from '../../application/worker/index.js';
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
import type { CapabilityHandler } from './capability-handler.js';

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
 */

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
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const record = await publishSkill(client, workspaceId, principalId, skillId);
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'skill',
    resourceId: record.id,
  };
};

const deprecateSkillHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { skillId } = params as { skillId: string };
  const record = await deprecateSkill(client, workspaceId, skillId);
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
  };
}

// S8 W1-C (leftover 48 pagination list): `limit`/`cursor` → `nextCursor`/`truncated` — no-`limit`
// behavior unchanged (`DEFAULT_LIST_SKILLS_LIMIT`, `application/worker/skills.ts`'s own doc
// comment).
const listSkillsHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { limit, cursor } = params as { limit?: number; cursor?: string };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const page = await listSkills(client, workspaceId, principalId, { limit, cursor });
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
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const row = await getSkill(client, workspaceId, principalId, skillId);
  if (!row) return { result: null, resourceType: 'skill', resourceId: skillId };
  return {
    result: {
      ...toWireSkillSummary(row),
      markdown: row.markdown,
      proposedBy: row.proposedBy,
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
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const record = await publishProcedure(client, workspaceId, principalId, procedureId);
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'procedure',
    resourceId: record.id,
  };
};

const deprecateProcedureHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { procedureId } = params as { procedureId: string };
  const record = await deprecateProcedure(client, workspaceId, procedureId);
  return {
    result: { id: record.id, version: record.version, status: record.status },
    resourceType: 'procedure',
    resourceId: record.id,
  };
};

// S8 W1-C (leftover 48 pagination list): same shape as `listSkillsHandler` above.
const listProceduresHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { limit, cursor } = params as { limit?: number; cursor?: string };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const page = await listProcedures(client, workspaceId, principalId, { limit, cursor });
  return {
    result: {
      items: page.items.map((row) => ({
        id: row.id,
        version: row.version,
        status: row.status,
        name: row.name,
        description: row.description,
        steps: row.steps,
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
