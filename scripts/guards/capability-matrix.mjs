// capability-matrix.mjs — every capability says where it is projected, and the code agrees
// (docs/test-coverage-gaps-2026-11-06.md §5.1, batch A).
//
// A capability is one domain action; the registry (packages/shared/src/capabilities.ts) is the
// only source of truth that it exists and who may call it. The console, `/api/cap/<name>` and the
// agents' tools are projections of it. Whether an action *should* have a console entry or be an
// agent tool is a decision a person makes, so it is written down in
// docs/contracts/capability-matrix.yaml, one row per capability, and this guard holds the code to it:
//
//   M1  registry ↔ matrix, one row per capability, none missing, none extra
//   M2  `console: required` ⇔ packages/web/src calls it (`http.call('<name>'` / `useCapability*(…, '<name>'`);
//       `indirect: <file>` = called through a variable, the file names it; `none: <reason>` = no call
//   M3  `agents` equals the tool sets the code registers: `entry` (platform-extension modes/entry.ts
//       `ENTRY_TOOL_CAPABILITY_NAMES`), `admin` (modes/admin.ts `ADMIN_TOOL_CAPABILITY_NAMES`). Names
//       the extension calls itself (`get_entry_context`, `report_turn`) or reaches through projected
//       gate tools (`observe_operation`) are on the Handle ceiling, not tools, and are not listed
//   M4  a capability that is not `observe` and has a console entry (`required` / `indirect:`) says
//       whether an e2e test reaches it through the console: `e2e: observed`, or
//       `e2e: "waived: <legacy no.>"` (counted by ratchet.e2e_waived). No other row has `e2e`.
//       `--e2e-observed <dir>` (the end of `web-e2e`) reads the calls packages/web/e2e/lib/test.ts
//       recorded (`cap-calls.jsonl`): every `observed` row was called by a page and answered ok, and
//       a waived row a page called ok must become `observed` (and lower the ratchet)
//   M5  `kernel_test: missing` ⇔ no packages/kernel test file names it
//   R   ratchet: the `none: 待说明…` rows, the `kernel_test: missing` rows and the `e2e: waived`
//       rows are counted, and the counts must equal `ratchet:` at the top of the file — a new one cannot be added without
//       raising the number in the same diff, a fixed one must lower it
//
// Reads @nexttime/shared's built dist (like vocabulary.mjs): `pnpm --filter @nexttime/shared build`
// first. `--bootstrap` (re)writes the matrix from what the code does today; it is how the file was
// first made and how a large rename can be re-seeded — never a way to make a failing check pass
// without reading the diff.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const MATRIX_PATH = 'docs/contracts/capability-matrix.yaml';
export const UNEXPLAINED_PREFIX = 'none: 待说明';
export const AGENT_SURFACES = ['entry', 'admin'];
export const E2E_OBSERVED = 'observed';
export const E2E_WAIVED = /^waived: [0-9]+$/;

// ---------------------------------------------------------------------------------------------
// Scanners (pure functions over file text, unit-tested in capability-matrix.test.mjs)
// ---------------------------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Names the console calls directly: `call('<name>'`, `call<T>('<name>'`, `useCapability*(http,
 *  '<name>'`. A string that only appears in a label table, a permission probe (`can('<name>')`) or a
 *  comment is not a call. */
export function scanConsoleCalls(sourceText, names) {
  const found = new Set();
  for (const name of names) {
    const pattern = new RegExp(
      `\\b(?:call|useCapability\\w*)\\s*(?:<[^()]*?>)?\\(\\s*(?:[\\w.]+\\s*,\\s*)?['"\`]${escapeRegExp(name)}['"\`]`,
    );
    if (pattern.test(sourceText)) found.add(name);
  }
  return found;
}

/** `<constName> = [ ... ]` in a platform-extension mode — the pi tools that mode registers
 *  (`ENTRY_TOOL_CAPABILITY_NAMES` in modes/entry.ts, `ADMIN_TOOL_CAPABILITY_NAMES` in modes/admin.ts).
 *  Fails loudly on anything it cannot read as a plain list of string literals (a spread, a computed
 *  entry), rather than silently dropping names. */
export function parseToolArray(source, constName) {
  const match = source.match(new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
  if (!match) throw new Error(`capability-matrix: ${constName} = [ ... ] as const not found`);
  const body = match[1].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const names = [];
  for (const entry of body.split(',')) {
    const item = entry.trim();
    if (item === '') continue;
    const literal = item.match(/^['"]([a-z0-9_]+)['"]$/);
    if (!literal)
      throw new Error(`capability-matrix: ${constName} has an entry it cannot read: ${item}`);
    names.push(literal[1]);
  }
  return new Set(names);
}

/** Names quoted anywhere in the kernel's test files. */
export function scanQuoted(text, names) {
  const found = new Set();
  for (const name of names) {
    if (new RegExp(`['"\`]${escapeRegExp(name)}['"\`]`).test(text)) found.add(name);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/** M4's scope: a write (any mode but `observe`) the console has an entry for. */
export function needsE2e(mode, consoleDecl) {
  return (
    mode !== undefined &&
    mode !== 'observe' &&
    (consoleDecl === 'required' || consoleDecl.startsWith('indirect:'))
  );
}

/**
 * @param {{ ratchet?: Record<string, number>, capabilities?: Record<string, any> }} matrix
 * @param {{ names: string[], consoleCalls: Set<string>, entry: Set<string>, admin: Set<string>,
 *           kernelTested: Set<string>, fileHasName: (file: string, name: string) => boolean,
 *           modes?: Map<string, string> }} facts  `modes`: registry mode per name (M4)
 * @returns {string[]} violations
 */
export function checkMatrix(matrix, facts) {
  const out = [];
  const rows = matrix?.capabilities ?? {};
  const registry = new Set(facts.names);

  // M1
  for (const name of facts.names) {
    if (!(name in rows)) {
      out.push(
        `M1 ${name}: in the capability registry but not in ${MATRIX_PATH} — add a row saying whether the console calls it (console) and which agents get it as a tool (agents)`,
      );
    }
  }
  for (const name of Object.keys(rows)) {
    if (!registry.has(name))
      out.push(`M1 ${name}: row in ${MATRIX_PATH} but no such capability — remove it`);
  }

  let unexplained = 0;
  let kernelMissing = 0;
  let e2eWaived = 0;
  for (const name of facts.names) {
    const row = rows[name];
    if (!row || typeof row !== 'object') continue;
    const consoleDecl = typeof row.console === 'string' ? row.console.trim() : '';
    const called = facts.consoleCalls.has(name);

    // M2
    if (consoleDecl === 'required') {
      if (!called) {
        out.push(
          `M2 ${name}: console: required, but packages/web/src never calls it — build the entry, or declare it indirect / none with the reason`,
        );
      }
    } else if (consoleDecl.startsWith('indirect:')) {
      const file = consoleDecl.slice('indirect:'.length).trim();
      if (called) out.push(`M2 ${name}: the console calls it directly — declare console: required`);
      else if (file === '' || !facts.fileHasName(file, name)) {
        out.push(`M2 ${name}: console: ${consoleDecl} — that file does not name '${name}'`);
      }
    } else if (consoleDecl.startsWith('none:')) {
      if (consoleDecl.slice('none:'.length).trim() === '')
        out.push(`M2 ${name}: console: none needs a reason`);
      if (called)
        out.push(
          `M2 ${name}: declared console: none, but packages/web/src calls it — declare console: required`,
        );
      if (consoleDecl.startsWith(UNEXPLAINED_PREFIX)) unexplained += 1;
    } else {
      out.push(
        `M2 ${name}: console must be 'required', 'indirect: <file>' or 'none: <reason>' (got ${JSON.stringify(row.console)})`,
      );
    }

    // M3
    if (!Array.isArray(row.agents)) {
      out.push(`M3 ${name}: agents must be a list (empty when no agent gets it as a tool)`);
    } else {
      const declared = new Set(row.agents);
      for (const surface of declared) {
        if (!AGENT_SURFACES.includes(surface))
          out.push(
            `M3 ${name}: unknown agent surface '${surface}' (one of ${AGENT_SURFACES.join(', ')})`,
          );
      }
      for (const surface of AGENT_SURFACES) {
        const actual = facts[surface].has(name);
        if (actual && !declared.has(surface)) {
          out.push(
            `M3 ${name}: the ${surface} agent registers it as a tool, but agents does not list ${surface}`,
          );
        }
        if (!actual && declared.has(surface)) {
          out.push(
            `M3 ${name}: agents lists ${surface}, but the ${surface} agent does not register it as a tool`,
          );
        }
      }
    }

    // M4 (the static half; `checkObserved` is the run-time half)
    if (needsE2e(facts.modes?.get(name), consoleDecl)) {
      if (row.e2e === E2E_OBSERVED) {
        // held to the run by checkObserved
      } else if (typeof row.e2e === 'string' && E2E_WAIVED.test(row.e2e)) {
        e2eWaived += 1;
      } else {
        out.push(
          `M4 ${name}: a ${facts.modes.get(name)} capability with a console entry — say e2e: observed (an e2e test calls it through the console), or e2e: "waived: <legacy no.>" with a higher ratchet.e2e_waived (got ${JSON.stringify(row.e2e)})`,
        );
      }
    } else if (row.e2e !== undefined) {
      out.push(
        `M4 ${name}: e2e is only for a capability that is not observe and has a console entry — remove it`,
      );
    }

    // M5
    const tested = facts.kernelTested.has(name);
    if (row.kernel_test === 'missing') {
      kernelMissing += 1;
      if (tested)
        out.push(
          `M5 ${name}: kernel_test: missing, but a kernel test names it now — remove the line and lower ratchet.kernel_test_missing`,
        );
    } else if (row.kernel_test !== undefined) {
      out.push(
        `M5 ${name}: kernel_test may only be 'missing' (got ${JSON.stringify(row.kernel_test)})`,
      );
    } else if (!tested) {
      out.push(
        `M5 ${name}: no packages/kernel test names '${name}' — add one (a waiver is kernel_test: missing plus a higher ratchet, and needs a reviewer's reason)`,
      );
    }
  }

  // R
  const ratchet = matrix?.ratchet ?? {};
  for (const [key, count] of [
    ['console_unexplained', unexplained],
    ['kernel_test_missing', kernelMissing],
    ['e2e_waived', e2eWaived],
  ]) {
    if (ratchet[key] !== count) {
      out.push(
        `R ratchet.${key} is ${JSON.stringify(ratchet[key])}, the matrix has ${count} — ${
          typeof ratchet[key] === 'number' && count < ratchet[key]
            ? 'lower it to match (the ratchet only goes down)'
            : 'a new waiver raises it, and the reviewer has to agree to that'
        }`,
      );
    }
  }
  return out;
}

/**
 * M4, run-time half: `observed` is the set of names a page called and got ok for in this e2e run.
 * @returns {string[]} violations
 */
export function checkObserved(matrix, observed) {
  const out = [];
  for (const [name, row] of Object.entries(matrix?.capabilities ?? {})) {
    if (row?.e2e === E2E_OBSERVED && !observed.has(name)) {
      out.push(
        `M4 ${name}: e2e: observed, but no page called it and got ok in this run — the test that covered it no longer does; cover it again, or waive it with a legacy no.`,
      );
    }
    if (typeof row?.e2e === 'string' && E2E_WAIVED.test(row.e2e) && observed.has(name)) {
      out.push(
        `M4 ${name}: ${row.e2e}, but a page called it ok in this run — change it to e2e: observed and lower ratchet.e2e_waived`,
      );
    }
  }
  return out;
}

/** Lines of every `cap-calls.jsonl` under `dir` → the names called ok, and how many files. */
export function readObserved(dir) {
  const names = new Set();
  let files = 0;
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'cap-calls.jsonl') {
        files += 1;
        for (const line of readFileSync(full, 'utf8').split('\n')) {
          if (line.trim() === '') continue;
          const call = JSON.parse(line);
          if (call.ok === true && typeof call.name === 'string') names.add(call.name);
        }
      }
    }
  };
  walk(dir);
  return { names, files };
}

// ---------------------------------------------------------------------------------------------
// Repo glue
// ---------------------------------------------------------------------------------------------

function gitFiles(patterns) {
  const out = execFileSync('git', ['ls-files', '--', ...patterns], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter((line) => line.length > 0);
}

function read(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

async function loadRegistry() {
  const distIndex = path.join(REPO_ROOT, 'packages', 'shared', 'dist', 'index.js');
  let shared;
  try {
    shared = await import(pathToFileURL(distIndex).href);
  } catch (err) {
    console.error(
      `capability-matrix: could not import ${distIndex} — build @nexttime/shared first (\`pnpm --filter @nexttime/shared build\`).`,
    );
    throw err;
  }
  return shared.CAPABILITY_REGISTRY.filter((capability) => !capability.name.includes('<'));
}

export async function collectFacts() {
  const registry = await loadRegistry();
  const names = registry.map((capability) => capability.name);
  const webFiles = gitFiles([
    'packages/web/src/*.ts',
    'packages/web/src/**/*.ts',
    'packages/web/src/*.tsx',
    'packages/web/src/**/*.tsx',
  ]).filter((file) => !/\.test\.tsx?$/.test(file));
  const webText = webFiles.map(read).join('\n');
  const kernelTestText = gitFiles(['packages/kernel/*.test.ts', 'packages/kernel/**/*.test.ts'])
    .map(read)
    .join('\n');
  return {
    names,
    modes: new Map(registry.map((capability) => [capability.name, capability.mode])),
    consoleCalls: scanConsoleCalls(webText, names),
    entry: parseToolArray(
      read('packages/platform-extension/src/modes/entry.ts'),
      'ENTRY_TOOL_CAPABILITY_NAMES',
    ),
    admin: parseToolArray(
      read('packages/platform-extension/src/modes/admin.ts'),
      'ADMIN_TOOL_CAPABILITY_NAMES',
    ),
    kernelTested: scanQuoted(kernelTestText, names),
    fileHasName: (file, name) => {
      try {
        return scanQuoted(read(file), [name]).has(name);
      } catch {
        return false;
      }
    },
  };
}

const HEADER = `# Capability matrix — one row per capability in packages/shared/src/capabilities.ts.
# Guard: scripts/guards/capability-matrix.mjs (rules M1–M5, R); design: docs/test-coverage-gaps-2026-11-06.md §5.1, §5.3.
#
# console:  required             the console calls it (http.call / useCapability*)
#           indirect: <file>     the console calls it through a variable; <file> names it
#           none: <reason>       no console entry, on purpose — say why
#           none: 待说明…        not decided yet (counted by ratchet.console_unexplained, only goes down)
# agents:   which agents register it as a pi tool: entry (modes/entry.ts), admin (modes/admin.ts).
#           [] is a decision too: a new capability's PR says here whether the agents should see it.
# e2e:      observed             (a capability that is not observe, with a console entry) an e2e test
#                                calls it through the console; web-e2e checks each run (M4)
#           "waived: <legacy no.>"  not yet (counted by ratchet.e2e_waived, only goes down)
# kernel_test: missing           no kernel test names it yet (counted by ratchet.kernel_test_missing)
`;

/**
 * @param options `observed` (names an e2e run called ok, `readObserved`) and `waiver` (the legacy
 *   no. a row no test reaches is waived under) decide each M4 row's `e2e`; without `observed`, a
 *   row keeps the `e2e` it had.
 */
export function bootstrapMatrix(facts, previous, options = {}) {
  const rows = {};
  let unexplained = 0;
  let kernelMissing = 0;
  let e2eWaived = 0;
  for (const name of [...facts.names].sort()) {
    const old = previous?.capabilities?.[name];
    let consoleDecl;
    if (facts.consoleCalls.has(name)) consoleDecl = 'required';
    else if (typeof old?.console === 'string' && !old.console.startsWith('required'))
      consoleDecl = old.console;
    else consoleDecl = `${UNEXPLAINED_PREFIX}（2026-11-06 盘点）`;
    if (consoleDecl.startsWith(UNEXPLAINED_PREFIX)) unexplained += 1;
    const row = {
      console: consoleDecl,
      agents: AGENT_SURFACES.filter((surface) => facts[surface].has(name)),
    };
    if (needsE2e(facts.modes?.get(name), consoleDecl)) {
      if (options.observed?.has(name)) row.e2e = E2E_OBSERVED;
      else if (options.observed === undefined && typeof old?.e2e === 'string') row.e2e = old.e2e;
      else if (options.waiver !== undefined) row.e2e = `waived: ${options.waiver}`;
      else throw new Error(`capability-matrix: ${name} needs e2e — pass --waive <legacy no.>`);
      if (row.e2e !== E2E_OBSERVED) e2eWaived += 1;
    }
    if (!facts.kernelTested.has(name)) {
      row.kernel_test = 'missing';
      kernelMissing += 1;
    }
    rows[name] = row;
  }
  const lines = [
    'ratchet:',
    `  console_unexplained: ${unexplained}`,
    `  kernel_test_missing: ${kernelMissing}`,
    `  e2e_waived: ${e2eWaived}`,
    'capabilities:',
  ];
  for (const [name, row] of Object.entries(rows)) {
    lines.push(`  ${name}:`);
    lines.push(
      `    console: ${row.console === 'required' ? 'required' : JSON.stringify(row.console)}`,
    );
    lines.push(`    agents: [${row.agents.join(', ')}]`);
    if (row.e2e)
      lines.push(`    e2e: ${row.e2e === E2E_OBSERVED ? row.e2e : JSON.stringify(row.e2e)}`);
    if (row.kernel_test) lines.push(`    kernel_test: ${row.kernel_test}`);
  }
  const body = `${lines.join('\n')}\n`;
  return HEADER + body;
}

async function main() {
  const facts = await collectFacts();
  let matrixText = '';
  try {
    matrixText = read(MATRIX_PATH);
  } catch {
    // missing file: M1 reports every capability
  }
  const matrix = matrixText ? parse(matrixText) : {};
  const arg = (flag) => {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const observedDir = arg('--e2e-observed');
  let observed;
  if (observedDir !== undefined) {
    const read = readObserved(path.resolve(observedDir));
    if (read.files === 0) {
      console.error(
        `capability-matrix: no cap-calls.jsonl under ${observedDir} — did the e2e run use packages/web/e2e/lib/test.ts's test?`,
      );
      process.exit(1);
    }
    observed = read.names;
    console.log(
      `capability-matrix: ${read.files} test(s) recorded calls; ${observed.size} capabilities called ok by a page`,
    );
  }
  if (process.argv.includes('--bootstrap')) {
    writeFileSync(
      path.join(REPO_ROOT, MATRIX_PATH),
      bootstrapMatrix(facts, matrix, { observed, waiver: arg('--waive') }),
    );
    console.log(`capability-matrix: wrote ${MATRIX_PATH} — read the diff before committing it`);
    return;
  }
  const violations = [
    ...checkMatrix(matrix, facts),
    ...(observed !== undefined ? checkObserved(matrix, observed) : []),
  ];
  if (violations.length > 0) {
    for (const violation of violations) console.error(`capability-matrix: ${violation}`);
    console.error(
      `capability-matrix: ${violations.length} problem(s); see the header of ${MATRIX_PATH}`,
    );
    process.exit(1);
  }
  console.log(`capability-matrix: OK (${facts.names.length} capabilities)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
