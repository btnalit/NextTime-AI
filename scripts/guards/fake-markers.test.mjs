// node --test scripts/guards/fake-markers.test.mjs — the detectors of scripts/guards/fake-markers.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FLAG_SETTER,
  HOOK_GATE,
  MARKERS,
  check,
  flagFindings,
  hookFindings,
  markerFindings,
} from './fake-markers.mjs';

const [DELEGATE, ADMIN] = MARKERS;

test('a marker is allowed in the fake runtime, its tests and the e2e specs only', () => {
  const text = `const MARKER = '${ADMIN}';`;
  for (const rel of [
    'packages/kernel/src/application/host-bridge/fake-runtime.ts',
    'packages/kernel/src/application/host-bridge/fake-runtime.test.ts',
    'packages/kernel/src/fake-admin-propose.integration.test.ts',
    'packages/web/e2e/journeys/09-admin-agent.spec.ts',
    'packages/web/e2e/journeys/10-admin-agent-pack.spec.ts',
  ]) {
    assert.deepEqual(markerFindings(rel, text), [], rel);
  }
  for (const rel of [
    'packages/agent-host/src/turns.ts',
    'packages/worker-runtime/platform-extension/src/index.ts',
    'deploy/worker-runtime/entrypoint.sh',
    'deploy/fake-llm/server.mjs',
    'packages/kernel/src/application/chat/service.ts',
    'packages/web/e2e/journeys/helpers.ts',
  ]) {
    assert.equal(markerFindings(rel, text).length, 1, rel);
  }
  assert.equal(markerFindings('packages/agent-host/src/x.ts', `${DELEGATE} ${ADMIN}`).length, 2);
});

test('a hook is built only by index.ts, inside the FAKE_INVOKE_WORKER gate', () => {
  const inside = `
    let hook;
    if (${HOOK_GATE}) {
      hook = createFakeAdminProposeHandler({ pool, privateKey });
      other = createFakeDelegateHandler({ pool });
    }
  `;
  assert.deepEqual(hookFindings('packages/kernel/src/index.ts', inside), []);

  const outside = `${inside}\n    const leaked = createFakeAdminProposeHandler({ pool, privateKey });`;
  assert.deepEqual(hookFindings('packages/kernel/src/index.ts', outside), [
    'packages/kernel/src/index.ts: builds createFakeAdminProposeHandler outside the FAKE_INVOKE_WORKER gate',
  ]);

  assert.deepEqual(
    hookFindings('packages/kernel/src/index.ts', 'createFakeDelegateHandler({ pool });'),
    [
      'packages/kernel/src/index.ts: builds createFakeDelegateHandler but the FAKE_INVOKE_WORKER gate is gone',
    ],
  );

  assert.equal(
    hookFindings(
      'packages/kernel/src/application/host-bridge/agent-host-runtime.ts',
      'createFakeAdminProposeHandler(deps)',
    ).length,
    1,
  );
  // Its own module defines it; its integration test calls it.
  assert.deepEqual(
    hookFindings(
      'packages/kernel/src/fake-admin-propose.ts',
      'export function createFakeAdminProposeHandler(deps) {}',
    ),
    [],
  );
  // Its unit test imports the module too (S11 AA5g: `fakeProposablePack`).
  assert.deepEqual(
    hookFindings(
      'packages/kernel/src/fake-admin-propose.test.ts',
      "import { fakeProposablePack } from './fake-admin-propose.js';",
    ),
    [],
  );
});

test('a hook cannot be reached under another name: its module is imported by index.ts only, never aliased', () => {
  // #945 review (#493 P3): an alias or a namespace import would not read as `name(`.
  for (const text of [
    "import { createFakeAdminProposeHandler as make } from '../../fake-admin-propose.js';",
    "import * as fake from '../fake-invoke-worker.js';",
    "const { createFakeDelegateHandler: build } = await import('../../fake-invoke-worker.js');",
    "const hooks = require('./fake-admin-propose');",
  ]) {
    assert.deepEqual(
      hookFindings('packages/kernel/src/application/host-bridge/agent-host-runtime.ts', text),
      [
        "packages/kernel/src/application/host-bridge/agent-host-runtime.ts: imports a CI-only hook's module (only the kernel's index.ts may)",
      ],
      text,
    );
  }
  assert.deepEqual(
    hookFindings(
      'packages/kernel/src/index.ts',
      `import { createFakeAdminProposeHandler as make } from './fake-admin-propose.js';\nif (${HOOK_GATE}) {\n  hook = make(deps);\n}`,
    ),
    [
      'packages/kernel/src/index.ts: imports createFakeAdminProposeHandler under another name (call it by its own name)',
    ],
  );
  // index.ts's own import, by name, and a comment naming the module elsewhere are fine.
  assert.deepEqual(
    hookFindings(
      'packages/kernel/src/index.ts',
      `import { createFakeAdminProposeHandler } from './fake-admin-propose.js';\nif (${HOOK_GATE}) {\n  hook = createFakeAdminProposeHandler(deps);\n}`,
    ),
    [],
  );
  assert.deepEqual(
    hookFindings(
      'packages/kernel/src/application/host-bridge/fake-runtime.ts',
      ' * Wired only by `packages/kernel/src/fake-admin-propose.ts` (CI-only glue).',
    ),
    [],
  );
});

test('FAKE_INVOKE_WORKER gets a value only in the CI env template', () => {
  assert.deepEqual(flagFindings(FLAG_SETTER, 'FAKE_INVOKE_WORKER=1'), []);
  // docker-compose.yml passes it through, empty by default.
  assert.deepEqual(
    flagFindings('docker-compose.yml', '        FAKE_INVOKE_WORKER: "${FAKE_INVOKE_WORKER:-}",'),
    [],
  );
  assert.deepEqual(
    flagFindings('deploy/accept/docker-compose.fake.yml', '# FAKE_INVOKE_WORKER=1 never here'),
    [],
  );
  for (const [rel, line] of [
    ['deploy/accept/docker-compose.fake.yml', '      FAKE_INVOKE_WORKER: "1"'],
    ['docker-compose.yml', '        FAKE_INVOKE_WORKER: "${FAKE_INVOKE_WORKER:-1}",'],
    ['.env.example', 'FAKE_INVOKE_WORKER=1'],
    ['scripts/staging-rehearsal.sh', '  export FAKE_INVOKE_WORKER=1'],
    ['.github/workflows/staging.yml', '          FAKE_INVOKE_WORKER: 1'],
  ]) {
    assert.equal(flagFindings(rel, line).length, 1, `${rel}: ${line}`);
  }
  // The kernel reads it; a TypeScript test may set it in its own process.
  assert.deepEqual(
    flagFindings('packages/kernel/src/index.ts', "if (process.env.FAKE_INVOKE_WORKER === '1') {"),
    [],
  );
  assert.deepEqual(
    flagFindings(
      'packages/kernel/src/index.ts',
      '      "FAKE_INVOKE_WORKER=1: invoke_worker and the admin agent\'s propose_admin_proposal are scripted",',
    ),
    [],
  );
  assert.deepEqual(
    flagFindings(
      'packages/kernel/src/fake-admin-propose.integration.test.ts',
      "process.env.FAKE_INVOKE_WORKER = '1';",
    ),
    [],
  );
});

test('FAKE_INVOKE_WORKER set any other way is found too: Dockerfile ENV, JSON, a TypeScript script', () => {
  // #945 review (#493 P3).
  for (const [rel, line] of [
    ['deploy/worker-runtime/Dockerfile', 'ENV FAKE_INVOKE_WORKER 1'],
    ['packages/kernel/Dockerfile', 'ENV NODE_ENV=production FAKE_INVOKE_WORKER=1'],
    ['packages/kernel/Dockerfile', 'ARG FAKE_INVOKE_WORKER=1'],
    ['deploy/accept/env.json', '  "FAKE_INVOKE_WORKER": "1",'],
    ['packages/web/package.json', '    "e2e": "FAKE_INVOKE_WORKER=1 playwright test",'],
    ['scripts/accept/run.ts', "process.env.FAKE_INVOKE_WORKER = '1';"],
    ['scripts/accept/run.ts', "process.env['FAKE_INVOKE_WORKER'] = flag;"],
    [
      'scripts/accept/run.ts',
      "spawn('node', [main], { env: { ...process.env, FAKE_INVOKE_WORKER: '1' } });",
    ],
    ['packages/kernel/src/boot.mts', "  FAKE_INVOKE_WORKER: 'true',"],
  ]) {
    assert.equal(flagFindings(rel, line).length, 1, `${rel}: ${line}`);
  }
  for (const [rel, line] of [
    ['deploy/worker-runtime/Dockerfile', '# ENV FAKE_INVOKE_WORKER 1 — never'],
    ['deploy/accept/env.json', '  "FAKE_INVOKE_WORKER": "",'],
    ['scripts/accept/run.ts', "if (process.env.FAKE_INVOKE_WORKER !== '1') return;"],
    ['scripts/accept/run.ts', "process.env.FAKE_INVOKE_WORKER = '';"],
  ]) {
    assert.deepEqual(flagFindings(rel, line), [], `${rel}: ${line}`);
  }
});

test('check reads every file it is given and reports each rule', () => {
  const files = {
    'packages/agent-host/src/a.ts': `'${DELEGATE}'`,
    'deploy/x.env': 'FAKE_INVOKE_WORKER=1',
    'packages/kernel/src/b.ts': 'createFakeDelegateHandler(x)',
    'packages/kernel/src/application/host-bridge/fake-runtime.ts': `'${ADMIN}'`,
  };
  const findings = check(Object.keys(files), (rel) => files[rel]);
  assert.equal(findings.length, 3);
});
