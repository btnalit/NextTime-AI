#!/usr/bin/env node
// scripts/guards/staging-paths.mjs — keeps .github/workflows/staging.yml's `pull_request.paths`
// filter in step with what the release rehearsal actually runs. The rehearsal
// (scripts/staging-rehearsal.sh) applies a target through scripts/apply-release.sh and runs the
// acceptance scripts; a PR that changes one of their helpers must trigger it, or only the manual
// tag rehearsal before a host apply would ever exercise that change.
//
// The dependency closure is computed, not listed: starting from every shell script the filter
// already matches, each repo path under scripts/ or deploy/ named on a non-comment line is added
// (a `$var` in the path becomes `*`, so `scripts/accept_s$s.sh` stands for `scripts/accept_s*.sh`;
// a name that is nothing but a variable is skipped),
// and any newly reached scripts/*.sh is scanned in turn. docker-compose.yml's non-comment lines
// add the deploy/ directories it builds from or mounts. Every scripts/ file found must match the
// filter; every deploy/<dir> must be covered as `deploy/<dir>/**`.
//
// Out of scope on purpose: product code (packages/, gatekeepers/, collectors/) goes into the
// images the rehearsal builds, but runs on every PR through ci.yml / e2e.yml and is rehearsed
// by the tag dispatch before production (docs/runbooks/staging-rehearsal.md §3.1).
//
// Run: `node scripts/guards/staging-paths.mjs` (also part of `pnpm ci:guards`).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** The `pull_request: paths:` list of staging.yml (a plain YAML list, read line by line). */
export function filterPaths(workflow) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l, i) => /^  pull_request:\s*$/.test(l) && /^    paths:\s*$/.test(lines[i + 1] ?? ''));
  if (start < 0) throw new Error('staging.yml: no `pull_request: paths:` block');
  const out = [];
  for (const l of lines.slice(start + 2)) {
    const m = /^      - (\S+)\s*$/.exec(l);
    if (!m) break;
    out.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

/** GitHub's filter glob: `**` crosses directories, `*` does not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Repo paths under scripts/ or deploy/ named on a non-comment line; `$var` becomes `*`. */
export function referencedPaths(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/(?<![\w./-])(?:\.\/)?((?:scripts|deploy)\/[\w.$/{}-]*[\w}])/g)) {
      const rel = m[1].replace(/\$\{?\w+\}?/g, '*');
      // A name that is all variable (`scripts/$s.sh` in a `for s in ...` loop) cannot be resolved
      // here; the loop's own literal names are what the filter must cover, and review sees them.
      if (!/\/\*[^/]*$/.test(rel)) out.add(rel);
    }
  }
  return out;
}

/** Shell scripts under scripts/ (recursively), repo-relative. */
function shellScripts(dir = 'scripts') {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : shellScripts(rel);
    return e.name.endsWith('.sh') ? [rel] : [];
  });
}

/** Uncovered paths, each with the file that named it. Empty = the filter covers the closure. */
export function check() {
  const filter = filterPaths(read('.github/workflows/staging.yml'));
  const matchers = filter.map(globToRegExp);
  const covered = (p) => matchers.some((re) => re.test(p));

  const named = new Map(); // repo path -> first file that named it
  const queue = shellScripts().filter(covered);
  const seen = new Set(queue);
  const scan = (from) => {
    for (const rel of referencedPaths(read(from))) {
      if (!named.has(rel)) named.set(rel, from);
      if (rel.endsWith('.sh') && !rel.includes('*') && !seen.has(rel) && existsSync(path.join(ROOT, rel))) {
        seen.add(rel);
        queue.push(rel);
      }
    }
  };
  scan('docker-compose.yml');
  while (queue.length) scan(queue.shift());

  const missing = [];
  for (const [rel, from] of named) {
    if (rel.startsWith('deploy/')) {
      const dir = rel.split('/')[1];
      if (dir && !dir.includes('*') && !filter.includes(`deploy/${dir}/**`)) missing.push({ path: `deploy/${dir}/**`, from });
    } else if (!covered(rel)) {
      missing.push({ path: rel, from });
    }
  }
  const unique = new Map(missing.map((m) => [m.path, m]));
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const missing = check();
  if (missing.length) {
    console.error('staging-paths: .github/workflows/staging.yml `pull_request.paths` misses what the rehearsal runs:');
    for (const m of missing) console.error(`  ${m.path}   (named in ${m.from})`);
    console.error('Add each to both the pull_request paths list and docs/runbooks/staging-rehearsal.md §3.1.');
    process.exit(1);
  }
  console.log('staging-paths: the staging trigger filter covers the release rehearsal\'s scripts and deploy/ directories.');
}
