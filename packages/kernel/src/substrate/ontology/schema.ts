import { OntologyDefinitionSchema } from '@nexttime/shared';
import type { OntologyDefinition } from '@nexttime/shared';
import { parse as parseYaml } from 'yaml';

/**
 * substrate/ontology/schema: the `ontology/*.yaml` domain-pack parser (design doc §5.1.2
 * OntologyVersion/ObjectType/LinkType/ActionType, §7.10 "机制与内容分离...`ontology/<domain>/`...
 * 走 git 与 PR，经 human 通道发布进图"; docs/development-tasks.md S3.1 deliverable
 * `ontology/{schema,registry}.ts`).
 *
 * The Zod shape itself (`OntologyDefinitionSchema`) now lives in `@nexttime/shared`'s
 * `ontology-definition.ts` — see that module's own doc comment for why (S3.1:
 * `propose_ontology_change`'s `paramsSchema` needs the identical shape, and `packages/shared` may
 * not depend on kernel). This file re-exports it for every existing kernel import site
 * (`loader.ts`, `registry.ts`, `loader.test.ts`) and owns the YAML-specific parsing wrapper
 * (`parseOntologyDefinition`/`loadOntologyDefinitionFile`/`OntologyDefinitionParseError`) — kernel
 * concerns (file IO, "which file failed to parse") that have no reason to live in the domain
 * layer.
 *
 * Originally (S2.6) this schema was defined directly here, with no `identityKey`/`actionTypes`
 * fields (the core domain ontology — this task — had not landed yet). S3.1 adds both, as
 * `@nexttime/shared` optional fields (backward-compatible with every pre-S3.1 `ontology/*.yaml`
 * file, none of which declare either).
 */

export { OntologyDefinitionSchema } from '@nexttime/shared';
export type {
  ActionTypeDefinition,
  LinkTypeDefinition,
  ObjectTypeDefinition,
  OntologyDefinition,
} from '@nexttime/shared';

export class OntologyDefinitionParseError extends Error {
  constructor(source: string, cause: unknown) {
    super(`failed to parse ontology definition "${source}": ${String(cause)}`, { cause });
    this.name = 'OntologyDefinitionParseError';
  }
}

/** Parses and validates raw YAML text against `OntologyDefinitionSchema`. Pure — no IO. `source`
 *  is only used to make a parse error identify which file it came from. */
export function parseOntologyDefinition(yamlText: string, source = '<inline>'): OntologyDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new OntologyDefinitionParseError(source, err);
  }
  const result = OntologyDefinitionSchema.safeParse(raw);
  if (!result.success) {
    throw new OntologyDefinitionParseError(source, result.error);
  }
  return result.data;
}
