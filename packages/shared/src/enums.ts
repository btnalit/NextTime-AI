import { z } from 'zod';

/**
 * Domain enums (design doc §5.1, §5.5, §5.6, §7.4, §9.2, §9.3). Every enum is exported three
 * ways: a `readonly [...] as const` values array (the single source of truth), a derived union
 * type of the same name, and a Zod schema (`<Name>Schema`) for runtime validation at process
 * boundaries (DB rows, HTTP/WS/MCP payloads). Pure data — no IO, no business logic.
 */

function asEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values);
}

// ---------------------------------------------------------------------------------------------
// §5.1.1 Tenancy & principals
// ---------------------------------------------------------------------------------------------

/** Principal kind (§5.1.1): human / agent (one WorkerRun or one entry agent instance) / service. */
export const PRINCIPAL_KIND_VALUES = ['human', 'agent', 'service'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KIND_VALUES)[number];
export const PrincipalKindSchema = asEnum(PRINCIPAL_KIND_VALUES);

/**
 * Role (§5.1.1): coarse "which door can you enter" gate — capability range narrows further via
 * Grant. owner = authorization & policy; builder = propose ontology & WorkerDefinition; operator
 * = enters the approval queue; member = converse, invoke, observe; auditor = read-only incl.
 * secret metadata.
 */
export const ROLE_VALUES = ['owner', 'builder', 'operator', 'member', 'auditor'] as const;
export type Role = (typeof ROLE_VALUES)[number];
export const RoleSchema = asEnum(ROLE_VALUES);

/** Session kind (§9.2 `sessions.kind` CHECK constraint). */
export const SESSION_KIND_VALUES = [
  'web',
  'entry',
  'worker_run',
  'mcp_session',
  'service',
] as const;
export type SessionKind = (typeof SESSION_KIND_VALUES)[number];
export const SessionKindSchema = asEnum(SESSION_KIND_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.6 Epistemic status & §3.2 / reference-projects Conflict taxonomy
// ---------------------------------------------------------------------------------------------

/**
 * Epistemic status (§5.6): how a Fact came to be believed, independent of its lifecycle
 * (`recorded|superseded|invalidated`, see transitions.ts). `confidence` is a separate continuous
 * value, not modeled here.
 */
export const EPISTEMIC_STATUS_VALUES = [
  'observed',
  'extracted',
  'inferred',
  'asserted',
  'verified',
  'contradicted',
] as const;
export type EpistemicStatus = (typeof EPISTEMIC_STATUS_VALUES)[number];
export const EpistemicStatusSchema = asEnum(EPISTEMIC_STATUS_VALUES);

/**
 * Conflict type. The design doc (§5.1.3, §5.5) carries `Conflict` over from Semantica "as-is"
 * without re-listing its type taxonomy; Semantica's own taxonomy is
 * `VALUE / TYPE / RELATIONSHIP / TEMPORAL / LOGICAL` (docs/reference-projects-and-oss-landscape.md
 * §"Conflict"). Assumption (see PR body "假设"): adopted verbatim, lower-cased to match this
 * codebase's snake_case enum convention.
 */
export const CONFLICT_TYPE_VALUES = [
  'value',
  'type',
  'relationship',
  'temporal',
  'logical',
] as const;
export type ConflictType = (typeof CONFLICT_TYPE_VALUES)[number];
export const ConflictTypeSchema = asEnum(CONFLICT_TYPE_VALUES);

/** Conflict status (§5.5): `open → resolved | accepted_both | dismissed`. */
export const CONFLICT_STATUS_VALUES = ['open', 'resolved', 'accepted_both', 'dismissed'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUS_VALUES)[number];
export const ConflictStatusSchema = asEnum(CONFLICT_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 Decision
// ---------------------------------------------------------------------------------------------

/**
 * Decision status (§5.5): `proposed → approved | rejected → executed → verified | failed →
 * superseded | archived`. See transitions.ts for the edge-level reading of this chain (a rejected
 * Decision is terminal; it does not proceed to `executed`).
 */
export const DECISION_STATUS_VALUES = [
  'proposed',
  'approved',
  'rejected',
  'executed',
  'verified',
  'failed',
  'superseded',
  'archived',
] as const;
export type DecisionStatus = (typeof DECISION_STATUS_VALUES)[number];
export const DecisionStatusSchema = asEnum(DECISION_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 ActionRequest — all 13 states
// ---------------------------------------------------------------------------------------------

/** ActionRequest status: the 13 states of the v0.1 §9.2 state graph, carried forward by v0.3 §5.5. */
export const ACTION_REQUEST_STATUS_VALUES = [
  'proposed',
  'policy_evaluated',
  'auto_approved',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'denied',
  'executing',
  'executed',
  'failed',
  'verified',
  'compensated',
] as const;
export type ActionRequestStatus = (typeof ACTION_REQUEST_STATUS_VALUES)[number];
export const ActionRequestStatusSchema = asEnum(ACTION_REQUEST_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 Task, WorkerRun, EntryAgent session
// ---------------------------------------------------------------------------------------------

/** Task status (§5.5): `created → queued → running ⇄ waiting_approval → completed|failed|cancelled`. */
export const TASK_STATUS_VALUES = [
  'created',
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];
export const TaskStatusSchema = asEnum(TASK_STATUS_VALUES);

/** WorkerRun status (§5.5): `provisioning → running → suspended → terminated`. */
export const WORKER_RUN_STATUS_VALUES = [
  'provisioning',
  'running',
  'suspended',
  'terminated',
] as const;
export type WorkerRunStatus = (typeof WORKER_RUN_STATUS_VALUES)[number];
export const WorkerRunStatusSchema = asEnum(WORKER_RUN_STATUS_VALUES);

/**
 * EntryAgent session status (§5.5): `starting → ready → busy → ready …`; `crashed → starting`
 * (host auto-recovery, §7.2); `stopped` (idle timeout).
 */
export const ENTRY_AGENT_SESSION_STATUS_VALUES = [
  'starting',
  'ready',
  'busy',
  'crashed',
  'stopped',
] as const;
export type EntryAgentSessionStatus = (typeof ENTRY_AGENT_SESSION_STATUS_VALUES)[number];
export const EntryAgentSessionStatusSchema = asEnum(ENTRY_AGENT_SESSION_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 Publishable lifecycle (OntologyVersion / WorkerDefinition / Skill / Procedure / Manifest)
// ---------------------------------------------------------------------------------------------

/**
 * Publishable status (§5.5, §5.1.4, I12, I16): `draft → published → deprecated`, shared by every
 * platform meta-object that can only be published over the human channel.
 */
export const PUBLISHABLE_STATUS_VALUES = ['draft', 'published', 'deprecated'] as const;
export type PublishableStatus = (typeof PUBLISHABLE_STATUS_VALUES)[number];
export const PublishableStatusSchema = asEnum(PUBLISHABLE_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 CapabilityGrant
// ---------------------------------------------------------------------------------------------

/** Grant status (§5.5): `active → revoked | expired`. */
export const GRANT_STATUS_VALUES = ['active', 'revoked', 'expired'] as const;
export type GrantStatus = (typeof GRANT_STATUS_VALUES)[number];
export const GrantStatusSchema = asEnum(GRANT_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.1.4 Operation / Capability metadata
// ---------------------------------------------------------------------------------------------

/** Operation / capability mode (§5.1.4, §9.3): observe (read-only) vs execute (governed write). */
export const OPERATION_MODE_VALUES = ['observe', 'execute'] as const;
export type OperationMode = (typeof OPERATION_MODE_VALUES)[number];
export const OperationModeSchema = asEnum(OPERATION_MODE_VALUES);

/** Blast radius (§5.1.4, §11): low auto-approves by default; medium/high require a human. */
export const BLAST_RADIUS_VALUES = ['low', 'medium', 'high'] as const;
export type BlastRadius = (typeof BLAST_RADIUS_VALUES)[number];
export const BlastRadiusSchema = asEnum(BLAST_RADIUS_VALUES);

/**
 * Policy decision (§5.1.4 Policy "allow / require_approval / deny", §5.4 I7/I8; §9.2
 * `action_requests.policy_decision` CHECK, migrations/governance/0003_action_requests.sql). Gap
 * flagged by S2.1 (see that migration's own header comment and
 * packages/kernel/src/adapters/db/governance-schema.test.ts's `KNOWN_UNMAPPED_CHECKS`): this is
 * the `packages/shared` counterpart the policy engine (S2.2) owns.
 */
export const POLICY_DECISION_VALUES = ['allow', 'require_approval', 'deny'] as const;
export type PolicyDecision = (typeof POLICY_DECISION_VALUES)[number];
export const PolicyDecisionSchema = asEnum(POLICY_DECISION_VALUES);

/** Capability channel (§5.3, §9.3): human (web/API-key) vs handle (agent Handle, MCP/tool calls). */
export const CAPABILITY_CHANNEL_VALUES = ['human', 'handle'] as const;
export type CapabilityChannel = (typeof CAPABILITY_CHANNEL_VALUES)[number];
export const CapabilityChannelSchema = asEnum(CAPABILITY_CHANNEL_VALUES);

/** WorkerDefinition kind (§5.1.4, §9.2 `worker_definitions.kind` CHECK): entry vs worker. */
export const WORKER_DEFINITION_KIND_VALUES = ['entry', 'worker'] as const;
export type WorkerDefinitionKind = (typeof WORKER_DEFINITION_KIND_VALUES)[number];
export const WorkerDefinitionKindSchema = asEnum(WORKER_DEFINITION_KIND_VALUES);

/** Platform extension mode (§7.4 `NEXTTIME_MODE`): entry / worker / interactive (your local pi). */
export const EXTENSION_MODE_VALUES = ['entry', 'worker', 'interactive'] as const;
export type ExtensionMode = (typeof EXTENSION_MODE_VALUES)[number];
export const ExtensionModeSchema = asEnum(EXTENSION_MODE_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.1.2 Platform meta-ontology (S2.6): the ObjectTypes that "对象化平台自身" — WorkerDefinition,
// Gatekeeper, Operation, Capability, Skill, Procedure are all `objects` rows, and I16 ("平台元本体
// 对象只能经 human 通道发布；Handle 通道只能写对提议者私有的草稿") applies uniformly to all six. Kept
// here (domain layer) rather than kernel-local so both `application/gateway` (the I16 guard on the
// graph write path) and `substrate/ontology` (the object-projection helpers, e.g.
// `registerGatekeeperObject`) can import the same list without either depending on the other.
// ---------------------------------------------------------------------------------------------

export const META_ONTOLOGY_OBJECT_TYPE_VALUES = [
  'WorkerDefinition',
  'Gatekeeper',
  'Operation',
  'Capability',
  'Skill',
  'Procedure',
] as const;
export type MetaOntologyObjectType = (typeof META_ONTOLOGY_OBJECT_TYPE_VALUES)[number];
export const MetaOntologyObjectTypeSchema = asEnum(META_ONTOLOGY_OBJECT_TYPE_VALUES);

/** Whether `objectType` names one of the six platform meta-ontology ObjectTypes (I16 scope). */
export function isMetaOntologyObjectType(objectType: string): objectType is MetaOntologyObjectType {
  return (META_ONTOLOGY_OBJECT_TYPE_VALUES as readonly string[]).includes(objectType);
}
