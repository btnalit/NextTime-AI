// Tests for scripts/check-caddy-log-redaction.sh's verdicts, without caddy: stub `curl` and `sleep`
// on PATH, and a COMPOSE command that prints a fixed log and records its arguments. The probe
// value is random per run, so a fixture can carry the masked probe request but never the value.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-caddy-log-redaction.sh',
);
const dir = mkdtempSync(path.join(tmpdir(), 'check-caddy-log-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const bin = path.join(dir, 'bin');
mkdirSync(bin);
for (const name of ['curl', 'sleep']) {
  writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(bin, name), 0o755);
}
const fakeCompose = path.join(dir, 'compose');
writeFileSync(fakeCompose, '#!/bin/sh\necho "$*" >"$FAKE_ARGS"\ncat "$FAKE_LOG"\n');
chmodSync(fakeCompose, 0o755);

const MASKED_PROBE =
  '{"logger":"http.log.access.log0","request":{"uri":"/api/health?caddyprobe=REDACTED&token=REDACTED&format=REDACTED"},"status":401}';

function check(logLines, env = {}) {
  const log = path.join(dir, 'caddy.log');
  const args = path.join(dir, 'args');
  writeFileSync(log, `${logLines.join('\n')}\n`);
  writeFileSync(args, '');
  const res = spawnSync('sh', [SCRIPT, 'https://127.0.0.1:8443'], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      COMPOSE: fakeCompose,
      FAKE_LOG: log,
      FAKE_ARGS: args,
      ...env,
    },
    encoding: 'utf8',
  });
  return { status: res.status, out: res.stdout, args: readFileSync(args, 'utf8').trim() };
}

function valuesFile(content) {
  const p = path.join(dir, `values-${Math.random().toString(36).slice(2)}`);
  writeFileSync(p, content);
  return p;
}

test('a clean log passes, and the whole log is read by default', () => {
  const r = check([MASKED_PROBE]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^PASS logged access-log-entries=1$/m);
  assert.equal(r.args, 'logs --no-color caddy');
});

test('LOGS_SINCE narrows the log read', () => {
  const r = check([MASKED_PROBE], { LOGS_SINCE: '2026-10-15T16:00:00Z' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.args, 'logs --no-color --since 2026-10-15T16:00:00Z caddy');
});

test('no probe request in the log: fails, never a vacuous pass', () => {
  const r = check(['{"logger":"http.log.access.log0","request":{"uri":"/"}}']);
  assert.equal(r.status, 1);
  assert.match(r.out, /^FAIL logged /m);
});

test('an entry carrying an X-Api-Key header fails', () => {
  const r = check([MASKED_PROBE, '{"request":{"headers":{"X-Api-Key":["synthetic"]}}}']);
  assert.equal(r.status, 1);
  assert.match(r.out, /^FAIL headers entries-with-an-X-Api-Key-header=1$/m);
});

test('forbidden values: found fails, absent passes', () => {
  const found = check([MASKED_PROBE, 'synthetic-forbidden-1'], {
    FORBIDDEN_VALUES_FILE: valuesFile('synthetic-forbidden-1\nsynthetic-forbidden-2\n'),
  });
  assert.equal(found.status, 1);
  assert.match(found.out, /^FAIL forbidden values=2 found=1$/m);
  const absent = check([MASKED_PROBE], {
    FORBIDDEN_VALUES_FILE: valuesFile('synthetic-forbidden-1\n'),
  });
  assert.equal(absent.status, 0, absent.out);
  assert.match(absent.out, /^PASS forbidden values=1 found=0$/m);
});

test('a forbidden-values file with no value, or none at all, fails instead of passing', () => {
  for (const file of [valuesFile('\n\n'), valuesFile(''), path.join(dir, 'missing')]) {
    const r = check([MASKED_PROBE], { FORBIDDEN_VALUES_FILE: file });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^FAIL forbidden values=0 /m);
  }
});
