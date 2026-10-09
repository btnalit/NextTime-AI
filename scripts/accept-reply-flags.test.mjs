// node --test scripts/accept-reply-flags.test.mjs — the real-model reply checks in
// scripts/lib/accept-common.sh (reply_says_running, reply_says_unavailable), run through POSIX sh
// exactly as accept_s2.sh / accept_s3.sh call them: on the lower-cased reply text.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

function flag(fn, reply) {
  return execFileSync('sh', ['-c', `. scripts/lib/accept-common.sh && ${fn} "$1"`, 'sh', reply], {
    encoding: 'utf8',
  }).trim();
}

test('reply_says_running: a running container counts', () => {
  for (const reply of [
    '镜像 alpine:3.20@sha256:d9e853e87e55，运行状态：运行中',
    '镜像 alpine:3.20，容器正在运行（up since 2026-10-09t07:00:00z）',
    'image alpine:3.20, state: running',
  ]) {
    assert.equal(flag('reply_says_running', reply), '1', reply);
  }
});

test('reply_says_running: echoing the question or a stopped state does not count', () => {
  for (const reply of [
    '镜像 alpine:3.20，运行状态：已停止（exited）',
    '镜像 alpine:3.20，当前未运行',
    '镜像 alpine:3.20，运行状态未知',
    'image alpine:3.20, the container is not running',
    'image alpine:3.20, state: exited (0)',
    '',
  ]) {
    assert.equal(flag('reply_says_running', reply), '0', reply);
  }
});

test('reply_says_unavailable: flags "could not see it" replies only', () => {
  assert.equal(flag('reply_says_unavailable', '我无法看到这个容器的命令'), '1');
  assert.equal(
    flag('reply_says_unavailable', 'the command is not available through the gate'),
    '1',
  );
  assert.equal(flag('reply_says_unavailable', '镜像 alpine:3.20，运行中'), '0');
});
