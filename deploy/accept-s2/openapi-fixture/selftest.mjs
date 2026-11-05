#!/usr/bin/env node
// Self-test for deploy/accept-s2/openapi-fixture/server.mjs (S11 AA5c): starts the real fixture as a
// child process on a free local port and drives the ticket system the admin agent journey uses
// (scripts/lib/accept-s2-admin-agent-tickets.sh), plus a smoke check that the routes the older
// accept_s2 scenarios use still answer as before. What the kernel derives from the ticket system's
// OpenAPI document (three Operations, GET observe, POST execute) is pinned by
// packages/gatekeeper-base/src/kinds/accept-s2-tickets-openapi.test.ts.
//
// Not part of `pnpm test` — like deploy/accept-s2/fake-llm-scenario-selftest.mjs, this directory is
// not a pnpm workspace package. Run directly (CI's quality job does):
//   node deploy/accept-s2/openapi-fixture/selftest.mjs
// Exits 0 and prints "openapi-fixture self-test: OK" on success; prints failures and exits 1
// otherwise. The tokens are random per run and never printed.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const TRIAL_TOKEN = randomBytes(16).toString('hex');
const PROD_TOKEN = randomBytes(16).toString('hex');

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(base) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the fixture did not start within 5s');
}

async function call(base, method, path, { token, body } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

async function run(base) {
  // The ticket system's OpenAPI document: no auth, the three Operations the journey expects.
  const doc = await call(base, 'GET', '/tickets/openapi.json');
  check('tickets openapi 200', doc.status === 200, String(doc.status));
  const ids = Object.values(doc.json?.paths ?? {})
    .flatMap((item) => Object.values(item))
    .map((op) => op.operationId)
    .sort();
  check(
    'tickets openapi operations',
    JSON.stringify(ids) === JSON.stringify(['tickets.create', 'tickets.get', 'tickets.list']),
    JSON.stringify(ids),
  );

  // Reads need a credential; either one works.
  check('tickets list without token 401', (await call(base, 'GET', '/tickets')).status === 401);
  check(
    'tickets list with a wrong token 401',
    (await call(base, 'GET', '/tickets', { token: 'not-the-token' })).status === 401,
  );
  const list = await call(base, 'GET', '/tickets', { token: TRIAL_TOKEN });
  check('tickets list 200', list.status === 200, String(list.status));
  check(
    'tickets list starts with the two seeded tickets',
    JSON.stringify(list.json?.items?.map((t) => t.id)) === JSON.stringify(['T-1001', 'T-1002']),
    JSON.stringify(list.json),
  );
  check('tickets list names the trial credential as its reader', list.json?.readBy === 'trial', JSON.stringify(list.json?.readBy));
  const prodList = await call(base, 'GET', '/tickets', { token: PROD_TOKEN });
  check(
    'tickets list names the production credential as its reader',
    prodList.status === 200 && prodList.json?.readBy === 'production' && prodList.json?.items?.length === 2,
    JSON.stringify(prodList.json),
  );
  const one = await call(base, 'GET', '/tickets/T-1001', { token: PROD_TOKEN });
  check('tickets get 200', one.status === 200 && one.json?.id === 'T-1001', JSON.stringify(one));
  check(
    'tickets get unknown 404',
    (await call(base, 'GET', '/tickets/T-9999', { token: TRIAL_TOKEN })).status === 404,
  );
  check(
    'tickets get without token 401',
    (await call(base, 'GET', '/tickets/T-1001')).status === 401,
  );

  // A bad ticket opens nothing.
  for (const [label, body] of [
    ['no title', { priority: 'high' }],
    ['empty title', { title: '' }],
    ['long title', { title: 'x'.repeat(201) }],
    ['unknown priority', { title: 'ok', priority: 'urgent' }],
    ['not json', 'title=ok'],
  ]) {
    const res = await call(base, 'POST', '/tickets', { token: TRIAL_TOKEN, body });
    check(`tickets create refuses ${label} with 400`, res.status === 400, String(res.status));
  }
  check(
    'tickets create without token 401',
    (await call(base, 'POST', '/tickets', { body: { title: 'no credential' } })).status === 401,
  );
  const unchanged = await call(base, 'GET', '/tickets', { token: TRIAL_TOKEN });
  check('refused creates opened nothing', unchanged.json?.items?.length === 2);

  // Each credential's ticket records which one opened it.
  const trial = await call(base, 'POST', '/tickets', {
    token: TRIAL_TOKEN,
    body: { title: 'Check the trial gate', priority: 'low' },
  });
  check(
    'tickets create (trial) 201',
    trial.status === 201 &&
      trial.json?.id === 'T-1003' &&
      trial.json?.via === 'trial' &&
      trial.json?.priority === 'low' &&
      trial.json?.status === 'open',
    JSON.stringify(trial),
  );
  const prod = await call(base, 'POST', '/tickets', {
    token: PROD_TOKEN,
    body: { title: 'Check the production gate' },
  });
  check(
    'tickets create (production) 201, priority defaults to normal',
    prod.status === 201 &&
      prod.json?.id === 'T-1004' &&
      prod.json?.via === 'production' &&
      prod.json?.priority === 'normal',
    JSON.stringify(prod),
  );
  const after = await call(base, 'GET', '/tickets', { token: TRIAL_TOKEN });
  check(
    'tickets list shows both new tickets with their credential',
    JSON.stringify(after.json?.items?.map((t) => `${t.id}:${t.via}`)) ===
      JSON.stringify(['T-1001:seed', 'T-1002:seed', 'T-1003:trial', 'T-1004:production']),
    JSON.stringify(after.json),
  );

  // The older scenarios' routes: unchanged, and only the original token reaches them.
  check('openapi.json 200', (await call(base, 'GET', '/openapi.json')).status === 200);
  check(
    'stock with token 200',
    (await call(base, 'GET', '/stock', { token: TRIAL_TOKEN })).status === 200,
  );
  check(
    'stock with the tickets production token 401',
    (await call(base, 'GET', '/stock', { token: PROD_TOKEN })).status === 401,
  );
  const ledger = await call(base, 'POST', '/ledger/selftest', { token: TRIAL_TOKEN });
  check(
    'ledger add 200',
    ledger.status === 200 && ledger.json?.count === 1,
    JSON.stringify(ledger),
  );
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PORT: String(port),
    ACCEPT_S2_API_TOKEN: TRIAL_TOKEN,
    ACCEPT_S2_TICKETS_PROD_TOKEN: PROD_TOKEN,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
try {
  await waitUntilUp(base);
  await run(base);
} catch (err) {
  failures.push(`unexpected: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  child.kill();
}

if (failures.length > 0) {
  console.error(`openapi-fixture self-test: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('openapi-fixture self-test: OK');
