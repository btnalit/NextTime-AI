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
 * connected line. Returns the exit status and the recorded calls.
 */
function waitKernelLink({ connectedFrom, waitSeconds }) {
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
printf '%s\\n' '{"level":"warn","msg":"kernel-link: disconnected — will reconnect","code":1006}'
if [ ${connectedFrom} -gt 0 ] && [ "$n" -ge ${connectedFrom} ]; then
  printf '%s\\n' '{"level":"info","msg":"kernel-link: connected","instanceId":"x","replaying":0}'
fi
`,
    );
    chmodSync(docker, 0o755);
    const result = spawnSync(
      'sh',
      ['-c', '. scripts/lib/accept-common.sh && wait_kernel_link "$1"', 'sh', '2026-10-31T17:50:00Z'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ACCEPT_KERNEL_LINK_WAIT_S: String(waitSeconds),
          ACCEPT_KERNEL_LINK_POLL_S: '0',
        },
      },
    );
    return {
      status: result.status,
      calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
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
