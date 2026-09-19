#!/usr/bin/env node
// scripts/guards/prompt-contract.mjs — S5.4 (docs/development-tasks.md S5.4; docs/retrospective-
// 2026-09-11.md §3.1 "教训": the fake-llm double never validated a tool's own schema shape, so a
// real-provider-breaking bug passed S2 for weeks — this guard closes the same class of gap one
// layer up, for the *prompt text itself*: a `systemPrompt` that names a tool the model cannot
// actually call, or a result-contract key that does not match the schema, drifted silently on main
// for weeks after H1/H2 in the 2026-09-09 prompt audit — nothing in CI checked it). Wired into
// `pnpm ci:guards` (root package.json), right after `vocabulary.mjs`.
//
// What it checks: every backtick-quoted identifier in each `ontology/*.yaml`'s `systemPrompt`
// string must be one of:
//   - the structural gate-tool placeholder `<gate>.<op>` (design doc §7.4/§9.3), or
//   - a tool that mode actually registers — entry: `ENTRY_TOOL_CAPABILITY_NAMES`
//     (packages/platform-extension/src/modes/entry.ts) intersected with the capability registry
//     (docs/contracts/capabilities.json); worker: the static `report_result` tool
//     (packages/platform-extension/src/modes/worker.ts's `REPORT_RESULT_TOOL_NAME`), or
//   - (ops-runner.yaml only) a `WorkerResultContractSchema` key (packages/shared/src/
//     worker-result.ts) — a Worker's prompt documents `report_result`'s param names, not a
//     separate callable tool, or
//   - an explicitly allow-listed non-tool word (`ALLOWED_NON_TOOL_WORDS` below), each with a short
//     reason — kept as short as the prompt text actually requires, never a way to silence this
//     guard wholesale.
//
// Deliberately narrow extraction (`candidateIdentifier`): only a bare identifier, or a bare
// identifier immediately followed by `(` (a call-signature example like `` `invoke_worker(...)` ``
// — only the leading name is checked, not its argument list), is treated as a candidate at all.
// Prose spans (anything with a space, a hyphen, a colon, braces, …) are skipped outright — every
// real drift this task found (H1's `facts_to_assert`, H2's `describe_operations`) was a bare
// identifier, and a prose-parsing guard would need to be far more invasive for no proven benefit.
//
// Reads @nexttime/shared's *built* dist output (same convention `vocabulary.mjs` uses) — build it
// first if `dist/` is stale (`pnpm --filter @nexttime/shared build`, or `pnpm contract:snapshot`).
//
// Usage: node scripts/guards/prompt-contract.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function readRepoFile(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

// -------------------------------------------------------------------------------------------
// Backtick-identifier extraction — pure, no filesystem access, unit-testable in isolation
// (prompt-contract.test.mjs).
// -------------------------------------------------------------------------------------------

export const GATE_PLACEHOLDER = '<gate>.<op>';
const BAREWORD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const CALL_SIGNATURE_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)\(/;

/** Classifies one backtick span's content into a candidate identifier worth checking, or `null`
 *  when it is prose/a code example this guard does not attempt to parse further — see this file's
 *  own header comment for why that narrow scope is sufficient. */
export function candidateIdentifier(span) {
  if (span === GATE_PLACEHOLDER) return GATE_PLACEHOLDER;
  if (BAREWORD_PATTERN.test(span)) return span;
  const callMatch = CALL_SIGNATURE_PATTERN.exec(span);
  if (callMatch) return callMatch[1];
  return null;
}

/** Extracts every backtick-quoted span from `text`, in order (a span never crosses a newline —
 *  every real usage in these prompts is a single-line inline code span). */
export function extractBacktickSpans(text) {
  const spans = [];
  const re = /`([^`\n]+)`/g;
  let match = re.exec(text);
  while (match) {
    spans.push(match[1]);
    match = re.exec(text);
  }
  return spans;
}

/** Every candidate identifier a `systemPrompt` string's backtick spans name (duplicates removed,
 *  in first-seen order) — spans `candidateIdentifier` classifies as `null` (prose/code examples)
 *  are dropped. */
export function extractCandidateIdentifiers(systemPrompt) {
  const out = [];
  const seen = new Set();
  for (const span of extractBacktickSpans(systemPrompt)) {
    const candidate = candidateIdentifier(span);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Mode tool sets — sourced from the real code, not hand-duplicated, so this guard cannot drift
// from what a mode actually registers.
// -------------------------------------------------------------------------------------------

/**
 * Line-based extraction of a `const NAME = [...] as const;` string-array literal — comment lines
 * are stripped first (same convention `vocabulary.mjs`'s own `isCommentLine` uses), so a comment
 * that happens to contain an apostrophe (e.g. "entry-agent.yaml's own capabilities") is never
 * misread as a string literal. Static text parsing, not a TS loader — this guard runs as plain ESM
 * via `node`, same constraint `vocabulary.mjs`'s own header comment documents.
 */
export function extractStringArrayLiteral(source, constName) {
  const declRe = new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`);
  const match = declRe.exec(source);
  if (!match) {
    throw new Error(`prompt-contract: could not find "${constName} = [...] as const" in source`);
  }
  const body = match[1]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const names = [];
  const stringRe = /'([^']+)'/g;
  let stringMatch = stringRe.exec(body);
  while (stringMatch) {
    names.push(stringMatch[1]);
    stringMatch = stringRe.exec(body);
  }
  return names;
}

/** worker mode's own static tool name (packages/platform-extension/src/modes/worker.ts's
 *  `REPORT_RESULT_TOOL_NAME`) — not a registry capability (it has no `CAPABILITY_REGISTRY` entry;
 *  its schema is `WorkerResultContractSchema`), so it is named directly here rather than sourced
 *  from the registry the way entry's tool set is. */
export const WORKER_REPORT_RESULT_TOOL_NAME = 'report_result';

function loadCapabilityRegistryNames() {
  const raw = readRepoFile('docs/contracts/capabilities.json');
  return new Set(JSON.parse(raw).map((entry) => entry.name));
}

async function loadSharedRegistry() {
  const distIndex = path.join(REPO_ROOT, 'packages', 'shared', 'dist', 'index.js');
  try {
    return await import(pathToFileURL(distIndex).href);
  } catch (err) {
    console.error(
      `prompt-contract: could not import ${distIndex} — build @nexttime/shared first (\`pnpm --filter @nexttime/shared build\`, or \`pnpm contract:snapshot\`).`,
    );
    throw err;
  }
}

async function loadModeToolSets() {
  const registryNames = loadCapabilityRegistryNames();

  const entrySource = readRepoFile('packages/platform-extension/src/modes/entry.ts');
  const entryCapabilityNames = extractStringArrayLiteral(
    entrySource,
    'ENTRY_TOOL_CAPABILITY_NAMES',
  );
  // "工具名必须 ∈ 注册表 ∩ 该模式实际注册的工具" (S5.4 design text): intersected with the registry —
  // in practice always a no-op (entry.ts's own buildCapabilityTool throws at runtime if a name in
  // ENTRY_TOOL_CAPABILITY_NAMES is missing from the registry), kept anyway for fidelity to that
  // wording and as a defensive check against this guard's own extraction going stale.
  const entryTools = new Set([
    GATE_PLACEHOLDER,
    ...entryCapabilityNames.filter((name) => registryNames.has(name)),
  ]);

  const workerTools = new Set([GATE_PLACEHOLDER, WORKER_REPORT_RESULT_TOOL_NAME]);

  const shared = await loadSharedRegistry();
  const resultContractKeys = new Set(Object.keys(shared.WorkerResultContractSchema.shape));

  return { entryTools, workerTools, resultContractKeys };
}

// -------------------------------------------------------------------------------------------
// Per-file allow-list of non-tool backtick words. A word only needs to be here if
// `candidateIdentifier` classifies its backtick span as a bareword/call-signature AND it is
// neither a tool name for that file's mode nor (for ops-runner.yaml) a WorkerResultContractSchema
// key. Keep this list exactly as long as the prompt text requires — it is reviewed by hand, not a
// way to make an arbitrary tool-name typo pass.
// -------------------------------------------------------------------------------------------

export const ALLOWED_NON_TOOL_WORDS = {
  'ontology/entry-agent.yaml': new Set([
    'timeout', // invoke_worker's own `timeout` param, named for context — not a tool.
    'taskId', // a field of invoke_worker's own {taskId, status} result, not a tool.
  ]),
  'ontology/ops-runner.yaml': new Set([
    'context', // the pi `context` event/injection mechanism, not a capability of this name.
    'executed', // an ActionRequest status value, not a tool.
    'pending_approval', // an ActionRequest/Task status value, not a tool.
    // Leftover 43: the field name the worker-mode gate tool prints in its `pending_approval`
    // result ("pending approval, actionRequestId <id>", modes/worker.ts) — the prompt tells the
    // Worker to cite it; not a tool. (`get_action` deliberately stays *un*-allow-listed: it is a
    // human-only capability a Worker Handle can never call, so a prompt naming it must fail here.)
    'actionRequestId',
  ]),
};

// -------------------------------------------------------------------------------------------
// One file's check — pure, given its already-loaded tool set and allow-list (unit-testable
// without touching the filesystem).
// -------------------------------------------------------------------------------------------

export function checkPromptFile(relativePath, systemPrompt, toolSet, extraAllowed) {
  const violations = [];
  for (const candidate of extractCandidateIdentifiers(systemPrompt)) {
    if (toolSet.has(candidate) || extraAllowed.has(candidate)) continue;
    violations.push(
      `${relativePath}: backtick identifier "${candidate}" is neither a tool this mode registers nor an allow-listed word — fix the prompt, or if this is intentional, add "${candidate}" to ALLOWED_NON_TOOL_WORDS in scripts/guards/prompt-contract.mjs with a one-line reason`,
    );
  }
  return violations;
}

// -------------------------------------------------------------------------------------------

const PROMPT_FILES = [
  { path: 'ontology/entry-agent.yaml', toolSetKey: 'entryTools', includeResultContractKeys: false },
  { path: 'ontology/ops-runner.yaml', toolSetKey: 'workerTools', includeResultContractKeys: true },
];

export async function main() {
  const { entryTools, workerTools, resultContractKeys } = await loadModeToolSets();
  const toolSetsByKey = { entryTools, workerTools };
  const violations = [];

  for (const file of PROMPT_FILES) {
    const raw = readRepoFile(file.path);
    const parsed = parseYaml(raw);
    const systemPrompt = parsed?.systemPrompt;
    if (typeof systemPrompt !== 'string') {
      violations.push(`${file.path}: no "systemPrompt" string field found`);
      continue;
    }
    const baseToolSet = toolSetsByKey[file.toolSetKey];
    const toolSet = file.includeResultContractKeys
      ? new Set([...baseToolSet, ...resultContractKeys])
      : baseToolSet;
    violations.push(
      ...checkPromptFile(
        file.path,
        systemPrompt,
        toolSet,
        ALLOWED_NON_TOOL_WORDS[file.path] ?? new Set(),
      ),
    );
  }

  if (violations.length > 0) {
    console.error(`prompt-contract: ${violations.length} violation(s) found:\n`);
    for (const violation of violations) {
      console.error(`  ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('prompt-contract: no violations found.');
}

// Run only when executed directly (`node scripts/guards/prompt-contract.mjs`), never on import —
// same convention `vocabulary.mjs` uses, so the unit test can import the pure functions without a
// full repo scan + process.exitCode side effect as an import-time surprise.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
