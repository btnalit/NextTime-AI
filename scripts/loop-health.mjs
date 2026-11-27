#!/usr/bin/env node
// scripts/loop-health.mjs — the development loop's patrol report (docs/runbooks/dev-loop.md §7).
//
// The coordinator has no clock of its own: it acts when a message wakes it. This script is what a
// scheduled patrol runs, so that a deviation is found by a deterministic check and comes with the
// role that owns the next step, instead of being noticed by the maintainer. It reads the checkout
// (docs/state/loop.json, docs/STATUS.md §4, git history and tags) and, when asked, GitHub and the
// project's shared folder. It changes nothing.
//
//   node scripts/loop-health.mjs [--json] [--strict] [--now <ISO time>]
//                                [--github] [--memory-index <file>] [--project-files <dir>]
//
//   --github          also list open pull requests that went quiet (needs `gh`)
//   --memory-index    also check the project memory index against its 12 KB limit
//   --project-files   also list acceptance notes of released pull requests still waiting to be
//                     archived, and host-upgrade prompts written for an older tag
//   --strict          exit 1 when a finding needs action (the report itself always prints)
//
// Each finding is one of: ok / watch / act / no-sample. A check that could not read its sample
// (a shallow clone without history, no tags) says no-sample; it never reports ok.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  STATUS,
  compareVersions,
  fileSize,
  git,
  isOpenRow,
  isReleaseBlocker,
  parseLegacyTable,
  readLoopState,
  readRepoFile,
  rowState,
  rowTier,
} from './guards/loop-ledger.mjs';

const DAY = 86_400_000;
const MEMORY_INDEX_LIMIT = 12 * 1024;
const DEEPEN = 'git fetch --shallow-since=<8 天前的日期> origin main';
const daysBetween = (from, to) => Math.floor((to - from) / DAY);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/** Counts of the rows that are still open work, by level and by P3 tier. */
export function legacyCounts(rows) {
  const open = rows.filter(isOpenRow);
  const level = (l) => open.filter((r) => r.level === l).length;
  const p3 = open.filter((r) => r.level === 'P3');
  return {
    open: open.length,
    p1: level('P1'),
    p2: level('P2'),
    p3: p3.length,
    inStage: p3.filter((r) => rowTier(r.status) === 'in_stage').length,
    parked: p3.filter((r) => rowTier(r.status) === 'parked').length,
    closedInTable: rows.filter((r) => rowState(r.status) === 'closed').length,
    blockers: rows.filter(isReleaseBlocker).map((r) => r.id),
  };
}

/**
 * Flow of open rows between two readings of the table. `closed` is exact for rows open in the
 * base; `registered` counts rows that are open now and were not open then, so a row registered
 * and closed inside the window is in neither (it does not change the net).
 */
export function legacyFlow(baseRows, headRows) {
  const openIds = (rows) => new Set(rows.filter(isOpenRow).map((r) => r.id));
  const [base, head] = [openIds(baseRows), openIds(headRows)];
  const registered = headRows.filter((r) => head.has(r.id) && !base.has(r.id));
  return {
    closed: [...base].filter((id) => !head.has(id)).length,
    registered: registered.length,
    registeredP3: registered.filter((r) => r.level === 'P3').length,
    net: head.size - base.size,
  };
}

/** Share of commit subjects that only record: `docs…` of the Conventional Commits type. */
export function commitMix(subjects) {
  const type = (s) => /^([a-z]+)(\([^)]*\))?!?:/.exec(s)?.[1];
  const docs = subjects.filter((s) => type(s) === 'docs').length;
  return {
    total: subjects.length,
    docs,
    status: subjects.filter((s) => /^docs\(status\)/.test(s)).length,
    share: subjects.length === 0 ? undefined : docs / subjects.length,
  };
}

/** Release tags newer than the host's, oldest first. `tags` is `[{ name, date }]`. */
export function releasesAhead(tags, hostVersion) {
  return tags
    .filter((t) => compareVersions(t.name, hostVersion) > 0)
    .sort((a, b) => compareVersions(a.name, b.name));
}

/**
 * The report: `[{ key, level, owner, message, action }]`, most urgent first. `input` holds what
 * `collect` read; a part that could not be read is undefined and becomes a no-sample finding.
 */
export function assess(input) {
  const { cfg, now } = input;
  const findings = [];
  const add = (key, level, owner, message, action = '') => findings.push({ key, level, owner, message, action });

  // 1. Released but not on the host: the loop ends at the host, not at the tag.
  if (input.tags === undefined || input.tags.length === 0) {
    add('host-lag', 'no-sample', '协调线程', '读不到发布 tag（浅克隆？先 git fetch --tags）');
  } else {
    const ahead = releasesAhead(input.tags, cfg.host.version);
    const days = daysBetween(Date.parse(cfg.host.appliedOn), now);
    const latest = ahead.at(-1)?.name ?? cfg.host.version;
    const late = ahead.length >= cfg.cadence.hostLagRemindReleases || (ahead.length > 0 && days >= cfg.cadence.hostLagRemindDays);
    add(
      'host-lag',
      late ? 'act' : 'ok',
      '协调线程',
      `主机在 ${cfg.host.version}（${cfg.host.appliedOn} 起，${days} 天），之后已发 ${ahead.length} 个版本，最新 ${latest}`,
      late
        ? `确认现行升级简报是给 ${latest} 的（node scripts/host-upgrade-brief.mjs --from ${cfg.host.version} --to ${latest}）、staging 演练是绿的，然后提醒维护者一次；升不升由维护者决定`
        : '',
    );
  }

  // 2. Hot documents against their budgets.
  for (const [file, budget] of Object.entries(cfg.docBudgets)) {
    const size = input.sizes[file];
    if (size === undefined) {
      add(`doc:${file}`, 'no-sample', '合并线程', `${file} 不存在`);
      continue;
    }
    const near = size > budget.ceiling * 0.95;
    add(
      `doc:${file}`,
      near ? 'act' : size > budget.target ? 'watch' : 'ok',
      '合并线程',
      `${file} ${kb(size)}（上限 ${kb(budget.ceiling)}，目标 ${kb(budget.target)}）`,
      near ? '离上限不到 5%：先把已完成的内容移到归档（dev-loop.md §6），再写新的' : '',
    );
  }

  // 3. Legacy: what is open, and whether the review loop registers more than it closes.
  if (input.legacy === undefined) {
    add('legacy', 'no-sample', '合并线程', `${STATUS} 的遗留表读不出来`);
  } else {
    const c = legacyCounts(input.legacy);
    add(
      'legacy-open',
      c.p1 > 0 ? 'act' : 'ok',
      '协调线程',
      `开放遗留 ${c.open} 条：P1 ${c.p1}、P2 ${c.p2}、P3 ${c.p3}（阶段内处理 ${c.inStage}、挂起 ${c.parked}）`,
      c.p1 > 0 ? '有开放的 P1：排到所有新功能之前' : '',
    );
    if (c.inStage > cfg.legacy.inStageWipCap) {
      add(
        'legacy-wip',
        'act',
        '协调线程',
        `「阶段内处理」档 ${c.inStage} 条，超过上限 ${cfg.legacy.inStageWipCap}`,
        '重新分档：留下用户可见的错误与削弱不变量、隔离、凭据路径、审计的，其余改挂起并写理由',
      );
    }
    if (c.blockers.length > 0) {
      add('release-blockers', 'watch', '合并线程', `标着「发版前必须关闭」的开放遗留：${c.blockers.join('、')}`, '关闭之前不合 release PR');
    }
    if (c.closedInTable > 0) {
      add('legacy-closed-rows', 'watch', '合并线程', `遗留表里有 ${c.closedInTable} 条已关闭的行`, '下次发版后的记录里整行移到 status-history.md');
    }
    const grandfathered = Object.keys(cfg.legacy.grandfathered ?? {}).length;
    if (grandfathered > 0) {
      add('legacy-grandfathered', 'watch', '合并线程', `${grandfathered} 行遗留仍靠豁免通过守卫`, '顺手改成规范写法，并从 loop.json 的 grandfathered 里删掉');
    }
    if (input.legacyWeekAgo === undefined) {
      add('legacy-flow', 'no-sample', '协调线程', `读不到 7 天前的遗留表（历史不够：先 ${DEEPEN}）`);
    } else {
      const f = legacyFlow(input.legacyWeekAgo, input.legacy);
      const over = f.registeredP3 > cfg.legacy.weeklyNewP3Soft;
      add(
        'legacy-flow',
        over ? 'act' : f.net > 0 ? 'watch' : 'ok',
        '协调线程',
        `近 7 天遗留：新登记且仍开放 ${f.registered} 条（P3 ${f.registeredP3}），关闭 ${f.closed} 条，净 ${f.net >= 0 ? '+' : ''}${f.net}`,
        over
          ? `新 P3 超过每周 ${cfg.legacy.weeklyNewP3Soft} 条：本周其余新发现默认进挂起档；同一类问题第三次出现就归并成一条「类」遗留，并开一个设计决定（dev-loop.md §4）`
          : '',
      );
    }
  }

  // 4. How much of the week's commits only record.
  if (input.subjects === undefined) {
    add('commit-mix', 'no-sample', '合并线程', `读不到近 7 天的提交（历史不够：先 ${DEEPEN}）`);
  } else {
    const m = commitMix(input.subjects);
    if (m.share === undefined) {
      add('commit-mix', 'no-sample', '合并线程', '近 7 天没有提交');
    } else {
      const high = m.share > cfg.cadence.recordCommitShareMax;
      add(
        'commit-mix',
        high ? 'watch' : 'ok',
        '合并线程',
        `近 7 天 ${m.total} 次提交，其中文档与记录 ${m.docs} 次（${Math.round(m.share * 100)}%，docs(status) ${m.status} 次）`,
        high ? `超过 ${Math.round(cfg.cadence.recordCommitShareMax * 100)}%：记录按批写（dev-loop.md §6），不为每个 PR 单开记录 PR` : '',
      );
    }
  }

  // 5. Optional readings.
  if (input.memoryIndexSize !== undefined) {
    const size = input.memoryIndexSize;
    add(
      'memory-index',
      size > MEMORY_INDEX_LIMIT ? 'act' : size > MEMORY_INDEX_LIMIT * 0.85 ? 'watch' : 'ok',
      '协调线程',
      `记忆索引 ${size} 字节（上限 ${MEMORY_INDEX_LIMIT}）`,
      size > MEMORY_INDEX_LIMIT * 0.85 ? '先删流水与已入库的规则，只留指针、线程与当期状态' : '',
    );
  }
  for (const pr of input.quietPulls ?? []) {
    add(
      `pr:${pr.number}`,
      'act',
      '协调线程',
      `#${pr.number}${pr.draft ? '（draft）' : ''} ${pr.days} 天没有动静：${pr.title}`,
      '问作者线程卡在哪一步；等评审的直接找对应席位',
    );
  }
  if ((input.archivable ?? []).length > 0) {
    add('archive', 'watch', '协调线程', `共享文件夹里 ${input.archivable.length} 份已发版的稿子没归档：${input.archivable.join('、')}`, '按共享文件夹 README 的归档规则移走');
  }

  const order = { act: 0, 'no-sample': 1, watch: 2, ok: 3 };
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}

const LABEL = { act: '该处理', 'no-sample': '无样本', watch: '留意', ok: '正常' };

export function render(findings) {
  const lines = findings.map((f) => `[${LABEL[f.level]}] ${f.message}${f.action ? `\n        → ${f.owner}：${f.action}` : ''}`);
  const count = (level) => findings.filter((f) => f.level === level).length;
  lines.push('', `合计：该处理 ${count('act')}，无样本 ${count('no-sample')}，留意 ${count('watch')}，正常 ${count('ok')}`);
  return lines.join('\n');
}

/** Acceptance notes in `<dir>/console-ux/` whose pull request is already inside a release tag. */
export function archivableNotes(names, isReleased, latestTag) {
  const out = [];
  for (const name of names) {
    const acceptance = /^console-ux\/acceptance-(\d+)\.md$/.exec(name);
    if (acceptance && isReleased(Number(acceptance[1]))) out.push(name);
    const prompt = /^host-upgrade-(v\d+\.\d+\.\d+)\.md$/.exec(name);
    if (prompt && latestTag && compareVersions(prompt[1], latestTag) < 0) out.push(name);
  }
  return out;
}

function collect(args) {
  const flag = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const now = flag('--now') ? Date.parse(flag('--now')) : Date.now();
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const cfg = readLoopState();

  const tagLines = git(['for-each-ref', '--format=%(refname:short) %(creatordate:short)', 'refs/tags/v*']);
  const tags = tagLines
    ?.split('\n')
    .filter((l) => /^v\d+\.\d+\.\d+ /.test(l))
    .map((l) => ({ name: l.split(' ')[0], date: l.split(' ')[1] }));

  let legacy;
  try {
    legacy = parseLegacyTable(readRepoFile(STATUS));
  } catch {
    legacy = undefined;
  }
  let legacyWeekAgo;
  const baseRev = git(['rev-list', '-1', `--before=${weekAgo}`, 'HEAD'])?.trim();
  const baseStatus = baseRev ? git(['show', `${baseRev}:${STATUS}`]) : undefined;
  if (baseStatus !== undefined) {
    try {
      legacyWeekAgo = parseLegacyTable(baseStatus);
    } catch {
      legacyWeekAgo = undefined;
    }
  }
  // Without the commit before the window the log may be cut short by a shallow clone.
  const subjects = baseRev ? git(['log', `--since=${weekAgo}`, '--format=%s', 'HEAD'])?.split('\n').filter(Boolean) : undefined;

  const input = {
    cfg,
    now,
    tags,
    sizes: Object.fromEntries(Object.keys(cfg.docBudgets).map((f) => [f, fileSize(f)])),
    legacy,
    legacyWeekAgo,
    subjects,
  };

  const memoryIndex = flag('--memory-index');
  if (memoryIndex) input.memoryIndexSize = statSync(memoryIndex).size;

  if (args.includes('--github')) {
    const slug = process.env.GITHUB_REPOSITORY ?? /github\.com[:/]([^/]+\/[^/.\s]+)/.exec(git(['remote', 'get-url', 'origin']) ?? '')?.[1];
    const pulls = JSON.parse(
      execFileSync('gh', ['api', `repos/${slug}/pulls?state=open&per_page=100`], { encoding: 'utf8' }),
    );
    input.quietPulls = pulls
      .map((p) => ({ number: p.number, title: p.title, draft: p.draft, days: daysBetween(Date.parse(p.updated_at), now) }))
      .filter((p) => p.days >= cfg.cadence.stalePrDays && !/^chore\(main\): release /.test(p.title));
  }

  const projectFiles = flag('--project-files');
  if (projectFiles) {
    const latest = tags && tags.length > 0 ? [...tags].sort((a, b) => compareVersions(a.name, b.name)).at(-1).name : undefined;
    const notes = path.join(projectFiles, 'console-ux');
    const names = [
      ...readdirSync(projectFiles),
      ...(existsSync(notes) ? readdirSync(notes).map((n) => `console-ux/${n}`) : []),
    ];
    // A squash merge's subject ends "(#<PR>)"; the PR is released when that commit is in the tag.
    const isReleased = (pr) => latest !== undefined && (git(['log', '-1', '--format=%H', `--grep=(#${pr})$`, latest]) ?? '').trim() !== '';
    input.archivable = archivableNotes(names, isReleased, latest);
  }
  return input;
}

function main() {
  const args = process.argv.slice(2);
  const findings = assess(collect(args));
  console.log(args.includes('--json') ? JSON.stringify(findings, null, 2) : render(findings));
  if (args.includes('--strict') && findings.some((f) => f.level === 'act')) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
