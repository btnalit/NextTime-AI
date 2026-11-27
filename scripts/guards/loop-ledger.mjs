#!/usr/bin/env node
// scripts/guards/loop-ledger.mjs — the development loop's own state is checked by a machine, not
// remembered by an agent (docs/runbooks/dev-loop.md §5). Three things, all read from the checkout:
//
//   legacy table   docs/STATUS.md §4: every row has five cells (an unescaped `|` inside a cell
//                  splits it), ids are integers in ascending order, the level is one of the known
//                  ones, the status starts with a known state, and a P3 registered from
//                  `legacy.tierRequiredFromId` on that is still open says which tier it is in:
//                  「开放（阶段内处理…）」 or 「开放（挂起：<理由>）」.
//   doc budgets    each file in `docBudgets` is no larger than its ceiling. Against a base
//                  (`--base <ref>`) a ceiling only goes down; a reviewed raise carries the
//                  `ratchet-raise` label (`--allow-raise`), as scripts/guards/ratchet-shrinks.mjs.
//   host steps     docs/runbooks/release.md §3: every section from
//                  `release.hostStepTagFromSection` on opens with one line saying when its host
//                  step happens and whether the maintainer has to be there, so that
//                  scripts/host-upgrade-brief.mjs can sort the sections of an upgrade:
//                  「> 主机步骤：无｜窗口前｜窗口内｜应用后[、…]；维护者本人：是｜否」.
//   loop state     docs/state/loop.json is well-formed, and the host version it names is a
//                  release tag no newer than this checkout's version.
//
// Rows that broke a rule before the guard existed are listed in `legacy.grandfathered`
// (id -> rule). The list only shrinks: an entry whose row no longer breaks its rule, or is no
// longer in the table, fails the guard until it is removed.
//
// No dependencies (the `guards` job does not install any). Nothing here passes on an empty
// sample: a missing §4, a table with no rows or a missing budgeted file is a failure.
//
// Run: node scripts/guards/loop-ledger.mjs [--base <git ref> [--allow-raise]] [--require-tags]
// (also part of `pnpm ci:guards`).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const LOOP_STATE = 'docs/state/loop.json';
export const STATUS = 'docs/STATUS.md';
export const RELEASE_MD = 'docs/runbooks/release.md';

export const LEVELS = ['P1', 'P2', 'P3', '功能缺口', '—'];
/** Status prefix -> state. Longer prefixes first: 「已关闭」 before 「关闭」. */
const STATES = [
  ['部分关闭', 'partial'],
  ['待主机', 'awaiting_host'],
  ['已接受', 'accepted'],
  ['已关闭', 'closed'],
  ['已撤销', 'closed'],
  ['关闭', 'closed'],
  ['开放', 'open'],
];
/** States that still count as open work. `accepted` is a decision, `closed` is done. */
const OPEN_STATES = ['open', 'partial', 'awaiting_host'];

/** Cells of one Markdown table row: split on `|`, except an escaped `\|`. */
export function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (line[i] === '|') {
      cells.push(cur);
      cur = '';
    } else cur += line[i];
  }
  cells.push(cur);
  return cells.slice(1, -1).map((c) => c.trim());
}

/**
 * Rows of the legacy table: the lines starting `| <digits> |` between the 「遗留清单」 heading and
 * the next `## ` heading. Throws when the section is missing.
 */
export function parseLegacyTable(statusMd) {
  const lines = statusMd.split('\n');
  const start = lines.findIndex((l) => /^## .*遗留清单/.test(l));
  if (start < 0) throw new Error(`${STATUS}: no "## … 遗留清单" section`);
  const rows = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (!/^\| *\d+ *\|/.test(lines[i])) continue;
    const cells = splitRow(lines[i]);
    rows.push({
      line: i + 1,
      id: Number(cells[0]),
      cells,
      level: cells[2] ?? '',
      status: cells.at(-1) ?? '',
    });
  }
  return rows;
}

/** The state a status cell starts with (leading bold markers ignored), or undefined. */
export function rowState(status) {
  const s = status.replace(/^\*+/, '');
  for (const [prefix, state] of STATES) {
    // 「开放·推迟」 and the like are a different word, not 「开放」.
    if (s.startsWith(prefix) && s[prefix.length] !== '·') return state;
  }
  return undefined;
}

/** `in_stage`, `parked` or undefined, from 「开放（阶段内处理…」 / 「开放（挂起：<理由>」. */
export function rowTier(status) {
  const s = status.replace(/^\*+/, '');
  if (/^开放（阶段内处理/.test(s)) return 'in_stage';
  if (/^开放（挂起：[^）\s]/.test(s)) return 'parked';
  return undefined;
}

/** Still open work. A status with no known state (a grandfathered row) counts as open. */
export const isOpenRow = (row) => OPEN_STATES.includes(rowState(row.status) ?? 'open');

/** Whether a row carries the release-blocker mark (docs/runbooks/release.md §1 item 4). */
export function isReleaseBlocker(row) {
  return isOpenRow(row) && row.cells.join(' ').includes('发版前必须关闭');
}

/** Rule violations of one row: `[{ id, rule, message }]`. */
function rowViolations(row, legacy) {
  const out = [];
  const add = (rule, message) => out.push({ id: row.id, rule, message });
  if (row.cells.length !== 5) {
    add('cells', `${row.cells.length} cells, expected 5 — escape a "|" inside a cell as "\\|"`);
    return out; // the other cells cannot be trusted
  }
  if (!LEVELS.includes(row.level)) add('level', `level "${row.level}" is not one of ${LEVELS.join(' / ')}`);
  const state = rowState(row.status);
  if (!state) {
    add('state', `status must start with one of ${STATES.map(([p]) => p).join(' / ')}`);
  } else if (
    state === 'open' &&
    row.level === 'P3' &&
    row.id >= legacy.tierRequiredFromId &&
    !rowTier(row.status)
  ) {
    add('tier', 'an open P3 says its tier: 「开放（阶段内处理…）」 or 「开放（挂起：<理由>）」');
  }
  return out;
}

/** Legacy-table problems as printable lines; `[]` means the table is clean. */
export function lintLegacy(rows, legacy) {
  if (rows.length === 0) return ['legacy table: no rows found (an empty sample is not a pass)'];
  const problems = [];
  const grandfathered = new Map(Object.entries(legacy.grandfathered ?? {}).map(([k, v]) => [Number(k), v]));
  const used = new Set();
  let previous = 0;
  for (const row of rows) {
    if (!(row.id > previous)) {
      problems.push(`legacy ${row.id} (line ${row.line}): ids ascend and are unique; this one follows ${previous}`);
    }
    previous = Math.max(previous, row.id);
    for (const v of rowViolations(row, legacy)) {
      if (grandfathered.get(v.id) === v.rule) used.add(v.id);
      else problems.push(`legacy ${v.id} (line ${row.line}): ${v.message}`);
    }
  }
  for (const [id, rule] of grandfathered) {
    if (!used.has(id)) {
      problems.push(
        `legacy.grandfathered["${id}"] = "${rule}": the row no longer breaks that rule or has left the table — remove the entry (the list only shrinks)`,
      );
    }
  }
  return problems;
}

/** `### 3.N title` sections of release.md: `[{ n, title, body }]`, body up to the next heading. */
export function releaseSections(md) {
  const out = [];
  let fenced = false; // a `# comment` inside a code block is not a heading
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^### 3\.(\d+) (.*)$/.exec(line);
    if (m) {
      out.push({ n: Number(m[1]), title: m[2].trim(), body: [] });
    } else if (!fenced && /^##? /.test(line)) {
      out.push(undefined); // a higher heading ends the section before it
    } else if (out.at(-1)) out.at(-1).body.push(line);
  }
  return out.filter(Boolean).map((s) => ({ ...s, body: s.body.join('\n') }));
}

const HOST_STEPS = ['无', '窗口前', '窗口内', '应用后'];

/**
 * The host-step line a section opens with: `{ host: ['窗口前', …], maintainer: boolean }`, or
 * undefined when the first line of the body is not a well-formed one. 「无」 stands alone.
 */
export function hostStepTag(body) {
  const first = body.split('\n').find((l) => l.trim() !== '') ?? '';
  const m = /^> 主机步骤：([^；]+)；维护者本人：(是|否)\s*$/.exec(first);
  if (!m) return undefined;
  const host = m[1].split('、').map((h) => h.trim());
  if (!host.every((h) => HOST_STEPS.includes(h)) || new Set(host).size !== host.length) return undefined;
  if (host.includes('无') && (host.length > 1 || m[2] === '是')) return undefined;
  return { host, maintainer: m[2] === '是' };
}

/** Sections numbered `from` or later that do not open with a host-step line. */
export function lintReleaseSections(md, from) {
  return releaseSections(md)
    .filter((s) => s.n >= from && !hostStepTag(s.body))
    .map(
      (s) =>
        `${RELEASE_MD} §3.${s.n}: the section opens with its host-step line, e.g. "> 主机步骤：无；维护者本人：否" (steps: ${HOST_STEPS.join(' / ')}, several joined by 、)`,
    );
}

/** Budget problems as printable lines. `sizeOf(file)` returns bytes, or undefined when missing. */
export function lintBudgets(docBudgets, sizeOf) {
  const problems = [];
  for (const [file, budget] of Object.entries(docBudgets)) {
    const size = sizeOf(file);
    if (size === undefined) {
      problems.push(`${file}: budgeted file is missing`);
    } else if (size > budget.ceiling) {
      problems.push(
        `${file}: ${size} bytes is over its ceiling of ${budget.ceiling} — move finished material out (docs/runbooks/dev-loop.md §6), do not raise the ceiling`,
      );
    }
  }
  return problems;
}

/** Ceilings the head raised over the base, or dropped the budget of: `[{ file, base, head }]`. */
export function budgetRaises(baseBudgets, headBudgets) {
  const raises = [];
  for (const [file, budget] of Object.entries(baseBudgets ?? {})) {
    const head = headBudgets?.[file]?.ceiling;
    if (head === undefined || head > budget.ceiling) raises.push({ file, base: budget.ceiling, head });
  }
  return raises;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;

/** -1 / 0 / 1 for two `vX.Y.Z` (or `X.Y.Z`) versions. */
export function compareVersions(a, b) {
  const parts = (v) => v.replace(/^v/, '').split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Shape problems of docs/state/loop.json as printable lines. */
export function lintConfig(cfg) {
  const problems = [];
  const need = (ok, message) => ok || problems.push(`${LOOP_STATE}: ${message}`);
  need(cfg?.schema === 1, '"schema" must be 1');
  need(VERSION.test(cfg?.host?.version ?? ''), '"host.version" must look like vX.Y.Z');
  need(
    /^\d{4}-\d{2}-\d{2}$/.test(cfg?.host?.appliedOn ?? '') && !Number.isNaN(Date.parse(cfg.host.appliedOn)),
    '"host.appliedOn" must be a YYYY-MM-DD date',
  );
  const cadence = cfg?.cadence ?? {};
  for (const key of ['hostLagRemindReleases', 'hostLagRemindDays', 'stalePrDays']) {
    need(isCount(cadence[key]) && cadence[key] > 0, `"cadence.${key}" must be a positive integer`);
  }
  need(
    typeof cadence.recordCommitShareMax === 'number' &&
      cadence.recordCommitShareMax > 0 &&
      cadence.recordCommitShareMax <= 1,
    '"cadence.recordCommitShareMax" must be a share in (0, 1]',
  );
  const budgets = Object.entries(cfg?.docBudgets ?? {});
  need(budgets.length > 0, '"docBudgets" must list at least one file');
  for (const [file, b] of budgets) {
    need(
      isCount(b?.ceiling) && isCount(b?.target) && b.target <= b.ceiling,
      `"docBudgets.${file}" needs integer "target" <= "ceiling"`,
    );
  }
  const legacy = cfg?.legacy ?? {};
  for (const key of ['tierRequiredFromId', 'inStageWipCap', 'weeklyNewP3Soft']) {
    need(isCount(legacy[key]), `"legacy.${key}" must be a non-negative integer`);
  }
  need(
    isCount(cfg?.release?.hostStepTagFromSection) && cfg.release.hostStepTagFromSection > 0,
    '"release.hostStepTagFromSection" must be a positive integer',
  );
  for (const [id, rule] of Object.entries(legacy.grandfathered ?? {})) {
    need(
      /^\d+$/.test(id) && ['cells', 'level', 'state', 'tier'].includes(rule),
      `"legacy.grandfathered.${id}" must map a row id to cells / level / state / tier`,
    );
  }
  return problems;
}

/**
 * Host-version problems: it must be a release tag (when the checkout has tags) and not newer
 * than the checkout's own version. `tags` is the list of tags, or undefined when unknown.
 */
export function lintHostVersion(hostVersion, packageVersion, tags, requireTags) {
  const problems = [];
  if (compareVersions(hostVersion, packageVersion) > 0) {
    problems.push(`${LOOP_STATE}: host.version ${hostVersion} is newer than this checkout (${packageVersion})`);
  }
  if (tags === undefined || tags.length === 0) {
    if (requireTags) problems.push('no release tags in this checkout (--require-tags): fetch tags first');
  } else if (!tags.includes(hostVersion)) {
    problems.push(`${LOOP_STATE}: host.version ${hostVersion} is not a release tag`);
  }
  return problems;
}

export function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

export const readRepoFile = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
export const readLoopState = () => JSON.parse(readRepoFile(LOOP_STATE));

export function fileSize(rel) {
  try {
    return statSync(path.join(REPO_ROOT, rel)).size;
  } catch {
    return undefined;
  }
}

/** Release tags of the checkout (`vX.Y.Z`), or undefined when git gives none. */
export function releaseTags() {
  const out = git(['tag', '--list', 'v*']);
  return out === undefined ? undefined : out.split('\n').filter((t) => VERSION.test(t));
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--base');
  const base = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !base) {
    console.error('usage: loop-ledger.mjs [--base <git ref> [--allow-raise]] [--require-tags]');
    process.exit(2);
  }
  const allowRaise = args.includes('--allow-raise');

  let cfg;
  try {
    cfg = readLoopState();
  } catch (err) {
    console.error(`loop-ledger: ${LOOP_STATE}: ${err.message}`);
    process.exit(1);
  }
  const problems = lintConfig(cfg);
  if (problems.length === 0) {
    const rows = parseLegacyTable(readRepoFile(STATUS));
    problems.push(...lintLegacy(rows, cfg.legacy));
    problems.push(...lintBudgets(cfg.docBudgets, fileSize));
    problems.push(...lintReleaseSections(readRepoFile(RELEASE_MD), cfg.release.hostStepTagFromSection));
    const packageVersion = JSON.parse(readRepoFile('package.json')).version;
    problems.push(
      ...lintHostVersion(cfg.host.version, packageVersion, releaseTags(), args.includes('--require-tags')),
    );
    if (base) {
      const baseText = git(['show', `${base}:${LOOP_STATE}`]);
      // Not on the base yet (the PR that adds the file): nothing to compare with.
      const raises = baseText === undefined ? [] : budgetRaises(JSON.parse(baseText).docBudgets, cfg.docBudgets);
      for (const r of raises) {
        const line = `${LOOP_STATE}: docBudgets["${r.file}"].ceiling goes up ${r.base} -> ${r.head ?? '(removed)'}`;
        if (allowRaise) console.log(`loop-ledger: ${line} (allowed: ratchet-raise label)`);
        else problems.push(`${line} — ceilings only go down; a reviewed raise carries the ratchet-raise label`);
      }
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`loop-ledger: ${p}`);
    process.exit(1);
  }
  console.log(`loop-ledger: OK${base ? ` against ${base}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
