import type { AdminProposalItemIntentWire, AdminProposalPackExportWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseOntologyDefinition } from '../../substrate/ontology/index.js';
import { contentDigest } from '../change-plan/index.js';
import { type AdminProposalPackSource, buildAdminProposalPack } from './export.js';
import { objectTypeYaml } from './fixture.js';
import {
  type PackEntry,
  type PackRegistry,
  derivePackComponentId,
  loadPackEntry,
  memoryPackFiles,
} from './registry.js';

/** application/packs/export.test: an applied admin proposal segment as a pack (S11 AA5d-2) — the
 *  files, read back by the registry's loader, carry exactly what the segment applied, under the ids
 *  the source name derives; and every reason not to export is reported. */

const ONTOLOGY = parseOntologyDefinition(objectTypeYaml('Ticket'));

const SKILL: AdminProposalItemIntentWire = {
  kind: 'skill_version',
  skill: {
    name: 'ticket-triage',
    description: 'Triage a ticket: label it, say who should take it.',
    markdown: '# Triage\n\nRead the ticket, then label it.\n',
    applicable: { gateKinds: ['http'] },
  },
};

const WORKER: AdminProposalItemIntentWire = {
  kind: 'worker_definition_version',
  definition: {
    name: 'ticket-worker',
    systemPrompt: 'You triage tickets.',
    skills: ['ticket-triage'],
    description: 'Triages tickets',
  },
  systems: ['tickets'],
};

const OPERATION: AdminProposalItemIntentWire = {
  kind: 'operation_version',
  gateId: 'tickets-prod',
  name: 'ticket.close',
  set: { auto_approvable: false },
};

const SOURCE: AdminProposalPackSource = {
  sourceName: 'ticket-desk',
  items: [
    { kind: 'ontology_version', family: 'ticket-desk', definition: ONTOLOGY },
    SKILL,
    WORKER,
    OPERATION,
  ],
};

const TEXT = { summary: 'Ticket triage, from the admin agent.', notes: 'Closing stays approved.' };

const NONE: PackRegistry = new Map();

async function build(
  source: AdminProposalPackSource,
  registry: PackRegistry = NONE,
  text: { readonly summary: string; readonly notes?: string } = TEXT,
) {
  return buildAdminProposalPack(source, text, registry);
}

async function exported(source: AdminProposalPackSource, registry: PackRegistry = NONE) {
  const built = await build(source, registry);
  if (!built.ok) throw new Error(`not exported: ${JSON.stringify(built.problems)}`);
  return built.pack;
}

/** The pack's files read the way the registry reads the extra packs directory. */
async function readBack(pack: AdminProposalPackExportWire): Promise<PackEntry> {
  const files = new Map(pack.files.map((file) => [file.path, file.content]));
  return loadPackEntry(memoryPackFiles('.', files), pack.name, pack.name, 'extra', 'version');
}

function fileOf(pack: AdminProposalPackExportWire, path: string): string {
  const file = pack.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`no file ${path}`);
  return file.content;
}

describe('buildAdminProposalPack: the files', () => {
  it('carries the ontology family, Skill and Worker as applied, under the source name’s ids; leaves the Operation change out', async () => {
    const pack = await exported(SOURCE);
    expect(pack.name).toBe('ticket-desk');
    expect(pack.version).toBe(1);
    expect(pack.files.map((file) => file.path)).toEqual([
      'ticket-desk/1/ontology/ticket-desk.yaml',
      'ticket-desk/1/pack.yaml',
      'ticket-desk/1/skills/ticket-triage.md',
      'ticket-desk/1/workers/ticket-worker.yaml',
    ]);
    expect(pack.omitted).toEqual([
      { index: 3, kind: 'operation_version', gateId: 'tickets-prod', name: 'ticket.close' },
    ]);
    const entry = await readBack(pack);
    expect(entry.source).toBe('extra');
    const [version] = entry.versions;
    expect(version?.digest).toBe(pack.digest);
    expect(version?.summary).toBe(TEXT.summary);
    expect(version?.notes).toBe(TEXT.notes);
    expect(version?.requiredConnectors).toEqual(['tickets']);
    const components = version?.components ?? [];
    expect(components.map((component) => component.kind)).toEqual(['ontology', 'skill', 'worker']);
    const [ontology, skill, worker] = components;
    expect(ontology?.kind === 'ontology' && ontology.definitionDigest).toBe(
      contentDigest(ONTOLOGY),
    );
    expect(skill?.kind === 'skill' && skill.skillId).toBe(
      derivePackComponentId('ticket-desk', 'skill', 'ticket-triage'),
    );
    expect(skill?.kind === 'skill' && skill.contentDigest).toBe(
      contentDigest({
        name: 'ticket-triage',
        description: 'Triage a ticket: label it, say who should take it.',
        markdown: '# Triage\n\nRead the ticket, then label it.\n',
        applicable: { gateKinds: ['http'] },
      }),
    );
    expect(worker?.kind === 'worker' && worker.definitionId).toBe(
      derivePackComponentId('ticket-desk', 'worker', 'ticket-worker'),
    );
    expect(worker?.kind === 'worker' && worker.contentDigest).toBe(
      contentDigest((WORKER as { definition: Record<string, unknown> }).definition),
    );
    expect(worker?.kind === 'worker' && worker.systems).toEqual(['tickets']);
  });

  it('a Worker file has no name, gates or model, and names its systems; the manifest is Pack Contract v1', async () => {
    const pack = await exported(SOURCE);
    const worker = parseYaml(fileOf(pack, 'ticket-desk/1/workers/ticket-worker.yaml'));
    expect(worker).toEqual({
      description: 'Triages tickets',
      skills: ['ticket-triage'],
      systemPrompt: 'You triage tickets.',
      systems: ['tickets'],
    });
    expect(parseYaml(fileOf(pack, 'ticket-desk/1/pack.yaml'))).toEqual({
      schema: 1,
      name: 'ticket-desk',
      version: 1,
      summary: TEXT.summary,
      notes: TEXT.notes,
      breaking: false,
      requires: { connectors: ['tickets'] },
      components: {
        ontology: [{ family: 'ticket-desk', domainPack: 'ticket-desk.yaml' }],
        skills: ['ticket-triage'],
        workers: ['ticket-worker'],
      },
    });
  });

  it('the same segment, summary and notes give the same files and digest; notes left out are empty', async () => {
    expect(await exported(SOURCE)).toEqual(await exported(SOURCE));
    const built = await build(SOURCE, NONE, { summary: TEXT.summary });
    expect(built.ok && (await readBack(built.pack)).versions[0]?.notes).toBe('');
    expect(built.ok && built.pack.digest).not.toBe((await exported(SOURCE)).digest);
  });

  it('a Skill without applicable, and a segment with no Worker: no applicable key, no requires', async () => {
    const pack = await exported({
      sourceName: 'notes-only',
      items: [
        {
          kind: 'skill_version',
          skill: { name: 'take-notes', description: 'Take notes.', markdown: 'Write it down.' },
        },
      ],
    });
    expect(fileOf(pack, 'notes-only/1/skills/take-notes.md')).toBe(
      '---\nname: take-notes\ndescription: Take notes.\n---\nWrite it down.',
    );
    const manifest = parseYaml(fileOf(pack, 'notes-only/1/pack.yaml')) as Record<string, unknown>;
    expect(manifest.requires).toBeUndefined();
    expect((await readBack(pack)).versions[0]?.components).toHaveLength(1);
  });

  it('a pack of that name already here with the same digest: the same files again', async () => {
    const pack = await exported(SOURCE);
    const registry: PackRegistry = new Map([['ticket-desk', await readBack(pack)]]);
    expect(await exported(SOURCE, registry)).toEqual(pack);
  });
});

describe('buildAdminProposalPack: refused, with every reason', () => {
  it('nothing goes in: only Operation changes', async () => {
    const built = await build({ sourceName: 'ops-only', items: [OPERATION] });
    expect(built.ok).toBe(false);
    expect(!built.ok && built.problems.map((problem) => problem.code)).toEqual(['no_components']);
  });

  it('names a pack component cannot have, and a Worker mounting a Skill the segment does not bring', async () => {
    const built = await build({
      sourceName: 'bad-names',
      items: [
        {
          kind: 'skill_version',
          skill: { name: '2fa-check', description: 'Check 2FA.', markdown: 'Check it.' },
        },
        {
          kind: 'worker_definition_version',
          definition: {
            name: 'Ticket Worker',
            systemPrompt: 'p',
            skills: ['2fa-check', 'elsewhere'],
          },
        },
      ],
    });
    expect(!built.ok && built.problems.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'component_name_invalid', path: 'items[0].skill.name' },
      { code: 'component_name_invalid', path: 'items[1].definition.name' },
      { code: 'worker_skill_outside', path: 'items[1].definition.skills[1]' },
    ]);
  });

  it('a suspected credential, by path and never its value — in the content, the summary or the notes', async () => {
    const token = `gh${'p_'}${'a1B2c3D4'.repeat(4)}`;
    const built = await build(
      {
        sourceName: 'leaky',
        items: [
          {
            kind: 'skill_version',
            skill: {
              name: 'leaky-skill',
              description: 'Leaks.',
              markdown: `Use ${token} to log in.`,
            },
          },
          {
            kind: 'worker_definition_version',
            definition: { name: 'leaky-worker', systemPrompt: 'p', description: 'd' },
          },
        ],
      },
      NONE,
      { summary: `token ${token}`, notes: 'fine' },
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    const paths = built.problems
      .filter((problem) => problem.code === 'suspected_credentials')
      .map((problem) => problem.path);
    expect(paths).toContain('summary');
    expect(paths).toContain('items[0].skill.markdown');
    for (const problem of built.problems) expect(JSON.stringify(problem)).not.toContain(token);
  });

  it('a suspected credential in a Worker: its own problem, at its path, not left to the loader', async () => {
    const token = `gh${'p_'}${'a1B2c3D4'.repeat(4)}`;
    const built = await build({
      sourceName: 'leaky-worker-pack',
      items: [
        {
          kind: 'worker_definition_version',
          definition: {
            name: 'leaky-worker',
            systemPrompt: `Log in with ${token}.`,
            description: 'd',
          },
        },
      ],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(
      built.problems
        .filter((problem) => problem.code === 'suspected_credentials')
        .map((problem) => problem.path),
    ).toEqual(['items[0].definition.systemPrompt']);
    for (const problem of built.problems) expect(JSON.stringify(problem)).not.toContain(token);
  });

  it('a suspected credential in an ontology family: its own problem, at its path, not left to the loader', async () => {
    const token = `gh${'p_'}${'a1B2c3D4'.repeat(4)}`;
    const definition = parseOntologyDefinition(
      objectTypeYaml('Ticket').replace('description: d', `description: "log in with ${token}"`),
    );
    const built = await build({
      sourceName: 'leaky-ontology',
      items: [{ kind: 'ontology_version', family: 'leaky-ontology', definition }],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems.map((problem) => problem.code)).toEqual(['suspected_credentials']);
    expect(built.problems[0]?.path).toBe('items[0].definition.objectTypes[0].description');
    for (const problem of built.problems) expect(JSON.stringify(problem)).not.toContain(token);
  });

  it('a component a pack of this deployment has', async () => {
    const other = await exported({ sourceName: 'other-pack', items: [SKILL] });
    const registry: PackRegistry = new Map([['other-pack', await readBack(other)]]);
    const built = await build(SOURCE, registry);
    expect(!built.ok && built.problems).toEqual([
      {
        code: 'component_owned',
        path: 'items[1]',
        message:
          'changes Skill "ticket-triage", which the pack "other-pack" of this deployment has',
      },
    ]);
  });

  it('a different pack of that name is here', async () => {
    const earlier = await build(SOURCE, NONE, { summary: 'An earlier export.' });
    if (!earlier.ok) throw new Error('earlier export refused');
    const registry: PackRegistry = new Map([['ticket-desk', await readBack(earlier.pack)]]);
    const built = await build(SOURCE, registry);
    expect(!built.ok && built.problems.map((problem) => problem.code)).toEqual(['pack_name_taken']);
  });

  it('files that read back differently from what was applied: a Skill’s text starting with blank lines', async () => {
    const built = await build({
      sourceName: 'spaced',
      items: [
        {
          kind: 'skill_version',
          skill: { name: 'spaced-skill', description: 'Spaced.', markdown: '\n\nAfter a gap.' },
        },
      ],
    });
    expect(!built.ok && built.problems.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'not_a_valid_pack', path: 'items[0]' },
    ]);
  });

  it('files the registry refuses: a Worker capability no Worker can hold', async () => {
    const built = await build({
      sourceName: 'too-strong',
      items: [
        {
          kind: 'worker_definition_version',
          definition: { name: 'strong-worker', systemPrompt: 'p', capabilities: ['publish_skill'] },
        },
      ],
    });
    expect(!built.ok && built.problems.map((problem) => problem.code)).toEqual([
      'not_a_valid_pack',
    ]);
    expect(!built.ok && built.problems[0]?.message).toMatch(/can never hold/);
  });
});
