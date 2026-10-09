#!/usr/bin/env node
// scripts/guards/image-mirrors.mjs — every third-party image the repository pulls comes from its
// GHCR copy, by the digest deploy/image-mirrors.json lists (.github/workflows/image-mirror.yml makes
// the copies). Two rules, over the Dockerfiles, docker-compose.yml and deploy/**/*.yml, the
// workflows and the shell scripts:
//
//   1. A reference to a copy (`<registry>/<prefix><name>`) names a listed image and carries exactly
//      the listed digest — a pin move that misses a reference fails here, not as an old image in CI
//      or on a host.
//   2. No image reference resolves to Docker Hub (no registry host, or `docker.io/`): Docker Hub
//      limits anonymous pulls per address, which failed required checks on GitHub's runners
//      (2026-10-09) and would fail a release or a staging rehearsal the same way. Checked where an
//      image is pulled: a Dockerfile's `# syntax=` and `FROM`, a compose service's `image:`, a
//      workflow job's service / container image and setup-buildx `driver-opts` / build-push
//      `sbom` / `attests` generator, and the image argument of `docker run|create|pull` in shell
//      scripts and workflow `run:` steps. Local names (`nexttime-ai-*`, which compose builds or
//      scripts/pull-images.sh retags), build stages, `scratch` and `$variables` are not pulls.
//
// To move a pin: change the entry in deploy/image-mirrors.json and every reference this guard
// lists in the same PR (image-mirror.yml's header says how to order the pushes).
//
// Run: `node scripts/guards/image-mirrors.mjs` (also part of `pnpm ci:guards`).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** The list, validated: { registry, prefix, images: Map<name, entry> }. */
export function loadMirrors(json) {
  const data = JSON.parse(json);
  if (!/^ghcr\.io\/[a-z0-9-]+$/.test(data.registry ?? ''))
    throw new Error('image-mirrors.json: bad registry');
  if (!/^[a-z0-9-]+-$/.test(data.prefix ?? '')) throw new Error('image-mirrors.json: bad prefix');
  const images = new Map();
  for (const e of data.images ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(e.name ?? ''))
      throw new Error(`image-mirrors.json: bad name ${e.name}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(e.digest ?? ''))
      throw new Error(`image-mirrors.json: ${e.name}: bad digest`);
    if (images.has(e.name)) throw new Error(`image-mirrors.json: ${e.name} listed twice`);
    images.set(e.name, e);
  }
  return { registry: data.registry, prefix: data.prefix, images };
}

/** True when `ref` would be pulled from Docker Hub. */
export function isDockerHub(ref) {
  const first = ref.split('/')[0];
  if (ref.split('/').length === 1) return true; // `alpine`, `node:24`
  if (first === 'docker.io' || first === 'index.docker.io' || first === 'registry-1.docker.io')
    return true;
  return !(first.includes('.') || first.includes(':') || first === 'localhost');
}

/** A reference that is not a pull: a variable, a local name, `scratch`. */
function notAPull(ref) {
  return (
    ref === '' ||
    ref.includes('$') ||
    ref === 'scratch' ||
    /^nexttime-ai-[\w.-]+(:[\w.-]+)?$/.test(ref)
  );
}

/** Image references a Dockerfile pulls: the `# syntax=` frontend and every `FROM` not naming a stage. */
export function dockerfileRefs(text) {
  const out = [];
  const stages = new Set();
  const lines = text.split('\n');
  const syntax = /^#\s*syntax\s*=\s*(\S+)/.exec(lines[0] ?? '');
  if (syntax) out.push({ line: 1, ref: syntax[1], where: '# syntax=' });
  lines.forEach((l, i) => {
    const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
    if (!m) return;
    if (!stages.has(m[1].toLowerCase())) out.push({ line: i + 1, ref: m[1], where: 'FROM' });
    if (m[2]) stages.add(m[2].toLowerCase());
  });
  return out;
}

const VALUE_OPTIONS = new Set([
  '--name',
  '--network',
  '--net',
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '--entrypoint',
  '--runtime',
  '-u',
  '--user',
  '-w',
  '--workdir',
  '--platform',
  '--mount',
  '-l',
  '--label',
  '--add-host',
  '--cap-add',
  '--cap-drop',
  '--security-opt',
  '--tmpfs',
  '--cpus',
  '-m',
  '--memory',
  '-h',
  '--hostname',
  '--ulimit',
  '--log-driver',
  '--log-opt',
  '--restart',
  '--pid',
  '--ipc',
  '--dns',
  '--group-add',
  '--pull',
  '--stop-timeout',
  '--health-cmd',
  '--device',
]);

/** Image arguments of `docker run|create|pull` in shell text (continuations joined, comments skipped). */
export function shellRefs(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let cmd = lines[i];
    while (/\\\s*$/.test(cmd) && i + 1 < lines.length)
      cmd = cmd.replace(/\\\s*$/, ' ') + lines[++i];
    if (/^\s*#/.test(cmd)) continue;
    // An image kept in a variable (`IMAGE=…`, `COSIGN_IMAGE=${COSIGN_IMAGE:-…}`): its literal value.
    const v =
      /^\s*(?:export\s+)?[A-Z0-9_]*IMAGE[A-Z0-9_]*=["']?(?:\$\{[A-Z0-9_]+:-)?([^"'\s}]+)/.exec(cmd);
    if (v) out.push({ line: start + 1, ref: v[1], where: 'image variable' });
    for (const m of cmd.matchAll(
      /(?:^|[\s;&|(`$])docker\s+(?:container\s+|image\s+)?(run|create|pull)\s+([^;&|)`<>]*)/g,
    )) {
      const tokens = m[2]
        .trim()
        .split(/\s+/)
        .map((t) => t.replace(/^["']|["']$/g, ''));
      for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (tok.startsWith('-')) {
          if (!tok.includes('=') && VALUE_OPTIONS.has(tok)) t++;
          continue;
        }
        out.push({ line: start + 1, ref: tok, where: `docker ${m[1]}` });
        break;
      }
    }
  }
  return out;
}

/** Image references a compose file pulls: each service's `image:` (a service with `build:` builds it). */
export function composeRefs(text) {
  const doc = parse(text) ?? {};
  return Object.entries(doc.services ?? {})
    .filter(([, s]) => s && typeof s.image === 'string' && !s.build)
    .map(([name, s]) => ({ ref: s.image, where: `services.${name}.image` }));
}

/** Image references a workflow pulls: job services / container, buildx image options, `run:` steps. */
export function workflowRefs(text) {
  const doc = parse(text) ?? {};
  const out = [];
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    for (const [svc, s] of Object.entries(job?.services ?? {})) {
      if (typeof s?.image === 'string')
        out.push({ ref: s.image, where: `jobs.${jobName}.services.${svc}.image` });
    }
    const container = typeof job?.container === 'string' ? job.container : job?.container?.image;
    if (typeof container === 'string')
      out.push({ ref: container, where: `jobs.${jobName}.container` });
    for (const step of job?.steps ?? []) {
      const w = step?.with ?? {};
      const uses = String(step?.uses ?? '');
      // Implicit pulls: setup-buildx's docker-container builder starts moby/buildkit unless
      // `driver-opts: image=…` names one; build-push's SBOM runs docker/buildkit-syft-scanner
      // unless a `generator=` is given.
      if (
        uses.startsWith('docker/setup-buildx-action') &&
        w.driver !== 'docker' &&
        !/(?:^|[\s,])image=/.test(String(w['driver-opts'] ?? ''))
      ) {
        out.push({
          ref: 'moby/buildkit',
          where: `jobs.${jobName} setup-buildx (no driver-opts image=)`,
        });
      }
      if (uses.startsWith('docker/build-push-action')) {
        const sbom = String(w.sbom ?? '');
        const attests = String(w.attests ?? '');
        if (
          (sbom !== '' && sbom !== 'false' && !sbom.includes('generator=')) ||
          (/type=sbom/.test(attests) && !/generator=/.test(attests))
        ) {
          out.push({
            ref: 'docker/buildkit-syft-scanner',
            where: `jobs.${jobName} build-push sbom (no generator=)`,
          });
        }
      }
      for (const key of ['driver-opts', 'sbom', 'attests']) {
        for (const m of String(w[key] ?? '').matchAll(
          /(?:^|[\s,])(?:image|generator)=([^\s,"]+)/g,
        )) {
          out.push({ ref: m[1], where: `jobs.${jobName} ${step.name ?? step.uses} with.${key}` });
        }
      }
      if (typeof step?.run === 'string') {
        for (const r of shellRefs(step.run))
          out.push({ ...r, where: `jobs.${jobName} "${step.name ?? 'run'}" ${r.where}` });
      }
    }
  }
  return out;
}

/** Copy references (`<registry>/<prefix><name>…`) on non-comment lines, with or without a digest. */
export function mirrorRefs(text, mirrors) {
  const base = `${mirrors.registry}/${mirrors.prefix}`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(`${base}([a-z0-9-]+)(@sha256:[0-9a-f]{64}|:[\\w.-]+)?`, 'g');
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*#(?!\s*syntax\s*=)/.test(l)) return;
    for (const m of l.matchAll(re)) out.push({ line: i + 1, name: m[1], pin: m[2] ?? '' });
  });
  return out;
}

/** Problems in one file: [{ file, line?, msg }]. `kind`: dockerfile | compose | workflow | shell. */
export function checkFile(file, kind, text, mirrors) {
  const problems = [];
  for (const r of mirrorRefs(text, mirrors)) {
    const entry = mirrors.images.get(r.name);
    if (!entry)
      problems.push({
        file,
        line: r.line,
        msg: `${mirrors.prefix}${r.name} is not in deploy/image-mirrors.json`,
      });
    else if (r.pin !== `@${entry.digest}`) {
      const what = r.pin.startsWith('@') ? r.pin : `${r.pin} (no digest)`;
      problems.push({
        file,
        line: r.line,
        msg: `${mirrors.prefix}${r.name}${what} — the list pins ${entry.digest}`,
      });
    }
  }
  const refs =
    kind === 'dockerfile'
      ? dockerfileRefs(text)
      : kind === 'compose'
        ? composeRefs(text)
        : kind === 'workflow'
          ? workflowRefs(text)
          : shellRefs(text);
  for (const r of refs) {
    if (notAPull(r.ref) || !isDockerHub(r.ref)) continue;
    problems.push({
      file,
      line: r.line,
      msg: `${r.where} pulls ${r.ref} from Docker Hub — add it to deploy/image-mirrors.json and use the GHCR copy by digest`,
    });
  }
  return problems;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
]);

function walk(dir, pick) {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(rel, pick);
    return pick(rel, e.name) ? [rel] : [];
  });
}

/** Every file in scope with its kind. */
export function scope() {
  const files = [];
  for (const f of walk('.', (_, n) => n === 'Dockerfile' || n.endsWith('.Dockerfile')))
    files.push([f, 'dockerfile']);
  files.push(['docker-compose.yml', 'compose']);
  for (const f of walk('deploy', (_, n) => /\.ya?ml$/.test(n))) files.push([f, 'compose']);
  for (const f of walk('.github/workflows', (_, n) => /\.ya?ml$/.test(n)))
    files.push([f, 'workflow']);
  for (const f of [
    ...walk('scripts', (_, n) => n.endsWith('.sh')),
    ...walk('deploy', (_, n) => n.endsWith('.sh')),
  ]) {
    files.push([f, 'shell']);
  }
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mirrors = loadMirrors(read('deploy/image-mirrors.json'));
  const problems = scope().flatMap(([f, kind]) => checkFile(f, kind, read(f), mirrors));
  if (problems.length > 0) {
    for (const p of problems) console.error(`${p.file}${p.line ? `:${p.line}` : ''}: ${p.msg}`);
    console.error(`image-mirrors: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(
    `image-mirrors: ok (${mirrors.images.size} mirrored images, ${scope().length} files)`,
  );
}
