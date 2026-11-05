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
//   GET /stock       -> the stock reading (operationId `stock.get` in openapi.json).
//                        Requires `Authorization: Bearer <ACCEPT_S2_API_TOKEN>` — 401 without it
//                        or with the wrong value, so accept_s2.sh can assert the credential
//                        actually reaches this fixture (via the http gate's ConnectedAccount
//                        credential resolution) and, separately, that the literal token string
//                        never lands in any kernel DB table (S2.13's own acceptance sentence).
//   GET  /ledger/{key} -> `ledger.get`: {key, count}, how many entries the ledger holds under
//   POST /ledger/{key}    `key`; `ledger.add` adds one and answers the new count. The ledger is
//                         the gate-side record of how many times a governed write ran: S11 GO7a's
//                         goal scenarios in scripts/lib/accept-s2-goals.sh count each action's
//                         executions there (an approved action ran exactly once, a rejected one
//                         never). In memory, one fixture run's lifetime; same bearer token as
//                         /stock. `key` is one path segment of letters, digits, `_` and `-`.
//                         A POST under a key starting `lose-` adds its entry and then drops the
//                         connection without answering: the write took effect, its response is
//                         lost (S11 GO7a S4). The gate cannot tell whether it ran, records the
//                         call as outcome unknown and answers every repeat of it the same way, so
//                         the platform has to reconcile by observing the ledger.
//   GET  /tickets/openapi.json -> S11 AA5c: the ticket system's own OpenAPI document
//                         (tickets-openapi.json next to this file) — the second "system" this
//                         fixture plays, for the admin agent journey (scripts/lib/
//                         accept-s2-admin-agent-tickets.sh, AA5 plan §5.8): `tickets.list`,
//                         `tickets.get` (observe) and `tickets.create` (execute). No auth.
//   GET  /tickets          -> `tickets.list`: {items, readBy}, every ticket, oldest first, and which
//                         of the two credentials below read them (`trial` / `production`) — so a
//                         read through a gate shows which credential that gate holds without
//                         opening a ticket.
//   GET  /tickets/{id}     -> `tickets.get`: one ticket, 404 when there is none.
//   POST /tickets          -> `tickets.create`: body {title, priority?}; opens a ticket and answers
//                         it, 201. A title that is not a 1–200 character string, or a priority
//                         other than low / normal / high, is a 400 and opens nothing.
//                         The book starts with two tickets (`T-1001`, `T-1002`) and lives in
//                         memory for one fixture run, like the ledger. Same bearer token as /stock;
//                         ACCEPT_S2_TICKETS_PROD_TOKEN, when set, is accepted too — the journey's
//                         "production" credential, kept apart from the trial one so it can tell
//                         which gate opened a ticket: each ticket records `via` (`trial` for
//                         ACCEPT_S2_API_TOKEN, `production` for the other) and `GET /tickets`
//                         lists it.
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
/** S11 AA5c: the ticket system's second accepted token (header) — empty when not set. */
const TICKETS_PROD_TOKEN = process.env.ACCEPT_S2_TICKETS_PROD_TOKEN ?? '';

if (!TOKEN) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'accept-s2-openapi: ACCEPT_S2_API_TOKEN is not set — refusing to start',
    }),
  );
  process.exit(1);
}

/** `ledger.get` / `ledger.add`'s state: entries per key. */
const ledger = new Map();
const LEDGER_PATH = /^\/ledger\/([A-Za-z0-9_-]{1,64})$/;

const OPENAPI_DOC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'openapi.json');
const TICKETS_DOC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'tickets-openapi.json');

/** S11 AA5c: the ticket book (header). */
const tickets = [
  {
    id: 'T-1001',
    title: 'VPN drops every hour on the 3rd floor',
    priority: 'high',
    status: 'open',
    via: 'seed',
    createdAt: '2026-11-01T09:00:00.000Z',
  },
  {
    id: 'T-1002',
    title: 'Printer in room 214 jams on duplex',
    priority: 'normal',
    status: 'open',
    via: 'seed',
    createdAt: '2026-11-02T14:30:00.000Z',
  },
];
let nextTicketNumber = 1003;
const TICKET_PATH = /^\/tickets\/([A-Za-z0-9_-]{1,64})$/;
const PRIORITIES = new Set(['low', 'normal', 'high']);
/** The largest body `POST /tickets` reads. */
const MAX_TICKET_BODY_BYTES = 8 * 1024;

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

/** S11 AA5c: which of the ticket system's credentials `req` carries — `trial`, `production`, or
 *  `undefined` for none. */
function ticketsCaller(req) {
  const token = bearerToken(req);
  if (token === undefined) return undefined;
  if (token === TOKEN) return 'trial';
  if (TICKETS_PROD_TOKEN !== '' && token === TICKETS_PROD_TOKEN) return 'production';
  return undefined;
}

/** The request's body as JSON — `undefined` when it is not JSON or is larger than `limit`. */
function readJsonBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) over = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

async function serveTickets(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/tickets/openapi.json') {
    try {
      const doc = await readFile(TICKETS_DOC_PATH, 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(doc),
      });
      res.end(doc);
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err) } });
    }
    return true;
  }
  const isList = url.pathname === '/tickets';
  const ticketId = TICKET_PATH.exec(url.pathname)?.[1];
  if (!isList && ticketId === undefined) return false;
  if (!(req.method === 'GET' || (isList && req.method === 'POST'))) return false;
  const via = ticketsCaller(req);
  if (via === undefined) {
    sendJson(res, 401, { error: { message: 'missing or invalid bearer token' } });
    return true;
  }
  if (req.method === 'GET' && isList) {
    sendJson(res, 200, { items: tickets, readBy: via });
    return true;
  }
  if (req.method === 'GET') {
    const ticket = tickets.find((t) => t.id === ticketId);
    if (ticket === undefined) sendJson(res, 404, { error: { message: `no ticket ${ticketId}` } });
    else sendJson(res, 200, ticket);
    return true;
  }
  const body = await readJsonBody(req, MAX_TICKET_BODY_BYTES);
  const title = body?.title;
  const priority = body?.priority ?? 'normal';
  if (typeof title !== 'string' || title.length < 1 || title.length > 200 || !PRIORITIES.has(priority)) {
    sendJson(res, 400, {
      error: { message: 'a ticket takes a title of 1-200 characters and a priority of low, normal or high' },
    });
    return true;
  }
  const ticket = {
    id: `T-${nextTicketNumber++}`,
    title,
    priority,
    status: 'open',
    via,
    createdAt: new Date().toISOString(),
  };
  tickets.push(ticket);
  sendJson(res, 201, ticket);
  return true;
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

  if (url.pathname === '/tickets' || url.pathname.startsWith('/tickets/')) {
    if (await serveTickets(req, res, url)) return;
  }

  const ledgerKey = LEDGER_PATH.exec(url.pathname)?.[1];
  if (ledgerKey !== undefined && (req.method === 'GET' || req.method === 'POST')) {
    if (bearerToken(req) !== TOKEN) {
      sendJson(res, 401, { error: { message: 'missing or invalid bearer token' } });
      return;
    }
    if (req.method === 'POST') ledger.set(ledgerKey, (ledger.get(ledgerKey) ?? 0) + 1);
    if (req.method === 'POST' && ledgerKey.startsWith('lose-')) {
      req.socket.destroy();
      return;
    }
    sendJson(res, 200, { key: ledgerKey, count: ledger.get(ledgerKey) ?? 0 });
    return;
  }

  sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'accept-s2-openapi: listening', port: PORT }));
});
