// node --test scripts/accept-real-budget.test.mjs — real_budget_check in scripts/lib/accept-common.sh
// (legacy 586): a real-model round whose workspace llm-proxy refused for its budget is void. Run
// through POSIX sh with a stand-in `docker` first on PATH that answers `docker compose logs …` from
// a fixed log, so no Docker is needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const WORKSPACE = '7b9510c9-0000-4000-8000-000000000001';
const OTHER_WORKSPACE = '68295b58-0000-4000-8000-000000000002';

const refusal = (workspaceId, scope) =>
  JSON.stringify({
    level: 'warn',
    msg: 'llm-proxy: refused, workspace budget exhausted',
    correlationId: 'c-1',
    provider: 'p',
    workspaceId,
    scope,
  });

/** Runs `real_budget_check real-budget` with a fake `docker` printing `log` (or failing like a
 *  log driver `docker compose logs` cannot read). Returns exit status, stdout, stderr, calls. */
function realBudgetCheck({ log = '', logsFail = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'accept-real-budget-'));
  try {
    const calls = path.join(dir, 'calls');
    const logFile = path.join(dir, 'log');
    writeFileSync(calls, '');
    writeFileSync(logFile, log);
    const docker = path.join(dir, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
if [ ${logsFail ? 1 : 0} -eq 1 ]; then
  echo 'Error response from daemon: configured logging driver does not support reading' >&2
  exit 1
fi
cat "${logFile}"
`,
    );
    chmodSync(docker, 0o755);
    const result = spawnSync(
      'sh',
      ['-c', '. scripts/lib/accept-common.sh && real_budget_check real-budget && echo AFTER'],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WORKSPACE_ID: WORKSPACE },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real_budget_check: passes when llm-proxy refused nothing for this workspace, reading the whole llm-proxy log', () => {
  const { status, stdout, calls } = realBudgetCheck({
    log: `${JSON.stringify({ level: 'info', msg: 'llm-proxy: listening' })}\n${refusal(OTHER_WORKSPACE, 'workspace_daily_tokens')}\n`,
  });
  assert.equal(status, 0);
  assert.match(stdout, /^PASS real-budget llm-proxy refused no model call of workspace /m);
  assert.match(stdout, /^AFTER$/m);
  assert.deepEqual(calls, ['compose logs --no-color --no-log-prefix llm-proxy']);
});

test('real_budget_check: fails the round on a refusal for this workspace, naming the count and scopes', () => {
  const { status, stdout, stderr } = realBudgetCheck({
    log: [
      refusal(WORKSPACE, 'workspace_daily_tokens'),
      refusal(WORKSPACE, 'workspace_daily_tokens'),
      refusal(WORKSPACE, 'workspace_daily_cost'),
      refusal(OTHER_WORKSPACE, 'workspace_daily_tokens'),
    ].join('\n'),
  });
  assert.equal(status, 1);
  assert.doesNotMatch(stdout, /AFTER/);
  assert.match(
    stderr,
    new RegExp(
      `^FAIL real-budget llm-proxy refused 3 model call\\(s\\) of workspace ${WORKSPACE} \\(scope: workspace_daily_cost workspace_daily_tokens\\): `,
      'm',
    ),
  );
  assert.match(stderr, /raise it and run again/);
});

test('real_budget_check: a log it cannot read is a SKIP, never a pass', () => {
  const { status, stdout } = realBudgetCheck({ logsFail: true });
  assert.equal(status, 0);
  assert.match(
    stdout,
    /^SKIP real-budget 'docker compose logs llm-proxy' failed, so budget refusals were not checked: /m,
  );
  assert.doesNotMatch(stdout, /^PASS/m);
});
