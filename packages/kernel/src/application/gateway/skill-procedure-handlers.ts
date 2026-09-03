import { ProposeProcedureContentSchema, ProposeSkillContentSchema } from '@nexttime/shared';
import {
  deprecateProcedure,
  deprecateSkill,
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

const listSkillsHandler: CapabilityHandler = async (client, workspaceId, _params, ctx) => {
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const rows = await listSkills(client, workspaceId, principalId);
  return {
    result: {
      skills: rows.map((row) => ({
        id: row.id,
        version: row.version,
        status: row.status,
        name: row.name,
        description: row.description,
        applicable: row.applicable,
      })),
    },
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

const listProceduresHandler: CapabilityHandler = async (client, workspaceId, _params, ctx) => {
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const rows = await listProcedures(client, workspaceId, principalId);
  return {
    result: {
      procedures: rows.map((row) => ({
        id: row.id,
        version: row.version,
        status: row.status,
        name: row.name,
        description: row.description,
        steps: row.steps,
      })),
    },
  };
};

export {
  proposeSkillHandler,
  publishSkillHandler,
  deprecateSkillHandler,
  listSkillsHandler,
  proposeProcedureHandler,
  publishProcedureHandler,
  deprecateProcedureHandler,
  listProceduresHandler,
};
