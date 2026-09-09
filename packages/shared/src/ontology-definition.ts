import { z } from 'zod';
import { BlastRadiusSchema, OperationModeSchema } from './enums.js';

/**
 * ontology-definition: the Zod shape of an OntologyDefinition — the `definition` jsonb content of
 * one `ontology_versions` row (design doc §5.1.2 OntologyVersion/ObjectType/LinkType/ActionType;
 * §9.2; docs/development-tasks.md S3.1 "本体注册表与本体 v1").
 *
 * Lives in `packages/shared` (the domain layer, §7.10), not in kernel, for the same reason
 * `procedure.ts`/`skill.ts`/`action-description.ts` already do: `propose_ontology_change`'s
 * `paramsSchema` (`packages/shared/src/capabilities.ts`) needs this exact shape so
 * `dispatchCapability` rejects a structurally invalid proposed definition with a 400
 * `InvalidCapabilityParamsError` at the params-validation step, rather than the proposal reaching
 * a kernel handler and failing there as an unmapped 500 (`shared-domain-has-no-internal-deps` also
 * makes this the only legal direction — kernel may import this, `packages/shared` may never import
 * from kernel). `packages/kernel/src/substrate/ontology/schema.ts` imports this schema for the
 * `ontology/*.yaml` domain-pack loader — one shape, two call sites (a propose_ontology_change
 * caller, and a checked-in YAML file), never two independently-drifting copies.
 *
 * Originally this shape (objectTypes/linkTypes only, no identityKey/actionTypes) lived directly in
 * kernel's `substrate/ontology/loader.ts` (S2.6 — the platform meta-ontology loader, which had no
 * cross-package caller yet). S3.1 is the first consumer that needs the same shape from
 * `packages/shared`, so it moves here; `loader.ts`/`schema.ts` re-export it unchanged for every
 * existing import site (`ontology/platform-meta.yaml`'s own loader, `loader.test.ts`).
 */

/**
 * `identityKey` (S3.1 addition, optional — see this module's own doc comment on backward
 * compatibility with `ontology/platform-meta.yaml`/`entry-agent.yaml`/`ops-runner.yaml`, none of
 * which declare one): an ordered list of property names whose values, taken together, identify one
 * instance of this ObjectType — the same shape `objects.identity_key` (a jsonb column,
 * `migrations/core/0006_object_identity.sql`) already stores *values* for (e.g. WorkerDefinition's
 * `{definitionId, version}`, Gatekeeper's `{gatekeeperId}`); here it names which *property keys*
 * compose that key for a given ObjectType, so a collector or `propose_ontology_change` caller
 * knows what to put in `identity_key` when it writes an instance. A property named `hostId`/
 * `composeProjectId`/etc. in an identity key is expected to hold *another Object's own id* (the
 * same convention `Gatekeeper.identity = {gatekeeperId}` and `Operation.identity =
 * {gatekeeperId, name, version}` already use elsewhere in this codebase), not a raw foreign value —
 * see `ontology/ops-assets-v1.yaml`'s own header comment for the concrete choices made there.
 */
const ObjectTypeDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    identityKey: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type ObjectTypeDefinition = z.infer<typeof ObjectTypeDefinitionSchema>;

/** `domain`/`range` name an ObjectType from this same definition's `objectTypes`, or the sentinel
 *  `"*"` for a Link whose other end is not confined to one platform-meta ObjectType — e.g.
 *  `Operation --reads/writes--> ObjectType` (any domain ObjectType, not one of the six platform
 *  meta-ontology types) and `Gatekeeper --connects_to--> 系统对象` (an arbitrary connected-system
 *  object). I2 ("Link 符合 LinkType 的 domain/range") still holds — `"*"` is an explicit, named
 *  wildcard, not an omitted field.
 *
 *  S3.1 note: two entries may share the same `name` with different concrete `domain`/`range`
 *  pairs (e.g. `runs_on` has one entry per "thing that runs on a Host") — a LinkType name is not
 *  required to be unique within `linkTypes`; `validate`'s domain/range check
 *  (`substrate/ontology/registry.ts`) matches a candidate link against *any* entry sharing its
 *  name. `platform-meta.yaml` never needed this (it uses `"*"` wildcards instead, since its own
 *  polymorphic ends genuinely span domain-pack-defined types it cannot enumerate); ops-assets-v1's
 *  LinkTypes are fully enumerable, so exact per-pair entries are strictly more precise for I2 than
 *  a wildcard would be. */
const LinkTypeDefinitionSchema = z
  .object({
    name: z.string().min(1),
    domain: z.string().min(1),
    range: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type LinkTypeDefinition = z.infer<typeof LinkTypeDefinitionSchema>;

/**
 * ActionType (S3.1 addition; design doc §5.1.2 "ActionType 带 reversibility、blast_radius、
 * auto_approvable、await_decision、requester_can_approve"). Field shape mirrors
 * `action-description.ts`'s `OperationSchema` (`mode`/`blast_radius`/`reversibility`/
 * `auto_approvable`/`await_decision`) rather than duplicating a third vocabulary for the same
 * concepts — camelCase here (this schema's own YAML/wire convention, matching `objectTypes`/
 * `linkTypes` above) versus that file's snake_case (a Gatekeeper manifest's wire/YAML shape); same
 * meaning, different layer's naming convention, connected only by shared enum types
 * (`OperationModeSchema`/`BlastRadiusSchema`), not by literal reuse of `OperationSchema` itself
 * (an ActionType classifies a *kind* of action across the platform, independent of any one
 * Gatekeeper's Operation instance — §5.4 I8 "自动批准 = ActionType 声明 且 Workspace 规则开启").
 *
 * `blastRadius` here is this ActionType's *default* (docs/development-tasks.md S3.1 deliverable 1
 * "ActionType 元数据（mode、blast radius default）") — an Operation instance classified under this
 * ActionType may still declare its own `blast_radius`; nothing in this schema enforces the two
 * stay equal (that reconciliation, if ever needed, is a future task's job, not S3.1's).
 */
const ActionTypeDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    mode: OperationModeSchema,
    blastRadius: BlastRadiusSchema,
    reversibility: z.boolean().optional(),
    autoApprovable: z.boolean().optional(),
    awaitDecision: z.boolean().optional(),
    requesterCanApprove: z.boolean().optional(),
  })
  .strict();
export type ActionTypeDefinition = z.infer<typeof ActionTypeDefinitionSchema>;

/**
 * `actionTypes` (S3.1 addition, optional): omitted entirely by every pre-S3.1 ontology YAML
 * (`platform-meta.yaml`/`entry-agent.yaml`/`ops-runner.yaml`) and by `ontology/ops-assets-v1.yaml`
 * itself (see that file's own header comment for why an infra-facts domain pack declares none) —
 * optional keeps every existing `.strict()` parse of those files passing unchanged.
 */
export const OntologyDefinitionSchema = z
  .object({
    objectTypes: z.array(ObjectTypeDefinitionSchema).min(1),
    linkTypes: z.array(LinkTypeDefinitionSchema).min(1),
    actionTypes: z.array(ActionTypeDefinitionSchema).optional(),
  })
  .strict();
export type OntologyDefinition = z.infer<typeof OntologyDefinitionSchema>;
