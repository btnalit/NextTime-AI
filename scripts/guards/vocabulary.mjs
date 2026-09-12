#!/usr/bin/env node
// scripts/guards/vocabulary.mjs — S3.7 (docs/wire-contract-conventions.md §1/§5;
// docs/development-tasks.md S3.7 "词表守卫"): statically enforces the vocabulary table's own
// rules that a Zod schema or the capability registry could otherwise silently drift from. Wired
// into `pnpm ci:guards` (root package.json). Five independent checks; every violation found is
// collected and reported (offending file/capability named) before exiting non-zero — a check that
// finds nothing prints nothing and never blocks the others.
//
// Reads `@nexttime/shared`'s *built* dist output for (c)/(d)/(e) — same "import the built
// package" convention `scripts/contract-snapshot.mjs` already uses; `pnpm ci:guards` does not
// build it first, so run `pnpm --filter @nexttime/shared build` (or `pnpm contract:snapshot`)
// before this script if `dist/` is stale. (c)/(d)/(e) fail loudly with an ENOENT-shaped message
// rather than silently passing if `dist/` is missing entirely.
//
// Usage: node scripts/guards/vocabulary.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every violation collected across all five checks, `{check, message}` — printed and turned
 *  into a non-zero exit at the very end, so one check's failure never hides another's. */
const violations = [];

function fail(check, message) {
  violations.push({ check, message });
}

// Tracked files under a directory (relative to repo root) matching .ts, excluding .test.ts /
// .integration.test.ts — `git ls-files` naturally skips node_modules/dist/gitignored paths, the
// same enumeration convention .github/workflows/ci.yml's own guards job already uses. Two glob
// patterns are passed (a direct-children one and a nested one): git's pathspec glob does not
// treat a double-star segment as "zero or more directories" the way a shell glob would — the
// nested-only pattern alone silently skips a file directly in the given directory itself
// (verified empirically against gatekeeper-base/src/protocol.ts).
function listTrackedTsFiles(dir) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--', `${dir}/*.ts`, `${dir}/**/*.ts`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith('.test.ts'));
}

function readRepoFile(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** True for a line that is (or starts) a comment — `//` line comments and `/**`/`*`-prefixed
 *  JSDoc continuation lines, this codebase's own two comment styles (verified against its actual
 *  source, not just typical TS style). Deliberately line-based, not a real parser: (a)/(b) below
 *  only need to skip *prose that quotes code* (e.g. a doc comment showing "`{actionKind:
 *  z.string()}`" as a historical/before-state example) — real code that would trip either
 *  pattern is never itself comment-prefixed. */
export function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

// -------------------------------------------------------------------------------------------
// (a) any zod object key named `actionKind` holding a *bare string* schema, outside
// packages/shared/src/action-description.ts — docs/wire-contract-conventions.md §1: `actionKind`
// is reserved for ActionDescription's own `{tag,label}` display object (`ActionKindSchema`); a
// bare tag string must be named `actionKindTag` instead. Scoped to a bare-string value (not any
// zod value at all) so this does not flag a legitimate `actionKind: ActionKindSchema` reuse (the
// object shape) — packages/shared/src/events.ts's `action.pending` event is exactly that reuse.
// -------------------------------------------------------------------------------------------

export const ACTION_KIND_EXEMPT_FILE = 'packages/shared/src/action-description.ts';
export const BARE_STRING_ACTION_KIND_PATTERN = /\bactionKind\s*:\s*z\.string\s*\(/;

/** True when `line` (real code, not a comment — callers filter via `isCommentLine` first) is a
 *  Zod key declaration violating check (a). Pure — no filesystem access — so it is unit-testable
 *  in isolation from `listTrackedTsFiles`/`readRepoFile`. */
export function isBareStringActionKindLine(line) {
  return BARE_STRING_ACTION_KIND_PATTERN.test(line);
}

function checkActionKindVocabulary() {
  const candidateFiles = [
    ...listTrackedTsFiles('packages/shared/src'),
    ...listTrackedTsFiles('packages/kernel/src'),
  ];
  for (const file of candidateFiles) {
    if (file === ACTION_KIND_EXEMPT_FILE) continue;
    const content = readRepoFile(file);
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (isBareStringActionKindLine(line)) {
        fail(
          '(a) actionKind',
          `${file}:${index + 1}: a Zod key named "actionKind" holds a bare string schema — ` +
            `use "actionKindTag" instead ("actionKind" is reserved for the {tag,label} ` +
            `ActionDescription object, ${ACTION_KIND_EXEMPT_FILE})`,
        );
      }
    });
  }
}

// -------------------------------------------------------------------------------------------
// (b) `idempotencyKey` inside a Gatekeeper request/response Zod schema
// (packages/gatekeeper-base/src, gatekeepers/*/src) — docs/wire-contract-conventions.md §1: the
// gate protocol's own execution-preemption key is `actionRequestId`; `idempotencyKey` is reserved
// for `request_action`'s own caller-supplied dedupe param (packages/shared/src/capabilities.ts),
// a different key at a different layer (already renamed once, packages/gatekeeper-base/src/
// protocol.ts's own doc comment — this check guards the rename against regressing).
// -------------------------------------------------------------------------------------------

export const IDEMPOTENCY_KEY_ZOD_FIELD_PATTERN = /^\s*idempotencyKey\s*:\s*z\./;

export function isIdempotencyKeyZodFieldLine(line) {
  return IDEMPOTENCY_KEY_ZOD_FIELD_PATTERN.test(line);
}

function checkIdempotencyKeyVocabulary() {
  const candidateFiles = [
    ...listTrackedTsFiles('packages/gatekeeper-base/src'),
    ...listTrackedTsFiles('gatekeepers/docker/src'),
    ...listTrackedTsFiles('gatekeepers/ragflow/src'),
  ];
  for (const file of candidateFiles) {
    const content = readRepoFile(file);
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (isIdempotencyKeyZodFieldLine(line)) {
        fail(
          '(b) idempotencyKey',
          `${file}:${index + 1}: a Zod key named "idempotencyKey" appears in a Gatekeeper ` +
            `request/response schema — the gate protocol's execution-preemption key is ` +
            `"actionRequestId" (packages/gatekeeper-base/src/protocol.ts)`,
        );
      }
    });
  }
}

// -------------------------------------------------------------------------------------------
// (c)/(d)/(e) — checks over the capability registry itself (packages/shared/src/capabilities.ts),
// read from @nexttime/shared's built dist output.
// -------------------------------------------------------------------------------------------

async function loadSharedRegistry() {
  const distIndex = path.join(REPO_ROOT, 'packages', 'shared', 'dist', 'index.js');
  try {
    return await import(pathToFileURL(distIndex).href);
  } catch (err) {
    console.error(
      `vocabulary: could not import ${distIndex} — build @nexttime/shared first ` +
        `(\`pnpm --filter @nexttime/shared build\`, or \`pnpm contract:snapshot\`).`,
    );
    throw err;
  }
}

/**
 * (c) `mode: 'propose'` names / `propose_`|`request_`-prefixed names — docs/wire-contract-
 * conventions.md §1/§5: a `propose_*`/`request_*` capability produces a draft/request awaiting
 * human publish/approval, and only those names may carry `mode: 'propose'`.
 *
 * One documented, intentional exception both directions: `request_action` — its own registry
 * entry doc comment (packages/shared/src/capabilities.ts) explains why it is `mode: 'execute'`
 * (a Worker's execute-mode entry point onto a Gatekeeper, policy-approved — not a draft awaiting
 * publish) despite the `request_` prefix; `request_connection` (the actual propose-shaped
 * "request") already satisfies the rule normally. No `propose_*` name has ever needed this
 * exemption — this set exists to be as narrow as the real registry requires, not speculatively
 * wider.
 */
export const PROPOSE_REQUEST_PREFIX_MODE_EXEMPTIONS = new Set(['request_action']);

/** Pure check (c) evaluator for one `{name, mode}`-shaped capability — returns a violation
 *  message, or `null` when the capability is fine. Unit-testable with a plain object literal,
 *  no need to build/import the real registry. */
export function evaluateProposeModeCapability(capability) {
  if (PROPOSE_REQUEST_PREFIX_MODE_EXEMPTIONS.has(capability.name)) return null;
  const prefixed = capability.name.startsWith('propose_') || capability.name.startsWith('request_');
  if (capability.mode === 'propose' && !prefixed) {
    return `${capability.name}: mode "propose" but the name does not start with "propose_" or "request_"`;
  }
  if (prefixed && capability.mode !== 'propose') {
    return `${capability.name}: name starts with "propose_"/"request_" but mode is "${capability.mode}", not "propose"`;
  }
  return null;
}

function checkProposeModeVocabulary(registry) {
  for (const capability of registry.CAPABILITY_REGISTRY) {
    const message = evaluateProposeModeCapability(capability);
    if (message) fail('(c) propose mode', message);
  }
}

/**
 * (d) no `paramsSchema`/`resultSchema` key may be snake_case — docs/wire-contract-conventions.md
 * §2 "不返回数据库原始行"; every field name at the `packages/shared` wire boundary is camelCase.
 *
 * One documented, pre-existing exception: the Gatekeeper interface-manifest `Operation` shape
 * (`packages/shared/src/action-description.ts`'s `OperationSchema` and its binding/result-mapping
 * sub-shapes) is deliberately snake_case — that file's own module doc comment: "Operation field
 * shape is snake_case per the task brief and design doc §5.1.4/§7.5/§S2.4 verbatim... this is the
 * wire/YAML shape a Gatekeeper's interface manifest... produce[s]". It appears embedded inside
 * `publish_operation`'s `resultSchema` (the published draft's own definition, so the owner can see
 * exactly what just went live) — a separate, already-established contract, not a DB-row leak.
 */
export const OPERATION_MANIFEST_SNAKE_CASE_FIELDS = new Set([
  'params_schema',
  'blast_radius',
  'auto_approvable',
  'await_decision',
  'result_mapping',
  'tool_name',
  'command_template',
  'command_pattern',
  'jmes_path',
  'object_type',
  'identity_keys',
  // P-B1 (design §6.3 "MCP 信任分级"): the MCP tool annotations an imported Operation carries,
  // same manifest shape, same snake_case convention as the fields above.
  'read_only_hint',
  'destructive_hint',
  'idempotent_hint',
]);

export const SNAKE_CASE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** Pure check (d) evaluator for one property key — `true` when it violates the rule. */
export function isSnakeCaseViolation(key) {
  if (OPERATION_MANIFEST_SNAKE_CASE_FIELDS.has(key)) return false;
  return SNAKE_CASE_PATTERN.test(key);
}

/** Walks a `zod-to-json-schema` JSON Schema tree, collecting every object-`properties` key
 *  anywhere in it (nested objects, array items, union branches). */
export function collectPropertyKeys(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectPropertyKeys(item, out);
    return out;
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const key of Object.keys(node.properties)) {
      out.push(key);
      collectPropertyKeys(node.properties[key], out);
    }
  }
  if (node.items) collectPropertyKeys(node.items, out);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    collectPropertyKeys(node.additionalProperties, out);
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[combinator])) collectPropertyKeys(node[combinator], out);
  }
  return out;
}

function checkSnakeCaseKeys(registry) {
  const jsonSchemaOptions = { $refStrategy: 'none' };
  for (const capability of registry.CAPABILITY_REGISTRY) {
    const schemas = [
      ['paramsSchema', capability.paramsSchema],
      ['resultSchema', capability.resultSchema],
    ];
    for (const [field, schema] of schemas) {
      if (!schema) continue;
      const keys = collectPropertyKeys(zodToJsonSchema(schema, jsonSchemaOptions));
      for (const key of keys) {
        if (isSnakeCaseViolation(key)) {
          fail(
            '(d) snake_case key',
            `${capability.name}.${field}: key "${key}" is snake_case — every wire field name must be camelCase`,
          );
        }
      }
    }
  }
}

/**
 * (e) every `list_*`/`find_*`/`query_*`/`get_chat_history` capability's `resultSchema` must be a
 * `listEnvelope(...)` shape (docs/wire-contract-conventions.md §3) — detected structurally
 * (`{items: array, ...}` at the schema's own top level), not by identity, since `listEnvelope`'s
 * return value carries no separate brand.
 */
export function isListEnvelopeShape(jsonSchema) {
  return Boolean(
    jsonSchema &&
      typeof jsonSchema === 'object' &&
      jsonSchema.properties &&
      jsonSchema.properties.items &&
      jsonSchema.properties.items.type === 'array',
  );
}

export function isListShapedName(name) {
  return (
    name.startsWith('list_') ||
    name.startsWith('find_') ||
    name.startsWith('query_') ||
    name === 'get_chat_history'
  );
}

function checkListEnvelopeVocabulary(registry) {
  const jsonSchemaOptions = { $refStrategy: 'none' };
  for (const capability of registry.CAPABILITY_REGISTRY) {
    if (!isListShapedName(capability.name)) continue;
    if (!capability.resultSchema) {
      fail('(e) listEnvelope', `${capability.name}: list-shaped name but no resultSchema at all`);
      continue;
    }
    const jsonSchema = zodToJsonSchema(capability.resultSchema, jsonSchemaOptions);
    if (!isListEnvelopeShape(jsonSchema)) {
      fail(
        '(e) listEnvelope',
        `${capability.name}: list-shaped name ("list_"/"find_"/"query_"/"get_chat_history") but resultSchema is not a listEnvelope({items, nextCursor?})`,
      );
    }
  }
}

// -------------------------------------------------------------------------------------------

export async function main() {
  checkActionKindVocabulary();
  checkIdempotencyKeyVocabulary();

  const registry = await loadSharedRegistry();
  checkProposeModeVocabulary(registry);
  checkSnakeCaseKeys(registry);
  checkListEnvelopeVocabulary(registry);

  if (violations.length > 0) {
    console.error(`vocabulary: ${violations.length} violation(s) found:\n`);
    for (const violation of violations) {
      console.error(`  [${violation.check}] ${violation.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('vocabulary: no violations found.');
}

// Run only when executed directly (`node scripts/guards/vocabulary.mjs`), never on import — the
// unit test (vocabulary.test.mjs) imports this module's pure detector functions without wanting
// a full repo scan + process.exitCode side effect as an import-time surprise.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
