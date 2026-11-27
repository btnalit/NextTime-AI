#!/usr/bin/env node
// scripts/host-upgrade-brief.mjs — the facts of a host upgrade, computed from the two tags instead
// of counted by hand (docs/runbooks/host-upgrade-session.md §3). It prints a Markdown brief:
//
//   - the releases the upgrade crosses, from the tags;
//   - the migrations it brings, from the diff of packages/kernel/migrations between the tags;
//   - the release.md §3 sections to read: every `### 3.N` heading the target tag has and the
//     starting tag does not, with gaps in the numbering called out, and which of them name a
//     step only the maintainer does;
//   - whether compose, .env.example, scripts/apply-release.sh or deploy/ changed;
//   - the staging rehearsal of this exact path (`--staging-run <id>`): checked on GitHub to be
//     green and to be this from -> to, or the command that dispatches it.
//
// It refuses a starting tag that is not the host version recorded in docs/state/loop.json
// (`--force` to print anyway, for a what-if), and exits 1 when the rehearsal named is not a green
// run of this path. The steward adds the notes that need judgment; the standing rules of the host
// session are in docs/runbooks/host-upgrade-session.md and are not repeated in the brief.
//
//   node scripts/host-upgrade-brief.mjs --from v0.63.0 --to v0.70.1 [--staging-run <id>] [--force]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  RELEASE_MD,
  compareVersions,
  git,
  hostStepTag,
  readLoopState,
  releaseSections,
} from './guards/loop-ledger.mjs';
import { repoSlug } from './review-route.mjs';

const MIGRATIONS = 'packages/kernel/migrations';
// Sections written before the host-step line existed are only screened by these words: the
// first for steps only the maintainer does, the second for checks to run before the window.
const MAINTAINER_WORDS = /victor|维护者|在控制台|轮换/;
const PRECHECK_WORDS = /升级前|预检|主机动作|psql/;
// Paths whose change between the two tags changes what the window does.
const WINDOW_PATHS = ['docker-compose.yml', '.env.example', 'scripts/apply-release.sh', 'deploy'];

/**
 * Sorts the sections of an upgrade by their host-step line: `{ none, steps: { 窗口前: […], … },
 * maintainer, untagged, screened, prechecks }`. `untagged` have no line (older sections); of those,
 * `screened` mention the maintainer or the console and `prechecks` mention a check before the
 * upgrade, a host action or psql — rough screens, not a classification.
 */
export function sortSections(list) {
  const out = { none: [], steps: { 窗口前: [], 窗口内: [], 应用后: [] }, maintainer: [], untagged: [], screened: [], prechecks: [] };
  for (const s of list) {
    const tag = hostStepTag(s.body);
    if (!tag) {
      out.untagged.push(s);
      if (MAINTAINER_WORDS.test(s.body)) out.screened.push(s);
      if (PRECHECK_WORDS.test(s.body)) out.prechecks.push(s);
    } else if (tag.host.includes('无')) out.none.push(s);
    else {
      for (const h of tag.host) out.steps[h].push(s);
      if (tag.maintainer) out.maintainer.push(s);
    }
  }
  return out;
}

/** Sections the target has and the start does not, in order. */
export function newSections(fromMd, toMd) {
  const had = new Set(releaseSections(fromMd).map((s) => s.n));
  return releaseSections(toMd).filter((s) => !had.has(s.n));
}

/** Consecutive runs of sorted integers: `[[133, 198], [201, 220]]`. */
export function runs(numbers) {
  const out = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    if (out.length > 0 && n === out.at(-1)[1] + 1) out.at(-1)[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** Migration files added between the tags, by directory: `{ core: ['0054', …], … }`. */
export function migrationsAdded(nameStatus) {
  const out = {};
  for (const line of nameStatus.split('\n')) {
    const m = new RegExp(`^A\\t${MIGRATIONS}/([^/]+)/(\\d+)_[^/]*\\.sql$`).exec(line);
    if (m) (out[m[1]] ??= []).push(m[2]);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

const span = ([a, b], prefix = '') => (a === b ? `${prefix}${a}` : `${prefix}${a}–${prefix}${b}`);

export function renderBrief(d) {
  const lines = [];
  const add = (...l) => lines.push(...l);
  const sectionRuns = runs(d.sections.map((s) => s.n));
  const migrationCount = Object.values(d.migrations).reduce((n, l) => n + l.length, 0);

  add(`# 主机升级简报：${d.from} → ${d.to}`, '');
  add(
    `> 由 \`scripts/host-upgrade-brief.mjs\` 生成，数字都从两个 tag 算出，不要手改。执行规则见 \`docs/runbooks/host-upgrade-session.md\`；`,
    `> 具体步骤以 \`${d.to}\` tag 上的 \`${RELEASE_MD}\` 为准，本简报只说读哪些节。`,
    '',
  );
  for (const w of d.warnings) add(`> **注意**：${w}`, '');

  add('## 1. 起点与目标', '');
  add(`- 起点 \`${d.from}\`（${d.fromCommit.slice(0, 7)}）：执行会话第一步用 \`git describe --tags --exact-match\` 核对，不一致就停。`);
  add(`- 目标 \`${d.to}\`（${d.toCommit.slice(0, 7)}）。`);
  add(`- 途经 ${d.releases.length} 个版本：${d.releases.map((r) => `${r.name}（${r.date}）`).join('、')}。`, '');

  add('## 2. 迁移', '');
  if (migrationCount === 0) add('- 没有新迁移。');
  else {
    add(`- 共 **${migrationCount} 个**新迁移，\`schema_migrations\` 的行数升级后应增加 ${migrationCount}（以实际差值为准）：`);
    for (const [dir, list] of Object.entries(d.migrations).sort()) {
      add(`  - ${dir}：${runs(list.map(Number)).map((r) => span(r.map((n) => String(n).padStart(4, '0')))).join('、')}（${list.length} 个）`);
    }
  }
  add(`- \`docker-compose.yml\`：${d.composeChanged ? '**有改动**，窗口前先看 diff' : '没有改动'}；\`.env.example\`：${d.envChanged ? '**有改动**，对照主机的 .env' : '没有改动'}。`);
  add(`- \`scripts/apply-release.sh\`：${d.applyChanged ? '**有改动**，窗口内的步骤可能不同，用目标 tag 的这份跑' : '没有改动'}；\`deploy/\`：${d.deployChanged > 0 ? `${d.deployChanged} 个文件有改动（\`git diff --stat ${d.from} ${d.to} -- deploy\`）` : '没有改动'}。`, '');

  add(`## 3. 要读的 ${RELEASE_MD} 小节`, '');
  if (d.sections.length === 0) add(`- ${d.to} 相对 ${d.from} 没有新增的 §3 小节。`);
  else {
    add(`- 共 ${d.sections.length} 节：${sectionRuns.map((r) => span(r, '§3.')).join('、')}。`);
    for (let i = 1; i < sectionRuns.length; i++) {
      add(`- 编号从 §3.${sectionRuns[i - 1][1]} 直接到 §3.${sectionRuns[i][0]}，中间没有小节，不是漏读。`);
    }
    const sorted = sortSections(d.sections);
    const names = (list) => list.map((s) => `  - §3.${s.n} ${s.title}`);
    const refs = (list) => runs(list.map((s) => s.n)).map((r) => span(r, '§3.')).join('、');
    if (sorted.none.length > 0) add(`- ${sorted.none.length} 节写明**没有主机步骤**：${refs(sorted.none)}。`);
    for (const [when, list] of Object.entries(sorted.steps)) {
      if (list.length > 0) add(`- **${when}**要做的 ${list.length} 节：`, ...names(list));
    }
    if (sorted.maintainer.length > 0) {
      add(`- 其中 ${sorted.maintainer.length} 节要**维护者本人**在场或决定，下发前先告诉他：${refs(sorted.maintainer)}。`);
    }
    if (sorted.untagged.length > 0) {
      add(
        `- ${sorted.untagged.length} 节是加主机步骤行之前写的（${refs(sorted.untagged)}），没有分类，要通读。按关键词粗筛，其中 ${sorted.screened.length} 节提到维护者或控制台操作（可能漏，也可能多）：`,
        ...names(sorted.screened),
      );
      if (sorted.prechecks.length > 0) {
        add(`- 同样按关键词粗筛，其中 ${sorted.prechecks.length} 节提到升级前、预检、主机动作或 psql，多半有窗口前的只读核对：${refs(sorted.prechecks)}。`);
      }
    }
  }
  add('');

  add('## 4. staging 演练（主机升级前必须是这条路径的绿演练）', '');
  if (d.staging) {
    add(`- run ${d.staging.id}（${d.staging.title}）：**${d.staging.ok ? '绿' : `不能用：${d.staging.problem}`}**，${d.staging.url}`);
  } else {
    add('- 还没有指定演练。dispatch（不带真实模型）：', '');
    add('  ```');
    add(
      `  gh api -X POST repos/${d.slug}/actions/workflows/staging.yml/dispatches -f ref=main \\`,
      `    -f 'inputs[from]=${d.from}' -f 'inputs[to]=${d.to}' -F 'inputs[seed]=true' -F 'inputs[rollback_drill]=true' -F 'inputs[real_model]=false'`,
    );
    add('  ```', '', '  跑绿后用 `--staging-run <id>` 重新生成本简报。');
  }
  add('');

  add('## 5. 合并线程补充的要点', '', '<!-- 需要判断的内容写在这里：哪几节会挡住升级、staging 没覆盖而要在主机上看的项、这次窗口特有的事。 -->', '');
  return lines.join('\n');
}

function fail(message) {
  console.error(`host-upgrade-brief: ${message}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const [from, to] = [value('--from'), value('--to')];
  if (!from || !to) {
    console.error('usage: host-upgrade-brief.mjs --from <tag> --to <tag> [--staging-run <id>] [--force]');
    process.exit(2);
  }
  if (compareVersions(from, to) >= 0) fail(`--from ${from} must be older than --to ${to}`);
  const commit = (tag) => git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`])?.trim();
  const [fromCommit, toCommit] = [commit(from), commit(to)];
  if (!fromCommit || !toCommit) fail(`tag ${fromCommit ? to : from} is not in this checkout: git fetch origin --tags`);

  const show = (tag, file) => git(['show', `${tag}:${file}`]);
  const [fromMd, toMd] = [show(from, RELEASE_MD), show(to, RELEASE_MD)];
  const diff = git(['diff', '--name-status', from, to, '--', MIGRATIONS, ...WINDOW_PATHS]);
  if (fromMd === undefined || toMd === undefined || diff === undefined) {
    fail(`cannot read the trees of ${from} and ${to} (shallow clone?): git fetch --depth 1 origin tag ${from} tag ${to}`);
  }

  const warnings = [];
  const host = readLoopState().host.version;
  if (host !== from) {
    const message = `docs/state/loop.json 记录的主机版本是 ${host}，不是 ${from}`;
    if (!args.includes('--force')) fail(`${message}. Pass the host's real version as --from, or --force for a what-if.`);
    warnings.push(`${message}；这份简报只能当演算，不能下发。`);
  }

  const tagLines = git(['for-each-ref', '--format=%(refname:short) %(creatordate:short)', 'refs/tags/v*']) ?? '';
  const releases = tagLines
    .split('\n')
    .filter((l) => /^v\d+\.\d+\.\d+ /.test(l))
    .map((l) => ({ name: l.split(' ')[0], date: l.split(' ')[1] }))
    .filter((t) => compareVersions(t.name, from) > 0 && compareVersions(t.name, to) <= 0)
    .sort((a, b) => compareVersions(a.name, b.name));

  const slug = repoSlug();
  let staging;
  const runId = value('--staging-run');
  if (runId) {
    const run = JSON.parse(execFileSync('gh', ['api', `repos/${slug}/actions/runs/${runId}`], { encoding: 'utf8' }));
    const title = run.display_title ?? run.name ?? '';
    const problem =
      run.conclusion !== 'success'
        ? `结论是 ${run.conclusion ?? run.status}`
        : title.startsWith(`staging ${from} -> ${to}`)
          ? undefined
          : `它演练的是「${title}」，不是 ${from} -> ${to}`;
    staging = { id: runId, title, url: run.html_url, ok: problem === undefined, problem };
  }

  console.log(
    renderBrief({
      from,
      to,
      fromCommit,
      toCommit,
      releases,
      migrations: migrationsAdded(diff),
      composeChanged: /\tdocker-compose\.yml$/m.test(diff),
      envChanged: /\t\.env\.example$/m.test(diff),
      applyChanged: /\tscripts\/apply-release\.sh$/m.test(diff),
      deployChanged: diff.split('\n').filter((l) => /\tdeploy\//.test(l)).length,
      sections: newSections(fromMd, toMd),
      staging,
      slug,
      warnings,
    }),
  );
  if (staging && !staging.ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
