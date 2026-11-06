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
//   M3  `agents` equals the tool sets the code registers: `entry` (ontology/entry-agent.yaml
//       `capabilities`), `admin` (platform-extension modes/admin.ts `ADMIN_TOOL_CAPABILITY_NAMES`)
//   M5  `kernel_test: missing` ⇔ no packages/kernel test file names it
//   R   ratchet: the `none: 待说明…` rows and the `kernel_test: missing` rows are counted, and the
//       counts must equal `ratchet:` at the top of the file — a new one cannot be added without
//       raising the number in the same diff, a fixed one must lower it
//
// Reads @nexttime/shared's built dist (like vocabulary.mjs): `pnpm --filter @nexttime/shared build`
// first. `--bootstrap` (re)writes the matrix from what the code does today; it is how the file was
// first made and how a large rename can be re-seeded — never a way to make a failing check pass
// without reading the diff.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const MATRIX_PATH = 'docs/contracts/capability-matrix.yaml';
export const UNEXPLAINED_PREFIX = 'none: 待说明';
export const AGENT_SURFACES = ['entry', 'admin'];

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

/** `ADMIN_TOOL_CAPABILITY_NAMES = [ ... ]` in modes/admin.ts — the admin agent's pi tools. */
export function parseAdminTools(adminSource) {
  const match = adminSource.match(/ADMIN_TOOL_CAPABILITY_NAMES\s*=\s*\[([\s\S]*?)\]/);
  if (!match)
    throw new Error('capability-matrix: ADMIN_TOOL_CAPABILITY_NAMES not found in modes/admin.ts');
  const body = match[1].replace(/\/\/.*$/gm, '');
  return new Set([...body.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]));
}

/** `capabilities:` of ontology/entry-agent.yaml — the built-in entry agent's tools. */
export function parseEntryTools(entryYaml) {
  const doc = parse(entryYaml);
  if (!doc || !Array.isArray(doc.capabilities)) {
    throw new Error('capability-matrix: ontology/entry-agent.yaml has no capabilities list');
  }
  return new Set(doc.capabilities.filter((name) => typeof name === 'string'));
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

/**
 * @param {{ ratchet?: Record<string, number>, capabilities?: Record<string, any> }} matrix
 * @param {{ names: string[], consoleCalls: Set<string>, entry: Set<string>, admin: Set<string>,
 *           kernelTested: Set<string>, fileHasName: (file: string, name: string) => boolean }} facts
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

async function loadRegistryNames() {
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
  return shared.CAPABILITY_REGISTRY.map((capability) => capability.name).filter(
    (name) => !name.includes('<'),
  );
}

export async function collectFacts() {
  const names = await loadRegistryNames();
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
    consoleCalls: scanConsoleCalls(webText, names),
    entry: parseEntryTools(read('ontology/entry-agent.yaml')),
    admin: parseAdminTools(read('packages/platform-extension/src/modes/admin.ts')),
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
# Guard: scripts/guards/capability-matrix.mjs (rules M1–M5, R); design: docs/test-coverage-gaps-2026-11-06.md §5.1.
#
# console:  required             the console calls it (http.call / useCapability*)
#           indirect: <file>     the console calls it through a variable; <file> names it
#           none: <reason>       no console entry, on purpose — say why
#           none: 待说明…        not decided yet (counted by ratchet.console_unexplained, only goes down)
# agents:   which agents get it as a tool: entry (ontology/entry-agent.yaml), admin (modes/admin.ts).
#           [] is a decision too: a new capability's PR says here whether the agents should see it.
# kernel_test: missing           no kernel test names it yet (counted by ratchet.kernel_test_missing)
`;

export function bootstrapMatrix(facts, previous) {
  const rows = {};
  let unexplained = 0;
  let kernelMissing = 0;
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
    'capabilities:',
  ];
  for (const [name, row] of Object.entries(rows)) {
    lines.push(`  ${name}:`);
    lines.push(
      `    console: ${row.console === 'required' ? 'required' : JSON.stringify(row.console)}`,
    );
    lines.push(`    agents: [${row.agents.join(', ')}]`);
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
  if (process.argv.includes('--bootstrap')) {
    writeFileSync(path.join(REPO_ROOT, MATRIX_PATH), bootstrapMatrix(facts, matrix));
    console.log(`capability-matrix: wrote ${MATRIX_PATH} — read the diff before committing it`);
    return;
  }
  const violations = checkMatrix(matrix, facts);
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
