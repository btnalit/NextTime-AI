#!/usr/bin/env node
// scripts/image-pins.mjs — the weekly check behind .github/workflows/image-pins.yml (STATUS 遗留 181).
//
// deploy/image-mirrors.json pins every third-party image by digest (#531), so nothing the repository
// pulls moves under it — and nothing picks up the upstream's security rebuilds either: a floating tag
// such as `postgres:17-alpine` gets a new digest whenever upstream rebuilds it, and the pin stays on
// the old one. This script makes that drift visible; it never moves a pin. Moving one stays a
// reviewed PR (image-mirror.yml's header says how), and routine bumps are never handed to a bot
// (2026-09-25 / 2026-10-02 decisions; no Dependabot or Renovate).
//
// Three steps, each a subcommand, so the workflow stays a list of calls:
//
//   resolve --out status.json     For every entry, ask the upstream registry (the entry's `upstream`,
//                                 Docker Hub when it names no host) which digest the tag points at
//                                 now. A manifest HEAD: Docker Hub does not count HEAD requests
//                                 against its anonymous pull limit, but it does throttle them (429),
//                                 so lookups run one at a time, 1.5 s apart, and a 429 / 5xx /
//                                 network error is retried after Retry-After or 10, 30, 60 s. Error
//                                 text in the report is this script's own (status codes, names), one
//                                 line, truncated; no upstream response content. An entry is `current`, `behind`
//                                 (the tag moved) or `error` (lookup failed, or the entry's `tag`
//                                 disagrees with its `upstream`).
//   scan --status status.json --dir scans
//                                 Trivy (HIGH / CRITICAL, OS + library packages, linux/amd64) on the
//                                 pinned digest (its GHCR copy, else the entry's `source` by the same
//                                 digest) and, for an entry that is behind,
//                                 on the upstream's current digest (from the entry's `source`, else
//                                 the upstream repository). A scan that fails is reported, not fatal:
//                                 the digest comparison is the check, Trivy is the overlay that says
//                                 what moving the pin fixes.
//   report --status status.json --dir scans --out report.md
//                                 The issue body / step summary, plus `behind`, `errors` and
//                                 `scan_failures` in $GITHUB_OUTPUT when set.
//
// Exit codes: 0 when the subcommand ran (being behind is a finding, not a failure); 1 on bad input or
// usage. The workflow fails the run on lookup errors itself, after the report is written.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** A lookup failure whose message this script wrote (status codes, names); safe to show as is. */
class LookupError extends Error {}
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** The list, validated the same way scripts/guards/image-mirrors.mjs does, plus the fields used here. */
export function loadPins(json) {
  const data = JSON.parse(json);
  if (!/^ghcr\.io\/[a-z0-9-]+$/.test(data.registry ?? ''))
    throw new Error('image-mirrors.json: bad registry');
  if (!/^[a-z0-9-]+-$/.test(data.prefix ?? '')) throw new Error('image-mirrors.json: bad prefix');
  const seen = new Set();
  const images = (data.images ?? []).map((e) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(e.name ?? ''))
      throw new Error(`image-mirrors.json: bad name ${e.name}`);
    if (seen.has(e.name)) throw new Error(`image-mirrors.json: ${e.name} listed twice`);
    seen.add(e.name);
    if (!DIGEST_RE.test(e.digest ?? ''))
      throw new Error(`image-mirrors.json: ${e.name}: bad digest`);
    if (!/^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/.test(e.source ?? ''))
      throw new Error(`image-mirrors.json: ${e.name}: bad source`);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(e.tag ?? ''))
      throw new Error(`image-mirrors.json: ${e.name}: bad tag`);
    if (typeof e.upstream !== 'string' || e.upstream === '')
      throw new Error(`image-mirrors.json: ${e.name}: no upstream`);
    return e;
  });
  return { registry: data.registry, prefix: data.prefix, images };
}

/**
 * `node:24`, `pgvector/pgvector:pg17`, `quay.io/x/y:1` → { host, repo, tag, display }. `host` is the
 * registry API host (Docker Hub's is registry-1.docker.io); `display` is the pullable repository.
 */
export function parseUpstream(ref) {
  const m = /^([^@\s]+):([A-Za-z0-9_][A-Za-z0-9_.-]*)$/.exec(ref);
  if (!m || m[1].endsWith('/'))
    throw new LookupError(`upstream ${ref}: expected <repository>:<tag>`);
  const parts = m[1].split('/');
  const first = parts[0];
  const hasHost =
    parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (hasHost && !['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(first)) {
    const repo = parts.slice(1).join('/');
    return { host: first, repo, tag: m[2], display: `${first}/${repo}` };
  }
  const rest = hasHost ? parts.slice(1) : parts;
  const repo = rest.length === 1 ? `library/${rest[0]}` : rest.join('/');
  return { host: 'registry-1.docker.io', repo, tag: m[2], display: `docker.io/${repo}` };
}

/** `Bearer realm="…",service="…",scope="…"` → { realm, service, scope }; null if not Bearer. */
export function parseBearerChallenge(header) {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const out = {};
  for (const m of header.slice(7).matchAll(/([a-zA-Z]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out.realm ? out : null;
}

const RETRY_DELAYS_S = [10, 30, 60];
const MAX_RETRY_AFTER_S = 120;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seconds a `Retry-After` header asks for (delta-seconds or HTTP date), capped; null if absent or bad. */
export function retryAfterSeconds(value, now = Date.now()) {
  if (!value) return null;
  const v = value.trim();
  const secs = /^\d+$/.test(v) ? Number(v) : (Date.parse(v) - now) / 1000;
  if (!Number.isFinite(secs)) return null;
  return Math.min(Math.max(0, Math.ceil(secs)), MAX_RETRY_AFTER_S);
}

/**
 * fetch with backoff on 429, 5xx and network errors: wait `Retry-After` when given, else 10, 30,
 * then 60 seconds; the fourth failure is returned (a response) or thrown (a network error). Docker
 * Hub answered 429 to manifest HEADs in review (#585), so one throttled answer must not count as a
 * failed lookup.
 */
export async function fetchWithRetry(fetchImpl, url, init, sleep = defaultSleep) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === RETRY_DELAYS_S.length;
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (last) throw err;
      await sleep(RETRY_DELAYS_S[attempt] * 1000);
      continue;
    }
    if ((res.status !== 429 && res.status < 500) || last) return res;
    const after = retryAfterSeconds(res.headers.get('retry-after'));
    await sleep((after ?? RETRY_DELAYS_S[attempt]) * 1000);
  }
}

/**
 * The digest `host/repo:tag` points at now, by manifest HEAD with an anonymous token when the
 * registry asks for one. Throws a LookupError with a short reason otherwise; no response body is
 * ever read into a message.
 */
export async function resolveDigest({ host, repo, tag }, fetchImpl = fetch, sleep = defaultSleep) {
  const url = `https://${host}/v2/${repo}/manifests/${tag}`;
  const head = (token) =>
    fetchWithRetry(
      fetchImpl,
      url,
      {
        method: 'HEAD',
        headers: token
          ? { accept: MANIFEST_ACCEPT, authorization: `Bearer ${token}` }
          : { accept: MANIFEST_ACCEPT },
      },
      sleep,
    );
  let res = await head();
  if (res.status === 401) {
    const ch = parseBearerChallenge(res.headers.get('www-authenticate'));
    if (!ch) throw new LookupError(`${host}: 401 without a Bearer challenge`);
    let tokenUrl;
    try {
      tokenUrl = new URL(ch.realm);
    } catch {
      throw new LookupError(`${host}: Bearer challenge with an invalid realm`);
    }
    if (ch.service) tokenUrl.searchParams.set('service', ch.service);
    tokenUrl.searchParams.set('scope', ch.scope ?? `repository:${repo}:pull`);
    const tr = await fetchWithRetry(fetchImpl, tokenUrl, {}, sleep);
    if (!tr.ok) throw new LookupError(`${host}: token request HTTP ${tr.status}`);
    let body;
    try {
      body = await tr.json();
    } catch {
      throw new LookupError(`${host}: token response is not JSON`);
    }
    const token = body?.token ?? body?.access_token;
    if (typeof token !== 'string' || token === '')
      throw new LookupError(`${host}: token response without a token`);
    res = await head(token);
  }
  if (res.status !== 200)
    throw new LookupError(`${host}/${repo}:${tag}: manifest HEAD HTTP ${res.status}`);
  const digest = res.headers.get('docker-content-digest') ?? '';
  if (!DIGEST_RE.test(digest))
    throw new LookupError(`${host}/${repo}:${tag}: no Docker-Content-Digest header`);
  return digest;
}

/**
 * A lookup error as it may appear in the issue: this script's own messages kept, anything else
 * (a network error, whose text can carry upstream content) reduced to its kind and code; then one
 * line, no Markdown table or code delimiters, at most 160 characters.
 */
export function safeError(err) {
  let msg;
  if (err instanceof LookupError) msg = err.message;
  else {
    const code = err?.cause?.code ?? err?.code;
    const kind = err?.name === 'TimeoutError' ? 'timeout' : 'network error';
    msg = typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? `${kind} (${code})` : kind;
  }
  return oneLine(msg);
}

/** One line, no Markdown table or code delimiters, at most 160 characters. */
export function oneLine(text) {
  const t = String(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|`<>]/g, '');
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

/**
 * One status row per entry. `lookup(entry)` returns the current digest or throws. Lookups run one
 * after another, `paceMs` apart, so a run never bursts the upstream registry.
 */
export async function resolveAll(pins, lookup, { sleep = defaultSleep, paceMs = 1500 } = {}) {
  const rows = [];
  for (const [i, e] of pins.images.entries()) {
    if (i > 0 && paceMs > 0) await sleep(paceMs);
    const row = {
      name: e.name,
      upstream: e.upstream,
      tag: e.tag,
      source: e.source,
      pinned: e.digest,
      // The GHCR copy first (what consumers pull), then the copy's source by the same digest.
      pinnedRefs: [
        `${pins.registry}/${pins.prefix}${e.name}@${e.digest}`,
        `${e.source}@${e.digest}`,
      ],
      current: null,
      status: 'error',
      error: null,
      currentRefs: [],
    };
    try {
      const up = parseUpstream(e.upstream);
      if (up.tag !== e.tag)
        throw new LookupError(`upstream tag ${up.tag} is not the entry's tag ${e.tag}`);
      row.current = await lookup(up);
      row.status = row.current === e.digest ? 'current' : 'behind';
      if (row.status === 'behind') {
        row.currentRefs = [`${e.source}@${row.current}`, `${up.display}@${row.current}`].filter(
          (r, i, a) => a.indexOf(r) === i,
        );
      }
    } catch (err) {
      row.error = safeError(err);
    }
    rows.push(row);
  }
  return rows;
}

/** HIGH / CRITICAL findings of one Trivy JSON report, keyed `<id> <package>`. */
export function summarizeTrivy(report) {
  const vulns = new Map();
  for (const r of report?.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      if (v.Severity !== 'HIGH' && v.Severity !== 'CRITICAL') continue;
      const key = `${v.VulnerabilityID} ${v.PkgName}`;
      if (!vulns.has(key))
        vulns.set(key, { severity: v.Severity, fixable: Boolean(v.FixedVersion) });
    }
  }
  let high = 0;
  let critical = 0;
  let fixable = 0;
  for (const v of vulns.values()) {
    if (v.severity === 'CRITICAL') critical++;
    else high++;
    if (v.fixable) fixable++;
  }
  return { high, critical, fixable, keys: new Set(vulns.keys()) };
}

/** Vulnerabilities the pinned digest has and the current one does not: what moving the pin fixes. */
export function fixedByMoving(pinned, current) {
  if (!pinned || !current) return null;
  return [...pinned.keys].filter((k) => !current.keys.has(k)).length;
}

const short = (d) => (d ? d.slice(7, 19) : '—');
const counts = (s) => (s ? `${s.critical} / ${s.high} (${s.fixable} fixable)` : 'not scanned');

/**
 * Markdown for the issue body and the step summary. `scans[name] = { pinned, current }` holds
 * summarizeTrivy() results (or null for a failed scan); `refs[name]` the file:line references of
 * that entry's GHCR copy; `runUrl` links the run.
 */
export function renderReport(rows, scans, refs, runUrl) {
  const behind = rows.filter((r) => r.status === 'behind');
  const errors = rows.filter((r) => r.status === 'error');
  const out = [];
  out.push(
    behind.length > 0
      ? `**${behind.length} of ${rows.length} pinned third-party images are behind their upstream tag.**`
      : `All ${rows.length - errors.length} resolved pins match their upstream tag.`,
  );
  if (errors.length > 0) out.push('', `**${errors.length} lookup(s) failed** — see the table.`);
  out.push(
    '',
    'Pins live in `deploy/image-mirrors.json`. Trivy counts are HIGH/CRITICAL, OS + library packages, linux/amd64; ' +
      '"fixed by moving" counts the findings in the pinned digest that the upstream digest no longer has. ' +
      'A version-pinned tag (`curl:8.22.0`, `buildkit:v0.33.1`, …) only moves when upstream rebuilds it; ' +
      'a newer version is a version bump, which this check does not propose.',
    '',
    '| image | upstream | state | pinned | upstream now | pinned C / H | upstream C / H | fixed by moving |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const s = scans[r.name] ?? {};
    const state = r.status === 'error' ? `error: ${oneLine(r.error ?? '')}` : r.status;
    const fixed = r.status === 'behind' ? (fixedByMoving(s.pinned, s.current) ?? '—') : '';
    out.push(
      `| ${r.name} | \`${r.upstream}\` | ${state} | \`${short(r.pinned)}\` | \`${short(r.current)}\` | ` +
        `${counts(s.pinned)} | ${r.status === 'behind' ? counts(s.current) : ''} | ${fixed} |`,
    );
  }
  if (behind.length > 0) {
    out.push(
      '',
      '## Moving a pin',
      '',
      'One PR per batch, reviewed like any other change (`image-mirror.yml` header): first push the new',
      "`digest` in `deploy/image-mirrors.json` — that PR's `image-mirror` run copies it to GHCR — then, once",
      'the copy exists, the references below. `scripts/guards/image-mirrors.mjs` (in `quality`) names any',
      'reference still on the old digest. If the copy fails because the source cache lacks the digest, set',
      "the entry's `source` to the upstream repository for that change.",
    );
    for (const r of behind) {
      out.push(
        '',
        `### ${r.name} (\`${r.upstream}\`)`,
        '',
        `- pinned: \`${r.pinned}\``,
        `- upstream now: \`${r.current}\``,
      );
      const list = refs[r.name] ?? [];
      if (list.length > 0)
        out.push(`- references (${list.length}): ${list.map((f) => `\`${f}\``).join(', ')}`);
    }
  }
  if (runUrl) out.push('', `Run: ${runUrl}`);
  out.push(
    '',
    'This issue is opened and updated in place by the weekly `image-pins` workflow, and closed by it once every pin matches its upstream tag.',
  );
  return `${out.join('\n')}\n`;
}

/** file:line of every reference to an entry's GHCR copy by digest, from the tracked files. */
export function copyReferences(pins, name) {
  const needle = `${pins.registry}/${pins.prefix}${name}@`;
  const res = spawnSync('git', ['grep', '-n', '-F', '-e', needle], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(':').slice(0, 2).join(':'));
}

function runTrivy(ref, out) {
  const res = spawnSync(
    'trivy',
    [
      'image',
      '--quiet',
      '--image-src',
      'remote',
      '--platform',
      'linux/amd64',
      '--scanners',
      'vuln',
      '--pkg-types',
      'os,library',
      '--severity',
      'HIGH,CRITICAL',
      '--timeout',
      '10m',
      '--format',
      'json',
      '--output',
      out,
      ref,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
  );
  return res.status === 0;
}

function arg(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[i + 1];
}

function readScan(dir, file) {
  const p = path.join(dir, file);
  if (!existsSync(p)) return null;
  try {
    return summarizeTrivy(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

async function main(argv) {
  const [cmd, ...args] = argv;
  const pins = loadPins(readFileSync(path.join(ROOT, 'deploy/image-mirrors.json'), 'utf8'));
  if (cmd === 'resolve') {
    const rows = await resolveAll(pins, (up) => resolveDigest(up));
    writeFileSync(arg(args, '--out'), `${JSON.stringify(rows, null, 2)}\n`);
    for (const r of rows)
      console.log(
        `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ''} ${short(r.pinned)} → ${short(r.current)}`,
      );
    return 0;
  }
  if (cmd === 'scan') {
    const rows = JSON.parse(readFileSync(arg(args, '--status'), 'utf8'));
    const dir = arg(args, '--dir');
    mkdirSync(dir, { recursive: true });
    for (const r of rows) {
      console.log(`::group::trivy ${r.name}`);
      const pinnedOk = r.pinnedRefs.some((ref) =>
        runTrivy(ref, path.join(dir, `${r.name}.pinned.json`)),
      );
      if (!pinnedOk) console.log(`::warning::trivy could not scan the pinned digest of ${r.name}`);
      if (r.status === 'behind') {
        const ok = r.currentRefs.some((ref) =>
          runTrivy(ref, path.join(dir, `${r.name}.current.json`)),
        );
        if (!ok) console.log(`::warning::trivy could not scan the upstream digest of ${r.name}`);
      }
      console.log('::endgroup::');
    }
    return 0;
  }
  if (cmd === 'report') {
    const rows = JSON.parse(readFileSync(arg(args, '--status'), 'utf8'));
    const dir = arg(args, '--dir');
    const scans = {};
    const refs = {};
    let scanFailures = 0;
    for (const r of rows) {
      const s = { pinned: readScan(dir, `${r.name}.pinned.json`), current: null };
      if (!s.pinned) scanFailures++;
      if (r.status === 'behind') {
        s.current = readScan(dir, `${r.name}.current.json`);
        if (!s.current) scanFailures++;
        refs[r.name] = copyReferences(pins, r.name);
      }
      scans[r.name] = s;
    }
    const runUrl = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';
    writeFileSync(arg(args, '--out'), renderReport(rows, scans, refs, runUrl));
    const behind = rows.filter((r) => r.status === 'behind').length;
    const errors = rows.filter((r) => r.status === 'error').length;
    console.log(
      `image-pins: ${behind} behind, ${errors} lookup errors, ${scanFailures} scan failures`,
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `behind=${behind}\nerrors=${errors}\nscan_failures=${scanFailures}\n`,
      );
    return 0;
  }
  console.error(
    'usage: image-pins.mjs resolve --out F | scan --status F --dir D | report --status F --dir D --out F',
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`image-pins: ${err?.message ?? err}`);
      process.exit(1);
    },
  );
}
