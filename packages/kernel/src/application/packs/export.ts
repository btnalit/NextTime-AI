import type {
  AdminProposalItemIntentWire,
  AdminProposalPackExportProblemWire,
  AdminProposalPackExportWire,
  ExportedPackFileWire,
  ExportedPackOmittedItemWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { stringify as stringifyYaml } from 'yaml';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import { AdminProposalSegmentNotFoundError, contentDigest } from '../change-plan/index.js';
import { PACK_CONTRACT_SCHEMA, PACK_NAME_PATTERN } from './manifest.js';
import {
  type PackComponent,
  type PackRegistry,
  loadPackEntry,
  memoryPackFiles,
  packComponentDigest,
  packComponentKey,
} from './registry.js';

/**
 * application/packs/export: an applied workspace segment of an admin proposal as version 1 of a
 * capability pack (S11 AA5d-2; the AA5 plan's F7(a), the AA5d plan's forks 6–13). A platform
 * administrator exports it once what it applied is verified in the workspace it was applied to;
 * a maintainer puts the files in the extra packs directory (`registry.ts`), and every workspace
 * then installs it as any pack. Nothing is written here: the files are the answer.
 *
 * **What goes in.** The pack is named by the proposal's `sourceName`, the name the segment's new
 * Skill and Worker families were derived under (`derivePackComponentId(sourceName, kind, name)`),
 * so the pack's components have the ids those families have in that workspace — which reads the
 * pack `up_to_date` — and in any other they are installed under the same ids. Its components are
 * the segment's items in their order: each `ontology_version` (its definition, in the version's
 * own `ontology/<family>.yaml`), each `skill_version` (`skills/<name>.md`, the frontmatter and the
 * Skill's text), each `worker_definition_version` (`workers/<name>.yaml`, the definition the
 * segment applied without its name, plus the `systems` it names — never `gates` or `model`, the
 * workspace's own). `requires.connectors` is the systems its Workers name, in first-named order
 * (the registry refuses a Worker system the version does not require). An `operation_version`
 * item is not carried (`omitted`): a pack has no Operation component, and installed elsewhere that
 * gate keeps its own settings. `summary` and `notes` are the administrator's.
 *
 * **Refused, writing nothing** (`AdminProposalPackNotExportableError`, every problem found at once
 * except the first two, which come alone): the segment is not applied (`segment_not_applied`); what
 * it applied is not verified now (`not_verified`, governance 0039's answer — the platform reads no
 * more of the workspace); something the pack would carry looks like a credential
 * (`suspected_credentials`, by path: a pack ships none, so nothing is masked into one); a Skill's or
 * Worker's name is not a pack component's (`component_name_invalid`); a Worker mounts a Skill the
 * segment does not bring (`worker_skill_outside`); an item changes a component a pack of this
 * deployment has (`component_owned`); a different pack of that name is here (`pack_name_taken`;
 * the same one, by digest, gives its files again); nothing goes in (`no_components`); and the files,
 * read back by the registry's own loader in memory, are refused or differ from what the segment
 * applied (`not_a_valid_pack`, a Skill's text that starts with blank lines, say: the loader drops
 * them). So the same segment, summary and notes always give the same files and digest, and what
 * is exported is exactly what the registry will read.
 *
 * A segment that revised a family the workspace already had under another id (one it published
 * itself, not a pack's) is exported all the same: the pack's component is derived under the source
 * name, so that workspace reads it as not installed. Not refused, since the platform cannot see the
 * workspace's families; the PR and the runbook say so.
 */

/** Where an exported pack's version is, under the extra packs directory. */
const EXPORTED_VERSION = 1;

/** 409 `admin_proposal_pack_not_exportable`: the segment is not exported, and why
 *  (`details.problems`; this module's comment). */
export class AdminProposalPackNotExportableError extends Error {
  readonly code = 'admin_proposal_pack_not_exportable' as const;
  readonly details: { readonly problems: readonly AdminProposalPackExportProblemWire[] };
  constructor(segmentId: string, problems: readonly AdminProposalPackExportProblemWire[]) {
    super(
      `admin proposal segment ${segmentId} is not exported as a pack: ${problems.map((problem) => problem.code).join(', ')}`,
    );
    this.name = 'AdminProposalPackNotExportableError';
    this.details = { problems };
  }
}

export interface AdminProposalPackExportInput {
  readonly segmentId: string;
  readonly summary: string;
  readonly notes?: string;
}

/** What the pack is built from: the proposal's source name and the segment's items as stored. */
export interface AdminProposalPackSource {
  readonly sourceName: string;
  readonly items: readonly AdminProposalItemIntentWire[];
}

/** A component the pack carries, the item it comes from, and the digest of what that item applied
 *  — what the file read back must have (`packComponentDigest`). */
interface Carried {
  readonly index: number;
  readonly key: string;
  readonly file: string;
  readonly appliedDigest: string;
}

/** A component's kind and name as people read them. */
function describeKey(key: string): string {
  const [kind, ...rest] = key.split(':');
  const name = rest.join(':');
  return kind === 'ontology'
    ? `ontology family "${name}"`
    : `${kind === 'skill' ? 'Skill' : 'Worker'} "${name}"`;
}

/** A YAML document of `value`. Keys sorted where noted, so a file does not follow how the stored
 *  JSON happened to order them; `lineWidth: 0` keeps long strings on one line. */
function yamlOf(value: unknown, sortKeys: boolean): string {
  return stringifyYaml(value, { lineWidth: 0, sortMapEntries: sortKeys });
}

function credentialProblems(
  at: string,
  value: unknown,
  options: { readonly secretFields?: boolean } = {},
): AdminProposalPackExportProblemWire[] {
  const found = findSuspectedSecrets(value, options);
  if (found.count === 0) return [];
  const paths = found.paths.length > 0 ? found.paths : [''];
  return paths.map((path) => ({
    code: 'suspected_credentials' as const,
    path: path === '' ? at : `${at}.${path}`,
    message: 'looks like a credential; a pack ships none (change it in a new proposal)',
  }));
}

/**
 * The pack `source` gives (this module's comment), checked as the registry reads it: its files in
 * path order and its digest, or every problem found. Pure but for the loader's own reads of the
 * files in memory; `registry` is the deployment's packs now.
 */
export async function buildAdminProposalPack(
  source: AdminProposalPackSource,
  text: { readonly summary: string; readonly notes?: string },
  registry: PackRegistry,
): Promise<
  | { readonly ok: true; readonly pack: AdminProposalPackExportWire }
  | { readonly ok: false; readonly problems: readonly AdminProposalPackExportProblemWire[] }
> {
  const name = source.sourceName;
  const versionDir = `${name}/${EXPORTED_VERSION}`;
  const problems: AdminProposalPackExportProblemWire[] = [];
  const files = new Map<string, string>();
  const carried: Carried[] = [];
  const omitted: ExportedPackOmittedItemWire[] = [];
  const ontology: { family: string; domainPack: string }[] = [];
  const skills: string[] = [];
  const workers: string[] = [];
  const connectors: string[] = [];

  problems.push(...credentialProblems('summary', text.summary));
  if (text.notes !== undefined) problems.push(...credentialProblems('notes', text.notes));

  const skillNames = new Set(
    source.items.flatMap((item) => (item.kind === 'skill_version' ? [item.skill.name] : [])),
  );
  for (const [index, item] of source.items.entries()) {
    const at = `items[${index}]`;
    switch (item.kind) {
      case 'ontology_version': {
        const domainPack = `${item.family}.yaml`;
        const file = `${versionDir}/ontology/${domainPack}`;
        problems.push(...credentialProblems(`${at}.definition`, item.definition));
        ontology.push({ family: item.family, domainPack });
        files.set(file, yamlOf(item.definition, true));
        carried.push({
          index,
          key: `ontology:${item.family}`,
          file,
          appliedDigest: contentDigest(item.definition),
        });
        break;
      }
      case 'skill_version': {
        const content = {
          name: item.skill.name,
          description: item.skill.description,
          markdown: item.skill.markdown,
          applicable: item.skill.applicable ?? {},
        };
        if (!PACK_NAME_PATTERN.test(content.name)) {
          problems.push({
            code: 'component_name_invalid',
            path: `${at}.skill.name`,
            message: `"${content.name}" is not a pack component's name (lower-case words joined by hyphens, starting with a letter)`,
          });
        }
        problems.push(...credentialProblems(`${at}.skill`, content));
        const file = `${versionDir}/skills/${content.name}.md`;
        const frontmatter = {
          name: content.name,
          description: content.description,
          ...(Object.keys(content.applicable).length > 0 ? { applicable: content.applicable } : {}),
        };
        files.set(file, `---\n${yamlOf(frontmatter, false)}---\n${content.markdown}`);
        skills.push(content.name);
        carried.push({
          index,
          key: `skill:${content.name}`,
          file,
          appliedDigest: contentDigest(content),
        });
        break;
      }
      case 'worker_definition_version': {
        // A proposal's Worker is named, and its definition stored parsed (`checkAdminProposal`).
        const workerName = String(item.definition.name);
        if (!PACK_NAME_PATTERN.test(workerName)) {
          problems.push({
            code: 'component_name_invalid',
            path: `${at}.definition.name`,
            message: `"${workerName}" is not a pack component's name (lower-case words joined by hyphens, starting with a letter)`,
          });
        }
        const mounted = item.definition.skills;
        if (Array.isArray(mounted)) {
          for (const [j, skill] of mounted.entries()) {
            if (skillNames.has(String(skill))) continue;
            problems.push({
              code: 'worker_skill_outside',
              path: `${at}.definition.skills[${j}]`,
              message: `mounts Skill "${String(skill)}", which this segment does not bring; a pack's Worker mounts the pack's own Skills`,
            });
          }
        }
        problems.push(
          ...credentialProblems(`${at}.definition`, item.definition, { secretFields: true }),
        );
        const { name: _name, ...rest } = item.definition;
        const systems = item.systems ?? [];
        for (const system of systems) if (!connectors.includes(system)) connectors.push(system);
        const file = `${versionDir}/workers/${workerName}.yaml`;
        files.set(file, yamlOf({ ...rest, ...(systems.length > 0 ? { systems } : {}) }, true));
        workers.push(workerName);
        carried.push({
          index,
          key: `worker:${workerName}`,
          file,
          appliedDigest: contentDigest(item.definition),
        });
        break;
      }
      case 'operation_version':
        omitted.push({ index, kind: item.kind, gateId: item.gateId, name: item.name });
        break;
    }
  }

  if (carried.length === 0) {
    return {
      ok: false,
      problems: [
        {
          code: 'no_components',
          message:
            'nothing of this segment goes into a pack: it changes only how Operations are governed, which a pack does not carry',
        },
      ],
    };
  }

  // A component a pack of this deployment has: installed beside it, the registry would leave the
  // export out (`registry.ts`). The pack of the same name is the next check's.
  for (const entry of registry.values()) {
    if (entry.name === name) continue;
    const keys = new Set(
      entry.versions.flatMap((version) => version.components.map(packComponentKey)),
    );
    for (const component of carried) {
      if (!keys.has(component.key)) continue;
      problems.push({
        code: 'component_owned',
        path: `items[${component.index}]`,
        message: `changes ${describeKey(component.key)}, which the pack "${entry.name}" of this deployment has`,
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const manifest = {
    schema: PACK_CONTRACT_SCHEMA,
    name,
    version: EXPORTED_VERSION,
    summary: text.summary,
    notes: text.notes ?? '',
    breaking: false,
    ...(connectors.length > 0 ? { requires: { connectors } } : {}),
    components: {
      ...(ontology.length > 0 ? { ontology } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(workers.length > 0 ? { workers } : {}),
    },
  };
  files.set(`${versionDir}/pack.yaml`, yamlOf(manifest, false));

  // Read back as the registry will read it from the extra packs directory.
  let components: readonly PackComponent[];
  let digest: string;
  try {
    const entry = await loadPackEntry(memoryPackFiles('.', files), name, name, 'extra', 'version');
    const version = entry.versions[0];
    if (version === undefined) throw new Error('no version read back');
    components = version.components;
    digest = version.digest;
  } catch (err) {
    return {
      ok: false,
      problems: [
        {
          code: 'not_a_valid_pack',
          message: `the registry refuses the files: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const readBack = new Map(
    components.map((component) => [packComponentKey(component), packComponentDigest(component)]),
  );
  for (const component of carried) {
    if (readBack.get(component.key) === component.appliedDigest) continue;
    problems.push({
      code: 'not_a_valid_pack',
      path: `items[${component.index}]`,
      message: `${component.file} reads back differently from what the segment applied (a Skill's text that starts with blank lines, say), so the pack would not be what was verified`,
    });
  }
  if (problems.length > 0) return { ok: false, problems };

  const existing = registry.get(name);
  if (existing !== undefined && existing.versions[0]?.digest !== digest) {
    return {
      ok: false,
      problems: [
        {
          code: 'pack_name_taken',
          message: `this deployment already has a different pack named "${name}" (${existing.source === 'builtin' ? 'shipped with the platform' : 'an extra pack'})`,
        },
      ],
    };
  }
  const exported: ExportedPackFileWire[] = [...files]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    ok: true,
    pack: { name, version: EXPORTED_VERSION, digest, files: exported, omitted },
  };
}

interface ExportedSegmentRow {
  readonly status: string;
  readonly items: AdminProposalItemIntentWire[];
  readonly source_name: string;
}

/**
 * `export_admin_proposal_pack` (this module's comment), on the platform plane: the segment and its
 * proposal are read by RLS's platform rule, whether it is verified by governance 0039's function.
 * 404 for anything but a workspace segment; reads only.
 */
export async function exportAdminProposalPack(
  client: PoolClient,
  input: AdminProposalPackExportInput,
  registry: PackRegistry,
): Promise<AdminProposalPackExportWire> {
  const result = await client.query<ExportedSegmentRow>(
    `select s.status, s.items, p.source_name
       from admin_proposal_segments s
       join admin_proposals p on p.workspace_id = s.workspace_id and p.id = s.proposal_id
      where s.id = $1 and s.authority = 'workspace'`,
    [input.segmentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AdminProposalSegmentNotFoundError(input.segmentId, 'on this platform');
  }
  if (row.status !== 'applied') {
    throw new AdminProposalPackNotExportableError(input.segmentId, [
      {
        code: 'segment_not_applied',
        message: `the segment is ${row.status}: only an applied segment is exported`,
      },
    ]);
  }
  const verified = await client.query<{ verified: boolean }>(
    'select admin_proposal_segment_verified($1) as verified',
    [input.segmentId],
  );
  if (verified.rows[0]?.verified !== true) {
    throw new AdminProposalPackNotExportableError(input.segmentId, [
      {
        code: 'not_verified',
        message:
          'what the segment applied is not verified in its workspace now: once its owner has verified it there, export it',
      },
    ]);
  }
  const built = await buildAdminProposalPack(
    { sourceName: row.source_name, items: row.items },
    { summary: input.summary, ...(input.notes !== undefined ? { notes: input.notes } : {}) },
    registry,
  );
  if (!built.ok) throw new AdminProposalPackNotExportableError(input.segmentId, built.problems);
  return built.pack;
}
