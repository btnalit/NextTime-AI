// Tests for scripts/ci-docs-only.sh: runs the script against a stub `gh` that prints a fixed list
// of changed paths, and checks the code=true|false it writes to GITHUB_OUTPUT.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ci-docs-only.sh');
const dir = mkdtempSync(path.join(tmpdir(), 'ci-docs-only-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\n[ -n "${GH_STUB_FAIL:-}" ] && exit 1\nprintf "%s" "$GH_STUB_FILES"\n');
chmodSync(path.join(dir, 'gh'), 0o755);

function detect(files, env = {}) {
  const out = path.join(dir, 'output');
  writeFileSync(out, '');
  execFileSync('sh', [SCRIPT], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_OUTPUT: out,
      GITHUB_REPOSITORY: 'owner/repo',
      EVENT_NAME: 'pull_request',
      BASE_SHA: 'abc',
      HEAD_SHA: 'def',
      GH_STUB_FILES: files.map((f) => `${f}\n`).join(''),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return readFileSync(out, 'utf8').trim();
}

test('documentation only: docs/, top-level *.md, any README.md, .github/*.md', () => {
  assert.equal(
    detect(['docs/STATUS.md', 'docs/runbooks/release.md', 'docs/img/a.png', 'CHANGELOG.md', 'packages/web/README.md', '.github/PULL_REQUEST_TEMPLATE.md']),
    'code=false',
  );
});

test('docs/contracts/ and .md outside the documentation paths are code', () => {
  assert.equal(detect(['docs/STATUS.md', 'docs/contracts/events.json']), 'code=true');
  assert.equal(detect(['packages/x/prompt.md']), 'code=true');
  assert.equal(detect(['ontology/skills/a/SKILL.md']), 'code=true');
  assert.equal(detect(['docs/STATUS.md', 'packages/kernel/src/x.ts']), 'code=true');
});

test('fails open', () => {
  assert.equal(detect([]), 'code=true');
  assert.equal(detect(['docs/a.md'], { GH_STUB_FAIL: '1' }), 'code=true');
  assert.equal(detect(['docs/a.md'], { BASE_SHA: '0000000000000000000000000000000000000000' }), 'code=true');
  assert.equal(detect(['docs/a.md'], { EVENT_NAME: 'workflow_dispatch' }), 'code=true');
  assert.equal(detect(['docs/a.md'], { EVENT_NAME: 'push', BEFORE_SHA: '', AFTER_SHA: 'def' }), 'code=true');
  assert.equal(detect(Array.from({ length: 300 }, (_, i) => `docs/${i}.md`)), 'code=true');
});
