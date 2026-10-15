// Tests for the RESULT line of scripts/apply-release.sh: runs the real script in a scratch checkout
// with stub `docker`, `git`, `chown`, `timeout` and `sleep` on PATH, and checks which outcomes end
// "RESULT ok" and which do not — above all, that a skipped or failed raw-secret scrub is never "ok"
// (review of #555's runbook) and that the log says what to run again.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apply-release.sh');
const root = mkdtempSync(path.join(tmpdir(), 'apply-release-result-'));
after(() => rmSync(root, { recursive: true, force: true }));

const bin = path.join(root, 'bin');
const calls = path.join(root, 'calls.log');
function file(p, content, mode) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode);
}

// docker: every call is recorded; the steps under test fail on demand.
file(
  path.join(bin, 'docker'),
  `#!/bin/sh
echo "docker $*" >>"$STUB_CALLS"
case "$*" in
  *pg_dump*) echo dump ;;
  *"pg_restore --list"*) echo toc ;;
  *"migrate.js --dry-run"*) ;;
  *migrate.js*) exit "\${STUB_MIGRATE_RC:-0}" ;;
  *BACKUP_NOW=1*) exit "\${STUB_BACKUP_RC:-0}" ;;
  *compact-observations.js*) echo "compact-observations: ok deleted=0"; exit "\${STUB_COMPACTION_RC:-0}" ;;
  *scrub-raw-secrets.js*)
    echo "counted taskInputs ws-1/task-1"
    [ "\${STUB_SCRUB_RC:-0}" -eq 0 ] && echo "scrub-raw-secrets: ok rewritten=0" ||
      echo "scrub-raw-secrets: failed: synthetic failure" >&2
    exit "\${STUB_SCRUB_RC:-0}" ;;
esac
exit 0
`,
  0o755,
);
file(
  path.join(bin, 'git'),
  `#!/bin/sh
case "$1" in
  describe) echo v0.0.1 ;;
  rev-parse) echo 0123456789abcdef ;;
  symbolic-ref) echo main ;;
esac
exit 0
`,
  0o755,
);
file(path.join(bin, 'chown'), '#!/bin/sh\nexit "${STUB_CHOWN_RC:-0}"\n', 0o755);
file(path.join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', 0o755);
file(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', 0o755);

// The checkout: what apply-release.sh looks for in it, nothing more.
const repo = path.join(root, 'repo');
const data = path.join(root, 'data');
mkdirSync(data, { recursive: true });
file(path.join(repo, 'docker-compose.yml'), 'services: {}\n');
file(path.join(repo, '.env'), `NEXTTIME_DATA=${data}\n`);
file(path.join(repo, 'scripts/build-images.sh'), 'exit 0\n');
file(
  path.join(repo, 'scripts/accept_s3.sh'),
  '[ -n "${STUB_ACCEPT_FAIL:-}" ] && { echo "FAIL stub"; exit 1; }\necho "PASS stub"\n',
);
file(path.join(repo, 'packages/kernel/src/cli/compact-observations.ts'), '');
file(path.join(repo, 'packages/kernel/src/cli/scrub-raw-secrets.ts'), '');

let run = 0;
function apply(env = {}) {
  run += 1;
  const logDir = path.join(root, `logs-${run}`);
  writeFileSync(calls, '');
  const res = spawnSync('sh', [SCRIPT, 'v0.0.2'], {
    cwd: repo,
    env: { PATH: `${bin}:${process.env.PATH}`, APPLY_LOG_DIR: logDir, STUB_CALLS: calls, ...env },
    encoding: 'utf8',
  });
  const name = readdirSync(logDir).find((f) => /^apply-v0\.0\.2-\d{8}T\d{6}Z\.log$/.test(f));
  assert.ok(name, `no apply log in ${logDir}: ${res.stdout}${res.stderr}`);
  const log = readFileSync(path.join(logDir, name), 'utf8');
  const lines = log.trimEnd().split('\n');
  return { status: res.status, log, result: lines.at(-1), calls: readFileSync(calls, 'utf8') };
}

const SCRUB_RERUN =
  'docker compose run --rm -e BACKUP_NOW=1 backup && docker compose run --rm --no-deps -T kernel node dist/cli/scrub-raw-secrets.js --yes';

test('nothing left to do: RESULT ok', () => {
  const r = apply();
  assert.equal(r.result, 'RESULT ok');
  assert.equal(r.status, 0);
  assert.match(r.log, /^STEP raw-secret-scrub exit=0 scrub-raw-secrets: ok rewritten=0 log=/m);
});

test('BACKUP_NOW fails: the scrub is skipped and the RESULT is degraded, with the commands to finish', () => {
  const r = apply({ STUB_BACKUP_RC: '1' });
  assert.equal(r.result, 'RESULT degraded=backup-now,raw-secret-scrub');
  assert.match(r.log, /^STEP raw-secret-scrub skipped — backup-now failed \(exit=1\)/m);
  assert.ok(
    r.log.includes(
      `STEP raw-secret-scrub finish it from the checkout root, backup first: ${SCRUB_RERUN}`,
    ),
  );
  assert.match(
    r.log,
    /^STEP backup-now no recovery point .* docker compose run --rm -e BACKUP_NOW=1 backup/m,
  );
  // No fresh recovery point: neither data-rewriting CLI ran.
  assert.doesNotMatch(r.calls, /scrub-raw-secrets\.js|compact-observations\.js/);
});

test('the scrub fails part-way: degraded, with the commands to finish', () => {
  const r = apply({ STUB_SCRUB_RC: '1' });
  assert.equal(r.result, 'RESULT degraded=raw-secret-scrub');
  assert.match(
    r.log,
    /^STEP raw-secret-scrub exit=1 scrub-raw-secrets: failed: synthetic failure log=/m,
  );
  assert.ok(
    r.log.includes(
      `STEP raw-secret-scrub failed part-way — finish it from the checkout root, backup first: ${SCRUB_RERUN}`,
    ),
  );
});

test('the compaction fails: degraded, with the command to run again', () => {
  const r = apply({ STUB_COMPACTION_RC: '1' });
  assert.equal(r.result, 'RESULT degraded=observations-compaction');
  assert.match(
    r.log,
    /^STEP observations-compaction run again \(idempotent\): docker compose run/m,
  );
});

test('the data directory owners cannot be set: degraded, named per directory', () => {
  const r = apply({ STUB_CHOWN_RC: '1' });
  assert.equal(r.result, 'RESULT degraded=update-feed-dir,egress-sources');
  assert.match(r.log, /^STEP update-feed-dir WARNING /m);
  assert.match(r.log, /^STEP egress-sources WARNING /m);
});

test('acceptance failures and a degraded step are both reported', () => {
  const r = apply({ STUB_ACCEPT_FAIL: '1', STUB_SCRUB_RC: '1' });
  assert.equal(r.result, 'RESULT acceptance-failures=1 degraded=raw-secret-scrub');
});

test('a fatal step still stops with failed-at and exit 1', () => {
  const r = apply({ STUB_MIGRATE_RC: '1' });
  assert.equal(r.result, 'RESULT failed-at=migrate');
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.calls, /BACKUP_NOW=1|scrub-raw-secrets\.js/);
});
