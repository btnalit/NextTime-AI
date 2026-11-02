#!/usr/bin/env node
// scripts/guards/fake-markers.mjs — the CI-only chat markers stay CI-only (STATUS leftover 83;
// S11 AA4d, the AA4 plan's F9 decision: "只有 fake 运行时认这个标记。真 pi 和生产镜像都要有守卫").
//
// The kernel's `FakeAgentRuntime` (AGENT_RUNTIME=fake) turns a chat message carrying
// `__nexttime_fake_delegate__` into a scripted `invoke_worker`, and one carrying
// `__nexttime_fake_admin_propose__` in an admin agent Turn into a scripted
// `propose_admin_proposal` — both only when `main()` wired the hooks, which it does only under
// `FAKE_INVOKE_WORKER=1`. Three rules keep that from ever reaching a real deployment or a real
// agent:
//
//   1. The marker literals appear only where the fake runtime defines and tests them and in the
//      web e2e specs that send them. Nothing in the real runtime — agent-host, the worker runtime
//      image (platform-extension, entrypoint.sh), worker-supervisor, llm-proxy, gatekeepers, the
//      fake LLM the rehearsal drives real pi with — can react to them, because none of it names
//      them: to real pi a marker is text it passes to the model.
//   2. The hooks are built only by the kernel's composition root (`createFakeDelegateHandler`,
//      `createFakeAdminProposeHandler` called in packages/kernel/src/index.ts only), which builds
//      them only inside its `FAKE_INVOKE_WORKER === '1' && kind === 'fake' && handleKeyPair` block.
//   3. `FAKE_INVOKE_WORKER` gets a value only in deploy/ci/env.ci.template: docker-compose.yml
//      passes it through empty by default, and no other env file, compose file, workflow or script
//      sets it — not the release rehearsal, not the acceptance stack, not a host's `.env.example`.
//
// Run: `node scripts/guards/fake-markers.mjs` (also part of `pnpm ci:guards`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MARKERS = ['__nexttime_fake_delegate__', '__nexttime_fake_admin_propose__'];

/** Rule 1: where a marker literal may appear. */
export const MARKER_ALLOWED = [
  /^packages\/kernel\/src\/application\/host-bridge\/fake-runtime(\.test)?\.ts$/,
  /^packages\/kernel\/src\/fake-(invoke-worker|admin-propose)\.integration\.test\.ts$/,
  /^packages\/web\/e2e\/.+\.spec\.ts$/,
  /^scripts\/guards\/fake-markers(\.test)?\.mjs$/,
  /^docs\//,
];

/** Rule 2: where a fake hook may be built (its own module and tests define and call it). */
export const HOOK_BUILDERS = ['createFakeDelegateHandler', 'createFakeAdminProposeHandler'];
export const HOOK_ALLOWED = [
  /^packages\/kernel\/src\/index\.ts$/,
  /^packages\/kernel\/src\/fake-(invoke-worker|admin-propose)(\.integration\.test)?\.ts$/,
  /^scripts\/guards\/fake-markers(\.test)?\.mjs$/,
  /^docs\//,
];
/** The block of index.ts that may build them. */
export const HOOK_GATE =
  "process.env.FAKE_INVOKE_WORKER === '1' && kind === 'fake' && handleKeyPair";

/** Rule 3: the only file that gives FAKE_INVOKE_WORKER a value. */
export const FLAG_SETTER = 'deploy/ci/env.ci.template';

const matchesAny = (rel, patterns) => patterns.some((re) => re.test(rel));

/** Rule 1 over one file. */
export function markerFindings(rel, text) {
  if (matchesAny(rel, MARKER_ALLOWED)) return [];
  return MARKERS.filter((marker) => text.includes(marker)).map(
    (marker) =>
      `${rel}: names the CI-only marker ${marker} (only the fake runtime, its tests and the e2e specs may)`,
  );
}

/** Rule 2 over one file: a call `name(` outside the allowed files; in index.ts, outside the gate. */
export function hookFindings(rel, text) {
  const out = [];
  for (const name of HOOK_BUILDERS) {
    const call = new RegExp(`\\b${name}\\(`, 'g');
    const calls = [...text.matchAll(call)].filter(
      (m) => !/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index)),
    );
    if (calls.length === 0) continue;
    if (!matchesAny(rel, HOOK_ALLOWED)) {
      out.push(`${rel}: builds the CI-only hook ${name} (only the kernel's index.ts may)`);
      continue;
    }
    if (rel !== 'packages/kernel/src/index.ts') continue;
    const gate = text.indexOf(HOOK_GATE);
    if (gate < 0) {
      out.push(`${rel}: builds ${name} but the FAKE_INVOKE_WORKER gate is gone`);
      continue;
    }
    const blockEnd = closingBrace(text, text.indexOf('{', gate));
    for (const m of calls) {
      if (m.index < gate || m.index > blockEnd) {
        out.push(`${rel}: builds ${name} outside the FAKE_INVOKE_WORKER gate`);
      }
    }
  }
  return out;
}

/** The index of the `}` closing the `{` at `open` (no strings with braces in that block). */
function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length;
}

/** Rule 3 over one file: a line that gives FAKE_INVOKE_WORKER a non-empty value. Configuration
 *  and scripts only — env files, compose files, workflows, shell and Node scripts, Dockerfiles: the
 *  TypeScript sources read the flag (the kernel's index.ts) or set it inside a test process. */
export function flagFindings(rel, text) {
  if (rel === FLAG_SETTER || rel.startsWith('docs/') || /^scripts\/guards\/fake-markers/.test(rel))
    return [];
  if (/\.(tsx?|md)$/.test(rel)) return [];
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(#|\/\/|\*)/.test(line)) return;
    // KEY=value (env file, shell), KEY: value (compose), export KEY=value, -e KEY=value.
    const m = /\bFAKE_INVOKE_WORKER\s*(?:=(?!=)|:)\s*["']?([^"'\s#]*)/.exec(line);
    if (!m) return;
    // docker-compose.yml's pass-through, empty unless the env file sets it.
    if (/^\$\{FAKE_INVOKE_WORKER:-\}$/.test(m[1])) return;
    if (m[1] === '') return;
    out.push(`${rel}:${i + 1}: sets FAKE_INVOKE_WORKER (only ${FLAG_SETTER} may)`);
  });
  return out;
}

/** Tracked text files the rules read. */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !/\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|zip|gz|tgz|bundle)$/i.test(rel));
}

export function check(files, read) {
  const findings = [];
  for (const rel of files) {
    let text;
    try {
      text = read(rel);
    } catch {
      continue;
    }
    findings.push(
      ...markerFindings(rel, text),
      ...hookFindings(rel, text),
      ...flagFindings(rel, text),
    );
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = check(trackedFiles(), (rel) => readFileSync(path.join(ROOT, rel), 'utf8'));
  if (findings.length > 0) {
    console.error('fake-markers: the CI-only markers and their hooks escaped CI:');
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(
    `fake-markers: ${MARKERS.length} markers only in the fake runtime and the e2e specs; hooks only behind FAKE_INVOKE_WORKER; the flag set only in ${FLAG_SETTER}`,
  );
}
