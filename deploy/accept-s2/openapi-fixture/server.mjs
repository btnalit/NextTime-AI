#!/usr/bin/env node
// accept-s2 openapi-fixture: a deterministic test "system" for S2.12's connection-flow acceptance
// (docs/development-tasks.md S2.12, deliverable 1b "a test OpenAPI service"; S2.13's own
// acceptance sentence folded in — "after connecting the fake OpenAPI, find_operations('stock')
// hits"). Plain dependency-free ESM, same convention as deploy/fake-llm/server.mjs (this directory
// is not a pnpm workspace package either — see that file's own doc comment for why).
//
// Endpoints:
//   GET /healthz     -> {status:"ok"}, no auth.
//   GET /openapi.json -> the static OpenAPI 3.0 document (openapi.json, checked in next to this
//                         file) that scripts/accept_s2.sh feeds to `create_connection`'s
//                         `manifestSource` — the kernel's own `importOpenApi` (@nexttime/
//                         gatekeeper-base) parses this document to produce the imported Operation
//                         draft; accept_s2.sh's own `deploy/accept-s2/http-gate-manifest.json`
//                         (the gate's static, served manifest — see that file's header comment)
//                         must describe the exact same Operation(s) `importOpenApi` would derive
//                         from this document, so the two independently-arrived-at shapes agree.
//                         No auth — the manifest itself is not sensitive.
//   GET /stock       -> the one real "data" operation (operationId `stock.get` in openapi.json).
//                        Requires `Authorization: Bearer <ACCEPT_S2_API_TOKEN>` — 401 without it
//                        or with the wrong value, so accept_s2.sh can assert the credential
//                        actually reaches this fixture (via the http gate's ConnectedAccount
//                        credential resolution) and, separately, that the literal token string
//                        never lands in any kernel DB table (S2.13's own acceptance sentence).
//
// ACCEPT_S2_API_TOKEN is required — this fixture refuses to start without it (a token-less fixture
// would make the 401 check meaningless), matching this task's "never hardcode secrets in the repo"
// rule: the value is generated at accept_s2.sh runtime and passed in only via the process
// environment for this one container's lifetime, never written to a file under the repo.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.ACCEPT_S2_API_TOKEN;

if (!TOKEN) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'accept-s2-openapi: ACCEPT_S2_API_TOKEN is not set — refusing to start',
    }),
  );
  process.exit(1);
}

const OPENAPI_DOC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'openapi.json');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function bearerToken(req) {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://accept-s2-openapi.internal');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/openapi.json') {
    try {
      const doc = await readFile(OPENAPI_DOC_PATH, 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(doc),
      });
      res.end(doc);
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err) } });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stock') {
    if (bearerToken(req) !== TOKEN) {
      sendJson(res, 401, { error: { message: 'missing or invalid bearer token' } });
      return;
    }
    sendJson(res, 200, { symbol: 'NXT', quantity: 42, asOf: new Date().toISOString() });
    return;
  }

  sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'accept-s2-openapi: listening', port: PORT }));
});
