#!/usr/bin/env node
// scripts/pr-gate.mjs — the steward's pre-merge checks as one command (docs/runbooks/dev-loop.md
// §3 and docs/runbooks/release.md §1 item 4). It only reads; merging stays the steward's own step.
//
//   node scripts/pr-gate.mjs merge <PR> [--steward]
//       open and ready · required checks green on the head · not behind main · every review
//       seat the paths require (scripts/review-route.mjs) has passed this head · the hot docs
//       are only touched by the steward (--steward) · the body says what to record
//   node scripts/pr-gate.mjs release <PR> [--skip-audit]
//       a release-please PR · required checks green · not behind main · the hand-written notes
//       are in the body · no open legacy row marked 「发版前必须关闭」 · `pnpm audit` clean
//
// A review seat passes a head by a comment or review on the pull request carrying one line (it is
// bookkeeping against a missed review, not authentication — every thread posts as the same user):
//   <!-- review-verdict seat=<seat> head=<commit sha, 7+ hex> verdict=pass|block -->
// The latest line of a seat counts. It covers the head while every later commit of the pull
// request only merges main in; any other push needs a new verdict.
//
// Last line: `RESULT ok` or `RESULT failed=<check>[,<check>…]`. A check that was skipped
// (--skip-audit) is a failure: a skipped step is never `RESULT ok`.
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STATUS, isReleaseBlocker, parseLegacyTable } from './guards/loop-ledger.mjs';
import { pullFiles, readMap, repoSlug, route } from './review-route.mjs';

const REQUIRED_CHECKS = ['guards', 'quality', 'test'];
const NOTES = ['升级须知', '这一版是什么', '已知问题', '回滚'];
const HANDOFF = /合入后.*写入的状态/;
const VERDICT = /<!--\s*review-verdict\s+seat=([\w-]+)\s+head=([0-9a-f]{7,40})\s+verdict=(pass|block)\s*-->/g;

/** The latest verdict of each seat, from comment bodies in the order they were posted. */
export function latestVerdicts(commentBodies) {
  const out = new Map();
  for (const body of commentBodies) {
    for (const m of (body ?? '').matchAll(VERDICT)) out.set(m[1], { head: m[2], verdict: m[3] });
  }
  return out;
}

/**
 * Check-run problems on a head. `runs` is `[{ name, status, conclusion }]`; a name that ran more
 * than once must be green every time. `mustSucceed` names may not be skipped.
 */
export function checkProblems(runs, required, mustSucceed = []) {
  const problems = [];
  for (const name of required) {
    const mine = runs.filter((r) => r.name === name);
    if (mine.length === 0) problems.push(`${name} has not run`);
    else if (mustSucceed.includes(name) && !mine.every((r) => r.conclusion === 'success')) {
      problems.push(`${name} is ${mine.map((r) => r.conclusion ?? r.status).join('/')}`);
    }
  }
  for (const r of runs) {
    if (r.status !== 'completed') problems.push(`${r.name} is ${r.status}`);
    else if (!['success', 'skipped', 'neutral'].includes(r.conclusion)) problems.push(`${r.name} is ${r.conclusion}`);
  }
  return [...new Set(problems)];
}

/**
 * Whether a verdict given on `verdictHead` still covers the pull request's head: it does when
 * every commit after it only merges the base branch in (the steward's update-branch before a
 * merge). `commits` is the pull request's own commits, oldest first: `[{ sha, parents: [sha…] }]`;
 * `onBase(sha)` says whether a commit is on the base branch. A merge counts when one of its
 * parents is — a merge of some other branch does not. What a merge commit changes by hand while
 * resolving conflicts is not seen here.
 */
export function verdictCovers(verdictHead, commits, onBase) {
  const at = commits.findIndex((c) => c.sha.startsWith(verdictHead));
  return at >= 0 && commits.slice(at + 1).every((c) => c.parents.length >= 2 && c.parents.some(onBase));
}

const check = (name, problems, pass) => ({ name, ok: problems.length === 0, detail: problems.length === 0 ? pass : problems.join('; ') });

function commonChecks(pr, runs, behindBy, required, mustSucceed) {
  return [
    check('open', pr.state === 'open' && !pr.merged ? [] : [`pull request is ${pr.merged ? 'merged' : pr.state}`], 'open'),
    check('checks', checkProblems(runs, required, mustSucceed), `${runs.length} check runs green on ${pr.head.sha.slice(0, 8)}`),
    check('up-to-date', behindBy === 0 ? [] : [`${behindBy} commit(s) behind ${pr.base.ref}`], `not behind ${pr.base.ref}`),
  ];
}

/** Merge checks. `input`: { pr, runs, behindBy, files, commits, onBase, comments, map, steward }. */
export function mergeChecks({ pr, runs, behindBy, files, commits, onBase, comments, map, steward }) {
  const routed = route(map, files);
  const needsUx = routed.seats.includes('ux');
  const checks = commonChecks(pr, runs, behindBy, needsUx ? [...REQUIRED_CHECKS, 'web-e2e'] : REQUIRED_CHECKS, needsUx ? ['web-e2e'] : []);
  checks.splice(1, 0, check('ready', pr.draft ? ['still a draft: the author marks it ready'] : [], 'not a draft'));

  const verdicts = latestVerdicts(comments);
  const missing = [];
  for (const seat of routed.seats) {
    const v = verdicts.get(seat);
    if (!v) missing.push(`${seat}: no verdict`);
    else if (v.verdict !== 'pass') missing.push(`${seat}: ${v.verdict}`);
    else if (!verdictCovers(v.head, commits, onBase)) {
      missing.push(`${seat}: passed ${v.head}, but the head ${pr.head.sha.slice(0, 8)} has later changes`);
    }
  }
  if (routed.risk === undefined) missing.push('no changed files');
  checks.push(check('reviews', missing, `${routed.risk}: ${routed.seats.join(', ') || 'no seat required'}`));

  checks.push(
    check(
      'steward-only',
      routed.stewardOnly.length > 0 && !steward ? [`touches ${routed.stewardOnly.join(', ')} — only the steward's record PR does (--steward)`] : [],
      routed.stewardOnly.length > 0 ? 'steward record PR' : 'hot docs untouched',
    ),
  );
  const needsHandoff = !steward && routed.risk !== 'R0';
  checks.push(
    check(
      'handoff',
      needsHandoff && !HANDOFF.test(pr.body ?? '') ? ['the body has no 「合入后由合并线程写入的状态」 section'] : [],
      needsHandoff ? 'the body says what to record' : 'not needed',
    ),
  );
  return checks;
}

/** Release checks. `input`: { pr, runs, behindBy, statusMd, audit }. */
export function releaseChecks({ pr, runs, behindBy, statusMd, audit }) {
  const isRelease = /^chore\(main\): release \d+\.\d+\.\d+$/.test(pr.title) && pr.head.ref.startsWith('release-please--');
  const checks = [
    check('release-pr', isRelease ? [] : [`"${pr.title}" on ${pr.head.ref} is not a release-please PR`], pr.title),
    ...commonChecks(pr, runs, behindBy, REQUIRED_CHECKS, REQUIRED_CHECKS),
  ];
  const absent = NOTES.filter((n) => !(pr.body ?? '').includes(n));
  checks.push(check('notes', absent.map((n) => `no 「${n}」 in the body`), 'hand-written notes are in the body'));
  const blockers = parseLegacyTable(statusMd).filter(isReleaseBlocker).map((r) => r.id);
  checks.push(check('blockers', blockers.length > 0 ? [`open legacy marked 「发版前必须关闭」: ${blockers.join(', ')}`] : [], 'no open release blocker'));
  checks.push(check('audit', audit.ok ? [] : [audit.detail], 'pnpm audit: no high or critical advisory'));
  return checks;
}

export function render(checks) {
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  return [
    ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name} — ${c.detail}`),
    failed.length === 0 ? 'RESULT ok' : `RESULT failed=${failed.join(',')}`,
  ].join('\n');
}

const gh = (path, accept) =>
  execFileSync('gh', ['api', ...(accept ? ['-H', `Accept: ${accept}`] : []), path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function pages(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = JSON.parse(gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
    const list = Array.isArray(batch) ? batch : batch.check_runs;
    all.push(...list);
    if (list.length < 100) return all;
  }
}

function main() {
  const [mode, number, ...flags] = process.argv.slice(2);
  if (!['merge', 'release'].includes(mode) || !/^\d+$/.test(number ?? '')) {
    console.error('usage: pr-gate.mjs merge <PR> [--steward] | pr-gate.mjs release <PR> [--skip-audit]');
    process.exit(2);
  }
  const slug = repoSlug();
  const pr = JSON.parse(gh(`repos/${slug}/pulls/${number}`));
  const runs = pages(`repos/${slug}/commits/${pr.head.sha}/check-runs`);
  const behindBy = JSON.parse(gh(`repos/${slug}/compare/${pr.base.ref}...${pr.head.sha}`)).behind_by;

  let checks;
  if (mode === 'merge') {
    checks = mergeChecks({
      pr,
      runs,
      behindBy,
      files: pullFiles(slug, number),
      commits: pages(`repos/${slug}/pulls/${number}/commits`).map((c) => ({ sha: c.sha, parents: c.parents.map((p) => p.sha) })),
      // On the base branch: the base is not behind it. Asked only for the parents of merge commits
      // pushed after a verdict.
      onBase: (sha) => JSON.parse(gh(`repos/${slug}/compare/${pr.base.ref}...${sha}`)).ahead_by === 0,
      // A seat may answer in a comment or in a review body; the latest of either counts.
      comments: [
        ...pages(`repos/${slug}/issues/${number}/comments`).map((c) => ({ at: c.created_at, body: c.body })),
        ...pages(`repos/${slug}/pulls/${number}/reviews`).map((c) => ({ at: c.submitted_at, body: c.body })),
      ]
        .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
        .map((c) => c.body),
      map: readMap(),
      steward: flags.includes('--steward'),
    });
  } else {
    let audit = { ok: false, detail: 'skipped (--skip-audit): run `pnpm audit --audit-level high` before merging' };
    if (!flags.includes('--skip-audit')) {
      const run = spawnSync('pnpm', ['audit', '--audit-level', 'high'], { cwd: REPO_ROOT, encoding: 'utf8' });
      audit = { ok: run.status === 0, detail: `pnpm audit --audit-level high exited ${run.status ?? run.error?.message}` };
    }
    checks = releaseChecks({
      pr,
      runs,
      behindBy,
      statusMd: gh(`repos/${slug}/contents/${STATUS}?ref=${pr.base.ref}`, 'application/vnd.github.raw'),
      audit,
    });
  }
  console.log(render(checks));
  if (checks.some((c) => !c.ok)) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
