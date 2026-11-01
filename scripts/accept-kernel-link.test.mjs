// node --test scripts/accept-kernel-link.test.mjs — wait_kernel_link in scripts/lib/accept-common.sh
// (#856 review #488 P2): after accept_provider_up / accept_provider_restore recreate the kernel,
// the scripts wait until agent-host logs `kernel-link: connected` again. Run through POSIX sh with
// a stand-in `docker` first on PATH that answers `docker compose logs …` from a file, so no Docker
// is needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Runs `wait_kernel_link <since>` with a fake `docker`: each call appends its arguments to
 * `calls`, and from call number `connectedFrom` on (1-based; 0 = never) prints a log that has the
 * connected line — or, with `logsFail`, fails like a log driver `docker compose logs` cannot read.
 * Returns the exit status, the recorded calls and what `WKL_PROBLEM` said.
 */
function waitKernelLink({ connectedFrom, waitSeconds, pollSeconds = '0', logsFail = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'accept-kernel-link-'));
  try {
    const calls = path.join(dir, 'calls');
    writeFileSync(calls, '');
    const docker = path.join(dir, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
n=$(wc -l < "${calls}")
if [ ${logsFail ? 1 : 0} -eq 1 ]; then
  echo 'Error response from daemon: configured logging driver does not support reading' >&2
  exit 1
fi
printf '%s\\n' '{"level":"warn","msg":"kernel-link: disconnected — will reconnect","code":1006}'
if [ ${connectedFrom} -gt 0 ] && [ "$n" -ge ${connectedFrom} ]; then
  printf '%s\\n' '{"level":"info","msg":"kernel-link: connected","instanceId":"x","replaying":0}'
fi
`,
    );
    chmodSync(docker, 0o755);
    const result = spawnSync(
      'sh',
      [
        '-c',
        '. scripts/lib/accept-common.sh && { wait_kernel_link "$1"; rc=$?; printf "%s" "$WKL_PROBLEM"; exit $rc; }',
        'sh',
        '2026-10-31T17:50:00Z',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ACCEPT_KERNEL_LINK_WAIT_S: String(waitSeconds),
          ACCEPT_KERNEL_LINK_POLL_S: pollSeconds,
        },
      },
    );
    return {
      status: result.status,
      calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
      problem: result.stdout,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('wait_kernel_link: returns once agent-host logged the link, looking at its log since the given time', () => {
  const { status, calls } = waitKernelLink({ connectedFrom: 3, waitSeconds: 10 });
  assert.equal(status, 0);
  assert.equal(calls.length, 3, 'it stops looking once the line is there');
  for (const call of calls) {
    assert.equal(call, 'compose logs --no-log-prefix --since 2026-10-31T17:50:00Z agent-host');
  }
});

test('wait_kernel_link: a log with only the disconnect is not a link', () => {
  const { status, calls } = waitKernelLink({ connectedFrom: 0, waitSeconds: 3 });
  assert.equal(status, 1);
  // Looks at 0, 1, 2 and 3 seconds waited, then gives up.
  assert.equal(calls.length, 4);
});

test('wait_kernel_link: already linked on the first look', () => {
  const { status, calls } = waitKernelLink({ connectedFrom: 1, waitSeconds: 0 });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
});

test('wait_kernel_link: settings that are not whole seconds refuse at once, saying so', () => {
  for (const [waitSeconds, pollSeconds] of [
    ['abc', '2'],
    ['60', '1.5'],
    ['-1', '2'],
  ]) {
    const { status, calls, problem } = waitKernelLink({
      connectedFrom: 1,
      waitSeconds,
      pollSeconds,
    });
    assert.equal(status, 1, `${waitSeconds}:${pollSeconds}`);
    assert.equal(calls.length, 0, 'it never looks at the log');
    assert.match(problem, /must be whole seconds/);
  }
});

test('wait_kernel_link: a log it cannot read is reported as that, not as a missing link', () => {
  const { status, calls, problem } = waitKernelLink({
    connectedFrom: 1,
    waitSeconds: 2,
    logsFail: true,
  });
  assert.equal(status, 1);
  assert.equal(calls.length, 3);
  assert.match(problem, /'docker compose logs agent-host' itself failed/);
  assert.match(problem, /logging driver does not support reading/);
});
