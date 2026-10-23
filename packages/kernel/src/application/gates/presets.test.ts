import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConnectorPreset,
  ConnectorPresetError,
  loadConnectorPresets,
  withPresetOperations,
} from './presets.js';
import type { HostedGateDefinition } from './store.js';

/**
 * application/gates/presets.test: the connector presets this repository ships load (S11 P1-F), and
 * each rule a preset keeps refuses the whole set.
 */

const KB_LIST = {
  name: 'kb.list',
  description: 'List the knowledge bases.',
  binding: { kind: 'http', method: 'GET', path: '/api/v1/datasets' },
  params_schema: { type: 'object', properties: {}, additionalProperties: false },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

const PRESET_YAML = [
  'schema: 1',
  'name: wiki',
  'displayName: Wiki',
  'summary: Search the wiki.',
  'transportKind: http',
  'credentialMode: shared',
  'targetHint: The address of the wiki.',
  'credentialHint: An API key of the wiki.',
  '',
].join('\n');

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function presetsDir(
  files: Record<string, { readonly preset?: string; readonly operations?: unknown }>,
): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), 'connector-presets-'));
  for (const [dir, content] of Object.entries(files)) {
    await mkdir(path.join(root, dir), { recursive: true });
    if (content.preset !== undefined) {
      await writeFile(path.join(root, dir, 'preset.yaml'), content.preset);
    }
    if (content.operations !== undefined) {
      await writeFile(
        path.join(root, dir, 'operations.json'),
        JSON.stringify(content.operations, null, 2),
      );
    }
  }
  return root;
}

async function refusal(
  files: Record<string, { readonly preset?: string; readonly operations?: unknown }>,
): Promise<string> {
  const dir = await presetsDir(files);
  const thrown = await loadConnectorPresets({ presetsDir: dir }).then(
    () => {
      throw new Error('expected a ConnectorPresetError, but the presets loaded');
    },
    (err: unknown) => err,
  );
  expect(thrown).toBeInstanceOf(ConnectorPresetError);
  return (thrown as Error).message;
}

describe('loadConnectorPresets (S11 P1-F)', () => {
  it("loads the repository's RAGFlow preset: http, one shared key, four Operations and no upload", async () => {
    const presets = await loadConnectorPresets();
    const ragflow = presets.find((preset) => preset.name === 'ragflow');
    expect(ragflow).toMatchObject({
      name: 'ragflow',
      displayName: 'RAGFlow',
      transportKind: 'http',
      credentialMode: 'shared',
    });
    expect(ragflow?.operations.map((operation) => operation.name)).toEqual([
      'kb.list',
      'kb.documents',
      'retrieve',
      'document.parse',
    ]);
  });

  it('loads a well-formed preset with its Operations', async () => {
    const dir = await presetsDir({ wiki: { preset: PRESET_YAML, operations: [KB_LIST] } });
    const [wiki] = await loadConnectorPresets({ presetsDir: dir });
    expect(wiki).toMatchObject({ name: 'wiki', credentialHint: 'An API key of the wiki.' });
    expect(wiki?.operations).toHaveLength(1);
  });

  it('refuses a preset whose directory is not its name', async () => {
    expect(await refusal({ 'other-name': { preset: PRESET_YAML, operations: [KB_LIST] } })).toMatch(
      /the directory is the preset's name/,
    );
  });

  it('refuses a preset named after a transport', async () => {
    expect(
      await refusal({
        http: { preset: PRESET_YAML.replace('name: wiki', 'name: http'), operations: [KB_LIST] },
      }),
    ).toMatch(/names a transport/);
  });

  it('refuses an unknown field and an mcp preset', async () => {
    expect(
      await refusal({
        wiki: { preset: `${PRESET_YAML}target: https://wiki.example.com\n`, operations: [KB_LIST] },
      }),
    ).toMatch(/Unrecognized key/);
    expect(
      await refusal({
        wiki: {
          preset: PRESET_YAML.replace('transportKind: http', 'transportKind: mcp'),
          operations: [KB_LIST],
        },
      }),
    ).toMatch(/transportKind/);
  });

  it('refuses missing, empty, malformed, mis-bound or repeated Operations', async () => {
    expect(await refusal({ wiki: { preset: PRESET_YAML } })).toMatch(
      /operations\.json.*cannot be read/,
    );
    expect(await refusal({ wiki: { preset: PRESET_YAML, operations: [] } })).toMatch(
      /non-empty array/,
    );
    expect(
      await refusal({ wiki: { preset: PRESET_YAML, operations: [{ name: 'kb.list' }] } }),
    ).toMatch(/Operation 0/);
    expect(
      await refusal({
        wiki: {
          preset: PRESET_YAML,
          operations: [{ ...KB_LIST, binding: { kind: 'mcp', tool_name: 'list' } }],
        },
      }),
    ).toMatch(/bound to mcp, not the preset's http/);
    expect(
      await refusal({ wiki: { preset: PRESET_YAML, operations: [KB_LIST, KB_LIST] } }),
    ).toMatch(/listed twice/);
  });

  it('refuses a preset carrying a credential', async () => {
    expect(
      await refusal({
        wiki: {
          preset: PRESET_YAML.replace(
            'credentialHint: An API key of the wiki.',
            'credentialHint: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"',
          ),
          operations: [KB_LIST],
        },
      }),
    ).toMatch(/suspected credential/);
  });

  it('refuses a presets directory that cannot be read', async () => {
    await expect(
      loadConnectorPresets({ presetsDir: path.join(tmpdir(), 'no-such-presets-dir-p1f') }),
    ).rejects.toBeInstanceOf(ConnectorPresetError);
  });
});

describe('withPresetOperations (S11 P1-F)', () => {
  const definition = (preset?: string): HostedGateDefinition['definition'] => ({
    transportKind: 'http',
    target: 'https://wiki.example.com',
    credentialMode: 'shared',
    manifestSource: preset === undefined ? 'https://wiki.example.com/openapi.json' : null,
    ...(preset !== undefined ? { preset } : {}),
  });
  const item = (gateId: string, preset?: string): HostedGateDefinition => ({
    gateId,
    displayName: gateId,
    connector: preset ?? 'http',
    status: 'enabled',
    definition: definition(preset),
  });

  it("hands a preset instance its preset's Operations, and nothing to any other instance", async () => {
    const dir = await presetsDir({ wiki: { preset: PRESET_YAML, operations: [KB_LIST] } });
    const presets: readonly ConnectorPreset[] = await loadConnectorPresets({ presetsDir: dir });
    const [fromPreset, imported, unshipped] = withPresetOperations(
      [item('wiki-1', 'wiki'), item('plain'), item('gone-1', 'gone')],
      presets,
    );
    expect(fromPreset?.operations?.map((operation) => operation.name)).toEqual(['kb.list']);
    expect(imported).not.toHaveProperty('operations');
    expect(unshipped).not.toHaveProperty('operations');
  });
});
