// Unit tests for scripts/guards/staging-paths.mjs's parsing helpers; the guard itself runs against
// the real repository in CI (`quality`) and `pnpm ci:guards`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, filterPaths, globToRegExp, referencedPaths } from './staging-paths.mjs';

test('globToRegExp: * stays within a directory, ** crosses directories', () => {
  assert.ok(globToRegExp('scripts/host-*.sh').test('scripts/host-preflight.sh'));
  assert.ok(!globToRegExp('scripts/host-*.sh').test('scripts/lib/host-x.sh'));
  assert.ok(globToRegExp('deploy/caddy/**').test('deploy/caddy/a/Caddyfile'));
  assert.ok(globToRegExp('scripts/accept_s*.sh').test('scripts/accept_s*.sh'));
  assert.ok(!globToRegExp('scripts/prune-images.sh').test('scripts/prune-imagesXsh'));
});

test('filterPaths reads only the pull_request paths list', () => {
  const wf = 'on:\n  pull_request:\n    paths:\n      - a.sh\n      - \'deploy/x/**\'\n  workflow_dispatch:\n    inputs: {}\n';
  assert.deepEqual(filterPaths(wf), ['a.sh', 'deploy/x/**']);
  assert.throws(() => filterPaths('on:\n  push:\n'));
});

test('referencedPaths: skips comments, turns $var into *, drops all-variable names', () => {
  const sh = [
    '# sh scripts/commented-out.sh',
    'sh scripts/prune-images.sh --keep 2',
    'sh "scripts/accept_s$s.sh"',
    'sh "scripts/$s.sh"',
    '      - ./deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro',
  ].join('\n');
  assert.deepEqual([...referencedPaths(sh)].sort(), [
    'deploy/caddy/Caddyfile',
    'scripts/accept_s*.sh',
    'scripts/prune-images.sh',
  ]);
});

test('the repository filter covers the rehearsal closure', () => {
  assert.deepEqual(check(), []);
});
