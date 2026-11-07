#!/usr/bin/env node
// deploy/ci/self-gate: the CI stack's self-connected gate (legacy 671). Test fixture only — the
// console e2e's own service (deploy/ci/docker-compose.ci.yml), never part of a real deployment.
// Plain dependency-free ESM, same convention as deploy/accept-s2/mcp/server.mjs.
//
// What it is for: a workspace owner connects it through the console (`create_connection`), and
// the kernel then reaches it the way it reaches any self-connected gate — with that connection's
// own secret (R-01), never the platform gate token. It speaks just enough of the Gatekeeper
// protocol (packages/gatekeeper-base/src/protocol.ts) for that: `describe_operations` answers a
// fixed two-Operation manifest, `health` answers ok, and every other `/gate/*` path is a 404 in
// the protocol's envelope. It runs nothing.
//
// The secret: the owner copies the one the console mints into the gate's GATE_KERNEL_TOKEN_FILE.
// Here the e2e does that through a workflow script (E2E_SET_SELF_GATE_SECRET_CMD), so the file is
// read on every request, not once at start — a rotated secret takes effect without a restart.
// Until the file exists every `/gate/*` call is refused, as is any other bearer: 401
// `unauthorized`, the same answer gatekeeper-base's gate-auth.ts gives.
//
// Endpoints:
//   GET /healthz                  -> {status:"ok"}, no auth (the compose healthcheck).
//   GET /gate/describe_operations -> {ok:true,result:{operations:[...]}}
//   GET /gate/health              -> {ok:true,result:{status:"ok"}}

import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const PORT = Number(process.env.GATE_PORT ?? 8090);
const TOKEN_FILE = process.env.GATE_KERNEL_TOKEN_FILE ?? '/data/gate/kernel.token';

const operation = (name, mode, extra) => ({
  name,
  binding: { kind: 'http', method: mode === 'observe' ? 'GET' : 'POST', path: `/${name}` },
  params_schema: { type: 'object', properties: {} },
  mode,
  blast_radius: mode === 'observe' ? 'low' : 'medium',
  reversibility: false,
  auto_approvable: mode === 'observe',
  await_decision: mode === 'execute',
  reads: [],
  writes: [],
  ...extra,
});

const OPERATIONS = [
  operation('ci_self_list_notes', 'observe', { read_only_hint: true }),
  operation('ci_self_archive_note', 'execute', { destructive_hint: false, idempotent_hint: true }),
];

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function expectedToken() {
  try {
    const raw = (await readFile(TOKEN_FILE, 'utf8')).trim();
    return raw.length > 0 ? Buffer.from(raw, 'utf8') : null;
  } catch {
    return null;
  }
}

function presentedToken(header) {
  if (typeof header !== 'string') return null;
  const space = header.indexOf(' ');
  if (space === -1 || header.slice(0, space).toLowerCase() !== 'bearer') return null;
  const token = header.slice(space + 1).trim();
  return token.length > 0 ? Buffer.from(token, 'utf8') : null;
}

async function authorized(req) {
  const expected = await expectedToken();
  const presented = presentedToken(req.headers.authorization);
  return (
    expected !== null &&
    presented !== null &&
    presented.length === expected.length &&
    timingSafeEqual(presented, expected)
  );
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://self-gate').pathname;
  if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok' });
  if (!path.startsWith('/gate/')) {
    return send(res, 404, { ok: false, error: { code: 'not_found', message: 'not found' } });
  }
  if (!(await authorized(req))) {
    res.setHeader('www-authenticate', 'Bearer');
    return send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } });
  }
  if (req.method === 'GET' && path === '/gate/describe_operations') {
    return send(res, 200, { ok: true, result: { operations: OPERATIONS } });
  }
  if (req.method === 'GET' && path === '/gate/health') {
    return send(res, 200, { ok: true, result: { status: 'ok' } });
  }
  return send(res, 404, {
    ok: false,
    error: { code: 'not_found', message: `this fixture gate does not serve ${req.method} ${path}` },
  });
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: `ci self-gate listening on ${PORT}` }));
});
