import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTOR_NAME_PATTERN,
  type Operation,
  OperationSchema,
  isGenericConnector,
} from '@nexttime/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import type { HostedGateDefinition } from './store.js';

/**
 * application/gates/presets: connector presets (S11 P1-F; S10 plan §6.2 "连接器预设"). A preset is
 * a template of a gate-host instance of one system, shipped with the platform — `connectors/<name>/`
 * in the repository, copied into the kernel image (`CONNECTOR_PRESETS_DIR`):
 *   - `preset.yaml` — the shape below: the system's name (which is also the connector its instances
 *     join), the transport kind, the credential mode, and what the administrator reads;
 *   - `operations.json` — the Operations an instance announces, written and classified by hand like
 *     a packaged gate's manifest (an http instance otherwise imports them from the target's OpenAPI
 *     document, unclassified).
 * A preset never carries an address or a credential (I-A5): `create_gate_instance` with `preset`
 * takes the address, and the credential goes from the browser to the gate host as for any instance.
 *
 * It is platform content, not a pack component: creating a gate instance is a platform
 * administrator's act (the platform segment, still a manual step in P1, S11 plan §5.4), so a pack
 * only names the system it needs (`requires.connectors`) and the console sends the administrator to
 * the preset of that name.
 *
 * The Operations reach the gate host with the instance's definition (`GET /internal/gate-host/
 * instances`), read from the preset of the running image at each pull — an upgrade that changes a
 * preset's Operations is re-announced by the host and held for the administrator like any gate's
 * changed manifest (R-18 `pendingManifest`), never in effect before they confirm it.
 *
 * Loaded on each call like the pack registry (`packs/registry.ts`): a handful of small files.
 * Every rule is checked when a preset loads, and one that breaks a rule refuses the whole set —
 * presets ship with the image, so that is a deployment bug a test catches first
 * (`presets.test.ts` loads the repository's own).
 */

/** The only `schema` this platform reads. */
export const CONNECTOR_PRESET_SCHEMA = 1;

const PresetFileSchema = z
  .object({
    schema: z.literal(CONNECTOR_PRESET_SCHEMA),
    name: z
      .string()
      .regex(CONNECTOR_NAME_PATTERN)
      .refine((name) => !isGenericConnector(name), {
        message: 'names a transport (http, mcp, cli, ssh), not a system',
      }),
    displayName: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1),
    /** Presets bring their Operations, which only an http instance takes (an mcp instance lists
     *  them on the target); an mcp preset joins this schema when one is needed. */
    transportKind: z.literal('http'),
    credentialMode: z.enum(['shared', 'connected_account']),
    targetHint: z.string().trim().min(1),
    credentialHint: z.string().trim().min(1),
  })
  .strict();

export interface ConnectorPreset {
  readonly name: string;
  readonly displayName: string;
  readonly summary: string;
  readonly transportKind: 'http';
  readonly credentialMode: 'shared' | 'connected_account';
  readonly targetHint: string;
  readonly credentialHint: string;
  readonly operations: readonly Operation[];
}

/** A preset file that is not this shape, or breaks one of its rules — a deployment bug. */
export class ConnectorPresetError extends Error {
  constructor(source: string, reason: string, options?: { cause?: unknown }) {
    super(`connector preset "${source}": ${reason}`, options);
    this.name = 'ConnectorPresetError';
  }
}

// `connectors/` is repo-root content like `packs/` (`packs/registry.ts`'s `resolvePacksDir`): the
// image copies it to /app/connectors and sets CONNECTOR_PRESETS_DIR; the relative fallback is local
// development's.
function defaultPresetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = packages/kernel/{src,dist}/application/gates: five levels up is the repo root.
  return path.join(here, '..', '..', '..', '..', '..', 'connectors');
}

/** The `connectors/` directory: `CONNECTOR_PRESETS_DIR` when set (always, in the image), else the
 *  repo root's. */
export function resolveConnectorPresetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONNECTOR_PRESETS_DIR || defaultPresetsDir();
}

async function readPresetFile(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    throw new ConnectorPresetError(file, `cannot be read: ${String(err)}`, { cause: err });
  }
}

function parseOperations(text: string, source: string, kind: 'http'): Operation[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConnectorPresetError(source, `not JSON: ${String(err)}`, { cause: err });
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConnectorPresetError(source, 'is a non-empty array of Operations');
  }
  const operations: Operation[] = [];
  const names = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const parsed = OperationSchema.safeParse(entry);
    if (!parsed.success) {
      throw new ConnectorPresetError(source, `Operation ${index}: ${parsed.error.message}`);
    }
    const operation = parsed.data;
    if (operation.binding.kind !== kind) {
      throw new ConnectorPresetError(
        source,
        `Operation "${operation.name}" is bound to ${operation.binding.kind}, not the preset's ${kind}`,
      );
    }
    if (names.has(operation.name)) {
      throw new ConnectorPresetError(source, `Operation "${operation.name}" is listed twice`);
    }
    names.add(operation.name);
    operations.push(operation);
  }
  return operations;
}

async function loadPreset(dir: string, directoryName: string): Promise<ConnectorPreset> {
  const source = path.join(dir, directoryName, 'preset.yaml');
  let raw: unknown;
  try {
    raw = parseYaml(await readPresetFile(source));
  } catch (err) {
    if (err instanceof ConnectorPresetError) throw err;
    throw new ConnectorPresetError(source, `not YAML: ${String(err)}`, { cause: err });
  }
  const parsed = PresetFileSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorPresetError(source, parsed.error.message);
  const file = parsed.data;
  if (file.name !== directoryName) {
    throw new ConnectorPresetError(
      source,
      `is named "${file.name}" but sits in "${directoryName}/"; the directory is the preset's name`,
    );
  }
  const operationsSource = path.join(dir, directoryName, 'operations.json');
  const operations = parseOperations(
    await readPresetFile(operationsSource),
    operationsSource,
    file.transportKind,
  );
  const preset: ConnectorPreset = {
    name: file.name,
    displayName: file.displayName,
    summary: file.summary,
    transportKind: file.transportKind,
    credentialMode: file.credentialMode,
    targetHint: file.targetHint,
    credentialHint: file.credentialHint,
    operations,
  };
  // I-A5: a preset is shipped content an administrator applies without reading every field — it
  // must not carry a credential, in a hint, a binding or a schema default.
  const found = findSuspectedSecrets(preset);
  if (found.count > 0) {
    throw new ConnectorPresetError(
      source,
      `carries ${found.count} suspected credential value(s) (at ${found.paths.join(', ')}); a preset ships no credentials`,
    );
  }
  return preset;
}

export interface ConnectorPresetOptions {
  /** Default `resolveConnectorPresetsDir()`. */
  readonly presetsDir?: string;
}

/** Every preset this deployment ships, by name order. */
export async function loadConnectorPresets(
  options: ConnectorPresetOptions = {},
): Promise<readonly ConnectorPreset[]> {
  const dir = options.presetsDir ?? resolveConnectorPresetsDir();
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new ConnectorPresetError(dir, `cannot be read: ${String(err)}`, { cause: err });
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  const presets: ConnectorPreset[] = [];
  for (const name of names) presets.push(await loadPreset(dir, name));
  return presets;
}

/**
 * What the gate host pulls (`GET /internal/gate-host/instances`): each instance made from a preset
 * carries that preset's Operations as this image ships them, so the host builds it without asking
 * the target. An upgrade that changes them reaches the host at its next pull; the host rebuilds the
 * instance (keeping its credential — the address it goes to has not changed) and re-announces, and
 * the kernel holds the changed manifest for the administrator (R-18) like any gate's. An instance
 * whose preset this image no longer ships carries none: the host keeps whatever it already built
 * and says why, never building it from nothing.
 */
export function withPresetOperations(
  items: readonly HostedGateDefinition[],
  presets: readonly ConnectorPreset[],
): HostedGateDefinition[] {
  const byName = new Map(presets.map((preset) => [preset.name, preset]));
  return items.map((item) => {
    const name = item.definition.preset;
    const preset = name === undefined ? undefined : byName.get(name);
    return preset ? { ...item, operations: preset.operations } : item;
  });
}
