#!/usr/bin/env node
// scripts/contract-snapshot.mjs — S3.7 (docs/wire-contract-conventions.md §4/§5;
// docs/development-tasks.md S3.7): serializes every capability's params/result Zod schema and the
// platform event vocabulary into deterministic JSON "contract snapshots" under docs/contracts/,
// and can diff a freshly-generated snapshot against the committed one (`--check`, CI's `quality`
// job) so an unreviewed wire-shape change fails the build instead of silently landing.
//
// Reads `@nexttime/shared`'s *built* dist output (`../packages/shared/dist/index.js`), the same
// "import the built package, not its TS source" convention `scripts/gen-models-json.ts` already
// established — this is a plain root-level .mjs script, no ts-node/tsx loader configured for it.
// `pnpm contract:snapshot`/`contract:check` (root package.json) both build @nexttime/shared first.
//
// Usage:
//   node scripts/contract-snapshot.mjs           # regenerate docs/contracts/*.json in place
//   node scripts/contract-snapshot.mjs --check    # regenerate to a temp dir and diff; exit 1 on
//                                                  # drift, with a message pointing at
//                                                  # `pnpm contract:snapshot`

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CAPABILITY_REGISTRY, PlatformEventSchema } from '../packages/shared/dist/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS_DIR = path.join(REPO_ROOT, 'docs', 'contracts');
const CAPABILITIES_FILE = path.join(CONTRACTS_DIR, 'capabilities.json');
const EVENTS_FILE = path.join(CONTRACTS_DIR, 'events.json');

/** Recursively sorts every plain object's own keys (alphabetically) so the JSON output never
 *  drifts on insertion order alone — arrays keep their own order (semantically meaningful:
 *  `required`, `enum`, `anyOf`, ...). `zod-to-json-schema`'s output is plain JSON-shaped data
 *  (objects/arrays/primitives) — no need to special-case any other value kind. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

const JSON_SCHEMA_OPTIONS = { $refStrategy: 'none' };

function buildCapabilitiesSnapshot() {
  const entries = CAPABILITY_REGISTRY.map((capability) => ({
    name: capability.name,
    group: capability.group,
    mode: capability.mode,
    channel: capability.channel,
    ...(capability.minRole !== undefined ? { minRole: capability.minRole } : {}),
    params: zodToJsonSchema(capability.paramsSchema, JSON_SCHEMA_OPTIONS),
    // Every registry entry carries one as of S3.7 (packages/shared/src/capabilities.ts's own
    // module doc comment) — `null` is defensive only, never expected in practice.
    result: capability.resultSchema
      ? zodToJsonSchema(capability.resultSchema, JSON_SCHEMA_OPTIONS)
      : null,
  }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return sortKeysDeep(entries);
}

function buildEventsSnapshot() {
  return sortKeysDeep(zodToJsonSchema(PlatformEventSchema, JSON_SCHEMA_OPTIONS));
}

function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeSnapshots(dir) {
  writeFileSync(path.join(dir, 'capabilities.json'), renderJson(buildCapabilitiesSnapshot()));
  writeFileSync(path.join(dir, 'events.json'), renderJson(buildEventsSnapshot()));
}

function readExisting(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function main() {
  const check = process.argv.includes('--check');

  if (!check) {
    writeSnapshots(CONTRACTS_DIR);
    console.log(`contract-snapshot: wrote ${CAPABILITIES_FILE} and ${EVENTS_FILE}`);
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'nexttime-contract-snapshot-'));
  try {
    writeSnapshots(tempDir);
    const freshCapabilities = readFileSync(path.join(tempDir, 'capabilities.json'), 'utf8');
    const freshEvents = readFileSync(path.join(tempDir, 'events.json'), 'utf8');
    const committedCapabilities = readExisting(CAPABILITIES_FILE);
    const committedEvents = readExisting(EVENTS_FILE);

    const drifted = [];
    if (freshCapabilities !== committedCapabilities) drifted.push('docs/contracts/capabilities.json');
    if (freshEvents !== committedEvents) drifted.push('docs/contracts/events.json');

    if (drifted.length > 0) {
      console.error(
        `contract:check: the committed contract snapshot(s) are out of date with the actual capability/event registry:\n` +
          drifted.map((f) => `  - ${f}`).join('\n') +
          `\n\nRun \`pnpm contract:snapshot\` and commit the result; describe the wire-shape change in your PR description.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log('contract:check: docs/contracts/*.json match the current registry.');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
