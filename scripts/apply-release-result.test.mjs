// Tests for the RESULT line of scripts/apply-release.sh: runs the real script in a scratch checkout
// with stub `docker`, `git`, `chown`, `timeout` and `sleep` on PATH, and checks which outcomes end
// "RESULT ok" and which do not — above all, that a skipped or failed raw-secret scrub is never "ok"
// (review of #555's runbook) and that the log says what to run again. Also the steps 审查 #488 asked
// for on #556: stale single-file mounts are refreshed, no acceptance fixture is left running, and
// the caddy log check runs inside the apply.
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
  *"exec -T "*" cat "*)
    case "$*" in *"exec -T \${STUB_STALE_MOUNT:-none} cat"*) echo stale ;; *) echo current ;; esac ;;
  *--force-recreate*) exit "\${STUB_RECREATE_RC:-0}" ;;
  *"stop fake-llm"*) exit "\${STUB_FAKE_LLM_STOP_RC:-0}" ;;
  *"config --services"*)
    [ -z "\${STUB_CONFIG_RC:-}" ] || exit "$STUB_CONFIG_RC"
    printf 'kernel\ncaddy\n'
    case "$*" in *--profile*) printf 'fake-llm\naccept-s2-sshd\naccept-s3-ephemeral\n' ;; esac ;;
  *"ps --status running --services"*) printf 'kernel\ncaddy\n%s' "\${STUB_FIXTURES_RUNNING:-}" ;;
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
file(path.join(repo, '.env'), `NEXTTIME_DATA=${data}\nKERNEL_BIND_ADDR=127.0.0.1\n`);
// The single-file mounts (MOUNT_REFRESH): a running container "sees" current unless stale.
for (const mounted of [
  'deploy/caddy/Caddyfile',
  'deploy/backup/backup.sh',
  'deploy/update-feed/update-feed.sh',
]) {
  file(path.join(repo, mounted), 'current\n');
}
file(
  path.join(repo, 'scripts/check-caddy-log-redaction.sh'),
  'echo "PASS logged url=$1 since=$LOGS_SINCE"\n[ "${STUB_CADDY_CHECK_RC:-0}" -eq 0 ] || echo "FAIL probe lines-with-the-synthetic-value=2"\nexit "${STUB_CADDY_CHECK_RC:-0}"\n',
);
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
  assert.match(r.log, /^STEP acceptance-fixtures none left running$/m);
  // The caddy check runs against .env's bind address, over the log lines since the apply began.
  assert.match(
    r.log,
    /^STEP caddy-log-redaction PASS logged url=https:\/\/127\.0\.0\.1:8443 since=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m,
  );
  assert.doesNotMatch(r.calls, /--force-recreate/);
});

test('a container reading an old single-file mount is recreated before acceptance', () => {
  const r = apply({ STUB_STALE_MOUNT: 'caddy' });
  assert.equal(r.result, 'RESULT ok');
  assert.match(
    r.log,
    /^STEP mount-refresh caddy recreated — it was not reading this checkout's deploy\/caddy\/Caddyfile$/m,
  );
  assert.match(r.calls, /^docker compose up -d --no-deps --no-build --force-recreate caddy$/m);
  assert.doesNotMatch(r.calls, /--force-recreate (backup|update-feed)/);
  assert.ok(
    r.log.indexOf('STEP mount-refresh caddy') < r.log.indexOf('STEP S3 '),
    'refreshed before the acceptance suites run',
  );
});

test('a stale mount that cannot be refreshed: degraded, with the command', () => {
  const r = apply({ STUB_STALE_MOUNT: 'backup', STUB_RECREATE_RC: '1' });
  assert.equal(r.result, 'RESULT degraded=mount-refresh');
  assert.match(
    r.log,
    /^STEP mount-refresh WARNING could not recreate backup — .* docker compose up -d --no-deps --no-build --force-recreate backup$/m,
  );
});

test('acceptance fixtures left running (fake-llm included): degraded, with the command to remove them', () => {
  const r = apply({
    STUB_FAKE_LLM_STOP_RC: '1',
    STUB_FIXTURES_RUNNING: 'fake-llm\naccept-s2-sshd\n',
  });
  assert.equal(r.result, 'RESULT degraded=acceptance-fixtures');
  assert.match(r.log, /^STEP fake-llm WARNING could not stop it/m);
  // Only fixtures are named — kernel and caddy run too, and are not fixtures.
  assert.match(
    r.log,
    /^STEP acceptance-fixtures WARNING still running: fake-llm accept-s2-sshd — remove them: docker compose --profile test --profile accept-s2 --profile accept-s3 rm -sf fake-llm accept-s2-sshd$/m,
  );
});

test('the fixtures cannot be listed: degraded rather than assumed gone', () => {
  const r = apply({ STUB_CONFIG_RC: '1' });
  assert.equal(r.result, 'RESULT degraded=acceptance-fixtures');
  assert.match(r.log, /^STEP acceptance-fixtures WARNING could not list them/m);
});

test('the caddy log check fails: degraded, with the commands to recreate caddy and check again', () => {
  const r = apply({ STUB_CADDY_CHECK_RC: '1' });
  assert.equal(r.result, 'RESULT degraded=caddy-log-redaction');
  assert.match(r.log, /^STEP caddy-log-redaction FAIL probe /m);
  assert.match(
    r.log,
    /^STEP caddy-log-redaction WARNING .* docker compose up -d --no-deps --no-build --force-recreate caddy && sh scripts\/check-caddy-log-redaction\.sh https:\/\/127\.0\.0\.1:8443$/m,
  );
});

test('backups/last-success is a non-empty directory: degraded, with the command to move it aside', () => {
  const marker = path.join(data, 'backups/last-success');
  rmSync(marker, { recursive: true, force: true });
  file(path.join(marker, 'stray'), '');
  try {
    const r = apply();
    assert.equal(r.result, 'RESULT degraded=backup-marker');
    assert.match(
      r.log,
      /^STEP backup-marker WARNING .* mv .*backups\/last-success .*last-success\.moved-/m,
    );
  } finally {
    rmSync(marker, { recursive: true, force: true });
  }
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
