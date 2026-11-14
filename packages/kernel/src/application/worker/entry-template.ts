import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '@nexttime/gatekeeper-base';
import {
  type DraftOrigin,
  ENTRY_TEMPLATE_FIELD_VALUES,
  type EntryTemplateField,
  type WorkerDefinitionKind,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { parse as parseYaml } from 'yaml';
import { resolveOntologyDir } from '../../substrate/ontology/index.js';
import {
  type WorkerDefinitionRow,
  getPublishedEntryDefinition,
  getWorkerDefinition,
  proposeWorkerDefinition,
  validateWorkerDefinitionContent,
} from './definitions.js';
import { lockWorkerRegistry } from './registry-lock.js';

/**
 * application/worker/entry-template (legacy 145): the entry WorkerDefinition the platform ships
 * (`ontology/entry-agent.yaml`, in the image at `ONTOLOGY_DIR`), and bringing a workspace's entry
 * definition up to it. A workspace's entry definition is seeded from the template once, when the
 * workspace is created (`application/workspace/create.ts`); a later release's template (a new
 * section of the prompt, a new tool) never reached a workspace that already existed.
 *
 * Nothing here changes what the entry agent runs with. `proposeEntryTemplateUpgrade` writes a
 * draft — the next version of the workspace's entry family, the template's prompt and
 * capabilities over the workspace's own settings — and publishing it stays
 * `publish_worker_definition`'s (the owner, with its credential review). Never automatic: the
 * entry prompt is what every member's entry agent reads, and the kernel cannot tell a prompt left
 * as an older template seeded it from one the owner edited, so a person looks at the difference
 * (`entryTemplateStatus`) and decides.
 *
 * What the template decides is `ENTRY_TEMPLATE_FIELD_VALUES` (`@nexttime/shared`); everything else in the entry content
 * (`model`, `egressDeny`, `name`, `description`) is the workspace's and carries over. The template
 * is compared by {@link entryTemplateDigest} over those fields, the same digest the upgrade's audit
 * records.
 */

/** The template as this kernel ships it. */
export interface EntryTemplate {
  readonly kind: WorkerDefinitionKind;
  /** The whole template content (what a new workspace's v1 is, before its `model`). */
  readonly definition: Record<string, unknown>;
  readonly systemPrompt: string;
  readonly capabilities: readonly string[];
  /** {@link entryTemplateDigest} of the two. */
  readonly digest: string;
}

/** A WorkerDefinition template file (`ontology/entry-agent.yaml`'s shape): `kind` is a top-level
 *  sibling of the content, not a field of it (that file's own header). */
export async function loadWorkerDefinitionTemplate(
  filePath: string,
): Promise<{ kind: WorkerDefinitionKind; definition: Record<string, unknown> }> {
  const text = await readFile(filePath, 'utf8');
  const parsed = parseYaml(text) as Record<string, unknown>;
  const { kind, ...definition } = parsed;
  return { kind: kind as WorkerDefinitionKind, definition };
}

/** The entry template under `ontologyDir` (default `resolveOntologyDir()`), checked against the
 *  entry content schema and the entry ceiling — a template that fails is a deployment problem and
 *  throws (`WorkerDefinitionValidationError`). */
export async function loadEntryTemplate(
  ontologyDir: string = resolveOntologyDir(),
): Promise<EntryTemplate> {
  const template = await loadWorkerDefinitionTemplate(path.join(ontologyDir, 'entry-agent.yaml'));
  validateWorkerDefinitionContent('entry', template.definition);
  const { systemPrompt, capabilities } = template.definition as {
    systemPrompt: string;
    capabilities: string[];
  };
  return {
    kind: template.kind,
    definition: template.definition,
    systemPrompt,
    capabilities,
    digest: entryTemplateDigest({ systemPrompt, capabilities }),
  };
}

/** `sha256:<hex>` of the template fields' canonical JSON — capabilities as a set (sorted), so the
 *  same names in another order are the same template. An entry content whose fields are not a
 *  string and a list of strings has a digest no template has. */
export function entryTemplateDigest(content: Readonly<Record<string, unknown>>): string {
  const capabilities = Array.isArray(content.capabilities)
    ? [...content.capabilities].map(String).sort()
    : null;
  const systemPrompt = typeof content.systemPrompt === 'string' ? content.systemPrompt : null;
  return `sha256:${createHash('sha256')
    .update(canonicalJson({ capabilities, systemPrompt }), 'utf8')
    .digest('hex')}`;
}

/** Which template fields `content` has otherwise than `template`. */
export function entryTemplateDiffers(
  template: EntryTemplate,
  content: Readonly<Record<string, unknown>>,
): EntryTemplateField[] {
  const differs: EntryTemplateField[] = [];
  if (content.systemPrompt !== template.systemPrompt) differs.push('systemPrompt');
  const capabilities = Array.isArray(content.capabilities) ? content.capabilities.map(String) : [];
  const same =
    capabilities.length === template.capabilities.length &&
    [...capabilities].sort().join('\n') === [...template.capabilities].sort().join('\n');
  if (!same) differs.push('capabilities');
  return differs;
}

/** The workspace's entry definition against the template. */
export interface EntryTemplateStatus {
  readonly template: EntryTemplate;
  /** The entry definition the entry agent runs with now (`getPublishedEntryDefinition`), or `null`
   *  when none is published. */
  readonly current: WorkerDefinitionRow | null;
  readonly currentDigest: string | null;
  /** Empty when `current` already has the template's fields. Both when nothing is published. */
  readonly differs: readonly EntryTemplateField[];
}

export async function entryTemplateStatus(
  client: PoolClient,
  workspaceId: string,
  template: EntryTemplate,
): Promise<EntryTemplateStatus> {
  const current = await getPublishedEntryDefinition(client, workspaceId);
  return {
    template,
    current,
    currentDigest: current ? entryTemplateDigest(current.definition) : null,
    differs: current
      ? entryTemplateDiffers(template, current.definition)
      : [...ENTRY_TEMPLATE_FIELD_VALUES],
  };
}

/** 409 `entry_template_current`: the entry definition already has the template's prompt and
 *  capabilities — there is nothing to upgrade to. */
export class EntryTemplateCurrentError extends Error {
  readonly code = 'entry_template_current' as const;
  readonly templateDigest: string;
  constructor(templateDigest: string, current: WorkerDefinitionRow) {
    super(
      `the entry definition (${current.id}@${current.version}) already has the platform template's prompt and capabilities (${templateDigest}) — nothing was proposed`,
    );
    this.name = 'EntryTemplateCurrentError';
    this.templateDigest = templateDigest;
  }
}

/** 409 `entry_template_changed`: the template, or the entry definition the draft would be the next
 *  version of, is not the one the caller looked at (`expected`) — a release changed the template,
 *  or someone published another entry version. Nothing was proposed; the caller reads the status
 *  again and decides on what is there now. */
export class EntryTemplateChangedError extends Error {
  readonly code = 'entry_template_changed' as const;
  constructor(what: string) {
    super(`${what} changed after it was read — nothing was proposed; read it again and decide`);
    this.name = 'EntryTemplateChangedError';
  }
}

/** What the caller looked at before asking for the draft: the template digest and the entry
 *  version (`null`: none was published) it compared against. */
export interface EntryTemplateExpectation {
  readonly templateDigest: string;
  readonly basedOn: { readonly definitionId: string; readonly version: number } | null;
}

export interface EntryTemplateUpgrade {
  readonly draft: WorkerDefinitionRow;
  readonly templateDigest: string;
  readonly basedOn: { readonly definitionId: string; readonly version: number } | null;
  readonly differs: readonly EntryTemplateField[];
  /** `false`: the caller already had this very draft (same family, same content) — returned as it
   *  is, not proposed twice. */
  readonly created: boolean;
}

/**
 * Proposes the next version of the workspace's entry family with the template's fields over
 * `current`'s own (a new family with the whole template when none is published), as
 * `principalId`'s private draft. Refuses when the template or `current` is not what `expected`
 * says (`EntryTemplateChangedError`) or when there is nothing to change
 * (`EntryTemplateCurrentError`); returns the caller's own identical draft instead of a second one.
 * Under `lockWorkerRegistry`, taken first (legacy 736).
 */
export async function proposeEntryTemplateUpgrade(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  template: EntryTemplate,
  expected: EntryTemplateExpectation,
  origin: DraftOrigin,
): Promise<EntryTemplateUpgrade> {
  if (expected.templateDigest !== template.digest) {
    throw new EntryTemplateChangedError('the platform entry template');
  }
  // Legacy 736: the workspace's WorkerDefinition registry lock before anything is read — the
  // published entry version (a publish or deprecate takes this lock too) and, below, the caller's
  // own identical draft. Two calls at once by one person then run one after the other, and the
  // second finds the first's draft instead of making another.
  await lockWorkerRegistry(client, workspaceId);
  const current = await getPublishedEntryDefinition(client, workspaceId);
  const basedOn = current ? { definitionId: current.id, version: current.version } : null;
  if (
    (basedOn === null) !== (expected.basedOn === null) ||
    (basedOn !== null &&
      (basedOn.definitionId !== expected.basedOn?.definitionId ||
        basedOn.version !== expected.basedOn?.version))
  ) {
    throw new EntryTemplateChangedError('the published entry definition');
  }
  const differs = current
    ? entryTemplateDiffers(template, current.definition)
    : [...ENTRY_TEMPLATE_FIELD_VALUES];
  if (current && differs.length === 0)
    throw new EntryTemplateCurrentError(template.digest, current);

  const definition: Record<string, unknown> = current
    ? {
        ...current.definition,
        systemPrompt: template.systemPrompt,
        capabilities: [...template.capabilities],
      }
    : { ...template.definition };
  validateWorkerDefinitionContent('entry', definition);

  // The caller's own draft with this very content, returned instead of a second one: the next
  // version of the published family, or — none published (legacy 691) — the first version of an
  // entry family nothing was ever published from (a new family per call otherwise). Read under the
  // registry lock taken above (legacy 736), so a concurrent call's draft is committed or not begun.
  const mine = await client.query<{
    id: string;
    version: number;
    definition: Record<string, unknown>;
  }>(
    current
      ? `select id, version, definition from worker_definitions
          where workspace_id = $1 and id = $3 and kind = 'entry' and status = 'draft'
            and proposed_by = $2
          order by version desc`
      : `select d.id, d.version, d.definition from worker_definitions d
          where d.workspace_id = $1 and d.kind = 'entry' and d.status = 'draft'
            and d.proposed_by = $2
            and not exists (
              select 1 from worker_definitions o
               where o.workspace_id = d.workspace_id and o.id = d.id and o.status <> 'draft')
          order by d.created_at desc, d.id, d.version desc`,
    current ? [workspaceId, principalId, current.id] : [workspaceId, principalId],
  );
  const wanted = canonicalJson(definition);
  const same = mine.rows.find((row) => canonicalJson(row.definition) === wanted);
  if (same) {
    const draft = await getWorkerDefinition(client, workspaceId, {
      definitionId: same.id,
      version: same.version,
    });
    if (draft) return { draft, templateDigest: template.digest, basedOn, differs, created: false };
  }

  const draft = await proposeWorkerDefinition(client, workspaceId, principalId, {
    ...(current ? { definitionId: current.id } : {}),
    kind: 'entry',
    definition,
    // S11 AA3a (legacy 293): the caller's, as every gateway draft's (`draftOriginOf`) — a person
    // over the human channel, or a service's API key (`agent`).
    origin,
  });
  return { draft, templateDigest: template.digest, basedOn, differs, created: true };
}
