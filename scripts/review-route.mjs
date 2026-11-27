#!/usr/bin/env node
// scripts/review-route.mjs — which review a change needs, decided by the paths it touches
// (docs/runbooks/dev-loop.md §3). The map is docs/state/review-map.json: ordered rules, each with
// a risk tier (R0–R3) and the review seats it requires. A file takes the first rule it matches;
// the change takes the highest tier and the union of the seats. The author cannot lower the
// result: it is computed again by scripts/pr-gate.mjs before the merge.
//
//   node scripts/review-route.mjs --base origin/main     the diff from the merge base to HEAD
//   node scripts/review-route.mjs --pr 1597              the files of a pull request (needs `gh`)
//   node scripts/review-route.mjs --files a.ts b.md      the given paths
//   node scripts/review-route.mjs --check                the map itself is well-formed
//
// Add --json for machine output.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { git, readRepoFile } from './guards/loop-ledger.mjs';
import { globToRegExp } from './guards/staging-paths.mjs';

export const REVIEW_MAP = 'docs/state/review-map.json';
const RISKS = ['R0', 'R1', 'R2', 'R3'];

/** Shape problems of the map as printable lines. */
export function lintMap(map) {
  const problems = [];
  const need = (ok, message) => ok || problems.push(`${REVIEW_MAP}: ${message}`);
  need(map?.schema === 1, '"schema" must be 1');
  const seats = Object.keys(map?.seats ?? {});
  need(seats.length > 0, '"seats" must name at least one seat');
  need(Array.isArray(map?.stewardOnly), '"stewardOnly" must be a list of paths');
  const rules = [...(map?.rules ?? []), map?.default].filter(Boolean);
  need((map?.rules ?? []).length > 0 && map?.default, '"rules" and "default" are required');
  for (const rule of rules) {
    const where = `rule "${rule.name ?? '?'}"`;
    need(typeof rule.name === 'string' && rule.name !== '', 'every rule has a name');
    need(RISKS.includes(rule.risk), `${where}: risk must be one of ${RISKS.join(' / ')}`);
    need(Array.isArray(rule.seats) && rule.seats.every((s) => seats.includes(s)), `${where}: seats must be listed in "seats"`);
    // Anything above R0 is looked at by someone other than the author.
    need(rule.risk === 'R0' || (rule.seats ?? []).length > 0, `${where}: ${rule.risk} needs at least one seat`);
    if (rule !== map.default) need(Array.isArray(rule.paths) && rule.paths.length > 0, `${where}: paths must not be empty`);
  }
  return problems;
}

/** The route of a list of changed paths: `{ risk, seats, stewardOnly, groups }`. */
export function route(map, files) {
  const rules = map.rules.map((rule) => ({ rule, matchers: rule.paths.map(globToRegExp) }));
  const groups = new Map(); // rule name -> { rule, files }
  for (const file of files) {
    const hit = rules.find((r) => r.matchers.some((re) => re.test(file)))?.rule ?? map.default;
    if (!groups.has(hit.name)) groups.set(hit.name, { name: hit.name, risk: hit.risk, seats: hit.seats, files: [] });
    groups.get(hit.name).files.push(file);
  }
  const list = [...groups.values()].sort((a, b) => RISKS.indexOf(b.risk) - RISKS.indexOf(a.risk));
  return {
    risk: list.length === 0 ? undefined : list[0].risk,
    seats: Object.keys(map.seats).filter((seat) => list.some((g) => g.seats.includes(seat))),
    stewardOnly: files.filter((f) => map.stewardOnly.includes(f)),
    groups: list,
  };
}

export function render(map, result) {
  if (result.risk === undefined) return 'no changed files (an empty change has no route)';
  const seatNames = result.seats.map((s) => `${s}（${map.seats[s]}）`);
  const lines = [
    `risk: ${result.risk}`,
    `seats: ${seatNames.length > 0 ? seatNames.join(', ') : '(none — the steward merges on green checks)'}`,
  ];
  if (result.stewardOnly.length > 0) lines.push(`steward-only files: ${result.stewardOnly.join(', ')}`);
  for (const g of result.groups) {
    const more = g.files.length > 1 ? ` (+${g.files.length - 1})` : '';
    lines.push(`  ${g.risk} ${g.name} [${g.seats.join(', ') || '-'}]: ${g.files[0]}${more}`);
  }
  return lines.join('\n');
}

export const readMap = () => JSON.parse(readRepoFile(REVIEW_MAP));

/** Changed paths of a pull request, all pages, old and new name of a rename. */
export function pullFiles(slug, number) {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = JSON.parse(
      execFileSync('gh', ['api', `repos/${slug}/pulls/${number}/files?per_page=100&page=${page}`], { encoding: 'utf8' }),
    );
    for (const f of batch) files.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
    if (batch.length < 100) return files;
  }
}

export function repoSlug() {
  const slug = process.env.GITHUB_REPOSITORY ?? /github\.com[:/]([^/]+\/[^/.\s]+)/.exec(git(['remote', 'get-url', 'origin']) ?? '')?.[1];
  if (!slug) throw new Error('cannot tell the repository: set GITHUB_REPOSITORY=owner/name');
  return slug;
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const map = readMap();
  const problems = lintMap(map);
  if (problems.length > 0 || args.includes('--check')) {
    for (const p of problems) console.error(`review-route: ${p}`);
    if (problems.length === 0) console.log('review-route: map OK');
    process.exit(problems.length > 0 ? 1 : 0);
  }
  let files;
  if (args.includes('--files')) files = args.slice(args.indexOf('--files') + 1).filter((a) => !a.startsWith('--'));
  else if (value('--pr')) files = pullFiles(repoSlug(), value('--pr'));
  else if (value('--base')) {
    const out = git(['diff', '--name-only', `${value('--base')}...HEAD`]);
    if (out === undefined) {
      console.error(`review-route: cannot diff against ${value('--base')}`);
      process.exit(2);
    }
    files = out.split('\n').filter(Boolean);
  } else {
    console.error('usage: review-route.mjs (--base <ref> | --pr <number> | --files <path>… | --check) [--json]');
    process.exit(2);
  }
  const result = route(map, files);
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : render(map, result));
  if (result.risk === undefined) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
