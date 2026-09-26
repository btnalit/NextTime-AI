import type { PoolClient } from 'pg';
import { NO_AVAILABLE_AGENT_RESOURCES, resolveEffectiveAgentProfile } from './resolve.js';
import type { AvailableAgentResources, EffectiveAgentProfile } from './resolve.js';
import type { AgentPolicyRow, AgentProfileRow } from './types.js';

/**
 * governance/agent-profile/store: row read/write for `agent_profiles`/`agent_policies`
 * (migrations/governance/0010_agent_profiles.sql) — S3.13's own two tables. Every function takes
 * an already-open `PoolClient`, the same convention `governance/capability/handles.ts`/`grants.ts`
 * already use — the caller is expected to already be running inside `withWorkspace(...)`.
 *
 * Read by `application/gateway/agent-profile-handlers.ts` (the `get_agent_profile`/
 * `set_agent_profile`/`get_agent_policy`/`set_agent_policy` capabilities), by
 * `application/host-bridge/agent-host-runtime.ts` (entry-turn model/gate/skill/prompt
 * resolution), and by `application/task/invoke.ts`/`lifecycle.ts` (WorkerRun model fallback) and
 * `application/gateway/request-action-handler.ts` (autoApproveLow) — every one of those consumers
 * only ever needs `readEffectiveAgentProfile`'s resolved view, never the raw rows, except the
 * `get_agent_profile`/`get_agent_policy` handlers themselves, which also project the raw fields
 * onto the wire (S3.13's own contract: `null` on the wire is meaningful — "inherit").
 */

// -------------------------------------------------------------------------------------------
// AgentProfile
// -------------------------------------------------------------------------------------------

interface AgentProfileDbRow {
  workspace_id: string;
  principal_id: string;
  model: string | null;
  excluded_skills: readonly string[];
  excluded_gatekeepers: readonly string[];
  excluded_worker_definitions: readonly string[];
  prompt_addendum: string | null;
  auto_approve_low: boolean | null;
  updated_by: string | null;
  updated_at: Date;
}

// The pre-0012 `enabled_*` allow-list columns are deliberately neither read nor written: they are
// kept only so a rollback to the previous release behaves exactly as before (0012's header).
const AGENT_PROFILE_COLUMNS =
  'workspace_id, principal_id, model, excluded_skills, excluded_gatekeepers, ' +
  'excluded_worker_definitions, prompt_addendum, auto_approve_low, updated_by, updated_at';

function mapAgentProfileRow(row: AgentProfileDbRow): AgentProfileRow {
  return {
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    model: row.model,
    excludedSkills: row.excluded_skills,
    excludedGatekeepers: row.excluded_gatekeepers,
    excludedWorkerDefinitions: row.excluded_worker_definitions,
    promptAddendum: row.prompt_addendum,
    autoApproveLow: row.auto_approve_low,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export async function readAgentProfile(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<AgentProfileRow | undefined> {
  const result = await client.query<AgentProfileDbRow>(
    `select ${AGENT_PROFILE_COLUMNS} from agent_profiles where workspace_id = $1 and principal_id = $2`,
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  return row ? mapAgentProfileRow(row) : undefined;
}

/**
 * Every field is independently optional; an **omitted** (`undefined`) field leaves the existing
 * value (or the default — `null` "inherit" for the scalars, `[]` "exclude nothing" for the three
 * exclusion lists — for a principal with no row yet) untouched; a present `null` resets a scalar
 * to "inherit". `application/gateway/agent-profile-handlers.ts` is what turns "the key was absent
 * from the wire params" into an actual `undefined` here (zod's own optional/nullable distinction,
 * `packages/shared/src/capabilities.ts`'s `set_agent_profile` paramsSchema doc comment).
 */
export interface SetAgentProfileFields {
  readonly model?: string | null;
  readonly excludedSkills?: readonly string[];
  readonly excludedGatekeepers?: readonly string[];
  readonly excludedWorkerDefinitions?: readonly string[];
  readonly promptAddendum?: string | null;
  readonly autoApproveLow?: boolean | null;
}

function toJsonbList(value: readonly string[]): string {
  return JSON.stringify([...new Set(value)]);
}

/**
 * Merges `fields` (partial update semantics — see `SetAgentProfileFields`'s own doc comment) onto
 * `principalId`'s existing AgentProfile row (or the all-`null` baseline, for a principal with none
 * yet) and upserts the result. Validation (model whitelist, the addendum length cap, the
 * auto-approve-low policy gate — exclusion lists need none, they can only narrow) is the caller's own job
 * (`application/gateway/agent-profile-handlers.ts`) — this function only ever persists whatever it
 * is given.
 */
export async function setAgentProfile(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  updatedBy: string,
  fields: SetAgentProfileFields,
): Promise<AgentProfileRow> {
  const existing = await readAgentProfile(client, workspaceId, principalId);

  const merged = {
    model: fields.model !== undefined ? fields.model : (existing?.model ?? null),
    excludedSkills: fields.excludedSkills ?? existing?.excludedSkills ?? [],
    excludedGatekeepers: fields.excludedGatekeepers ?? existing?.excludedGatekeepers ?? [],
    excludedWorkerDefinitions:
      fields.excludedWorkerDefinitions ?? existing?.excludedWorkerDefinitions ?? [],
    promptAddendum:
      fields.promptAddendum !== undefined
        ? fields.promptAddendum
        : (existing?.promptAddendum ?? null),
    autoApproveLow:
      fields.autoApproveLow !== undefined
        ? fields.autoApproveLow
        : (existing?.autoApproveLow ?? null),
  };

  const result = await client.query<AgentProfileDbRow>(
    `insert into agent_profiles (
       workspace_id, principal_id, model, excluded_skills, excluded_gatekeepers,
       excluded_worker_definitions, prompt_addendum, auto_approve_low, updated_by, updated_at
     ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, now())
     on conflict (workspace_id, principal_id) do update set
       model = excluded.model,
       excluded_skills = excluded.excluded_skills,
       excluded_gatekeepers = excluded.excluded_gatekeepers,
       excluded_worker_definitions = excluded.excluded_worker_definitions,
       prompt_addendum = excluded.prompt_addendum,
       auto_approve_low = excluded.auto_approve_low,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at
     returning ${AGENT_PROFILE_COLUMNS}`,
    [
      workspaceId,
      principalId,
      merged.model,
      toJsonbList(merged.excludedSkills),
      toJsonbList(merged.excludedGatekeepers),
      toJsonbList(merged.excludedWorkerDefinitions),
      merged.promptAddendum,
      merged.autoApproveLow,
      updatedBy,
    ],
  );
  const row = result.rows[0];
  if (!row)
    throw new Error('setAgentProfile: INSERT ... ON CONFLICT ... RETURNING produced no row');
  return mapAgentProfileRow(row);
}

// -------------------------------------------------------------------------------------------
// AgentPolicy — at most one row per workspace; absent = the compiled-in defaults below (S3.13's
// own defaults list: "[]、null、true、2000、[]、[]、false").
// -------------------------------------------------------------------------------------------

interface AgentPolicyDbRow {
  workspace_id: string;
  allowed_models: readonly string[];
  default_model: string | null;
  member_can_edit_profile: boolean;
  max_prompt_addendum_chars: number;
  allowed_skills: readonly string[];
  allowed_gatekeepers: readonly string[];
  allow_member_auto_approve_low: boolean;
  updated_by: string | null;
  updated_at: Date;
}

const AGENT_POLICY_COLUMNS =
  'workspace_id, allowed_models, default_model, member_can_edit_profile, ' +
  'max_prompt_addendum_chars, allowed_skills, allowed_gatekeepers, allow_member_auto_approve_low, ' +
  'updated_by, updated_at';

function mapAgentPolicyRow(row: AgentPolicyDbRow): AgentPolicyRow {
  return {
    workspaceId: row.workspace_id,
    allowedModels: row.allowed_models,
    defaultModel: row.default_model,
    memberCanEditProfile: row.member_can_edit_profile,
    maxPromptAddendumChars: row.max_prompt_addendum_chars,
    allowedSkills: row.allowed_skills,
    allowedGatekeepers: row.allowed_gatekeepers,
    allowMemberAutoApproveLow: row.allow_member_auto_approve_low,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** The compiled-in defaults projected when no `agent_policies` row exists yet for `workspaceId`
 *  (S3.13's own defaults list, verbatim). */
export function defaultAgentPolicy(workspaceId: string): AgentPolicyRow {
  return {
    workspaceId,
    allowedModels: [],
    defaultModel: null,
    memberCanEditProfile: true,
    maxPromptAddendumChars: 2000,
    allowedSkills: [],
    allowedGatekeepers: [],
    allowMemberAutoApproveLow: false,
    updatedBy: null,
    updatedAt: null,
  };
}

export async function readAgentPolicy(
  client: PoolClient,
  workspaceId: string,
): Promise<AgentPolicyRow> {
  const result = await client.query<AgentPolicyDbRow>(
    `select ${AGENT_POLICY_COLUMNS} from agent_policies where workspace_id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  return row ? mapAgentPolicyRow(row) : defaultAgentPolicy(workspaceId);
}

/** Partial update, same "omitted = unchanged" convention as `SetAgentProfileFields` — none of
 *  these fields are individually nullable (only `defaultModel` may be `null`, meaning "no
 *  workspace default model"), matching `AgentPolicyRow`'s own shape. */
export interface SetAgentPolicyFields {
  readonly allowedModels?: readonly string[];
  readonly defaultModel?: string | null;
  readonly memberCanEditProfile?: boolean;
  readonly maxPromptAddendumChars?: number;
  readonly allowedSkills?: readonly string[];
  readonly allowedGatekeepers?: readonly string[];
  readonly allowMemberAutoApproveLow?: boolean;
}

export async function setAgentPolicy(
  client: PoolClient,
  workspaceId: string,
  updatedBy: string,
  fields: SetAgentPolicyFields,
): Promise<AgentPolicyRow> {
  const existing = await readAgentPolicy(client, workspaceId);

  const merged = {
    allowedModels: fields.allowedModels ?? existing.allowedModels,
    defaultModel: fields.defaultModel !== undefined ? fields.defaultModel : existing.defaultModel,
    memberCanEditProfile: fields.memberCanEditProfile ?? existing.memberCanEditProfile,
    maxPromptAddendumChars: fields.maxPromptAddendumChars ?? existing.maxPromptAddendumChars,
    allowedSkills: fields.allowedSkills ?? existing.allowedSkills,
    allowedGatekeepers: fields.allowedGatekeepers ?? existing.allowedGatekeepers,
    allowMemberAutoApproveLow:
      fields.allowMemberAutoApproveLow ?? existing.allowMemberAutoApproveLow,
  };

  const result = await client.query<AgentPolicyDbRow>(
    `insert into agent_policies (
       workspace_id, allowed_models, default_model, member_can_edit_profile,
       max_prompt_addendum_chars, allowed_skills, allowed_gatekeepers,
       allow_member_auto_approve_low, updated_by, updated_at
     ) values ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, now())
     on conflict (workspace_id) do update set
       allowed_models = excluded.allowed_models,
       default_model = excluded.default_model,
       member_can_edit_profile = excluded.member_can_edit_profile,
       max_prompt_addendum_chars = excluded.max_prompt_addendum_chars,
       allowed_skills = excluded.allowed_skills,
       allowed_gatekeepers = excluded.allowed_gatekeepers,
       allow_member_auto_approve_low = excluded.allow_member_auto_approve_low,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at
     returning ${AGENT_POLICY_COLUMNS}`,
    [
      workspaceId,
      JSON.stringify(merged.allowedModels),
      merged.defaultModel,
      merged.memberCanEditProfile,
      merged.maxPromptAddendumChars,
      JSON.stringify(merged.allowedSkills),
      JSON.stringify(merged.allowedGatekeepers),
      merged.allowMemberAutoApproveLow,
      updatedBy,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('setAgentPolicy: INSERT ... ON CONFLICT ... RETURNING produced no row');
  return mapAgentPolicyRow(row);
}

// -------------------------------------------------------------------------------------------
// readEffectiveAgentProfile — the one convenience read every non-registry consumer uses
// (`application/host-bridge/agent-host-runtime.ts`, `application/task/invoke.ts`/`lifecycle.ts`,
// `application/gateway/request-action-handler.ts`, `application/gateway/
// agent-profile-handlers.ts`): reads both rows and resolves them through `resolve.ts`'s pure
// `resolveEffectiveAgentProfile` in one call, so no consumer duplicates the "read profile, read
// policy, resolve" sequence. `available` is the caller's own job to assemble (this module — and
// its owning `governance` layer — may not depend on `application/worker`, the six-layer rule) —
// pass `NO_AVAILABLE_AGENT_RESOURCES` (`resolve.ts`) when the caller only reads
// `.model`/`.promptAddendum`/`.autoApproveLow`.
// -------------------------------------------------------------------------------------------

export async function readEffectiveAgentProfile(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  available: AvailableAgentResources = NO_AVAILABLE_AGENT_RESOURCES,
): Promise<EffectiveAgentProfile> {
  // S5.5 leftover 34: one client, one query at a time (pg@9 rejects concurrent queries on a client).
  const profile = await readAgentProfile(client, workspaceId, principalId);
  const policy = await readAgentPolicy(client, workspaceId);
  return resolveEffectiveAgentProfile(profile, policy, available);
}
