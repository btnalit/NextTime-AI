#!/usr/bin/env node
// accept-s2 mcp fixture: a deterministic test MCP server for the S3.12 acceptance step
// (docs/development-tasks.md S3.12, deliverable "a fixture MCP server for acceptance") — an
// onboarding-wizard "kind: mcp" gate points at this. Plain dependency-free ESM, same convention
// as deploy/accept-s2/openapi-fixture/server.mjs (this directory is not a pnpm workspace package
// either — see that file's own doc comment for why) and deploy/fake-llm/server.mjs.
//
// Minimal MCP JSON-RPC 2.0 over plain HTTP POST — the same shape
// packages/gatekeeper-base/src/kinds/mcp.ts's `McpTransport` speaks (`{jsonrpc, id, method,
// params}` in, `{result}`/`{error}` out) and the same shape
// packages/kernel/src/application/gateway/connection-handlers.ts's `resolveManifestOperations`
// calls directly against `manifestSource` for `kind:'mcp'` (no fronting Gatekeeper process is
// required for the *import* step — only `create_connection`'s optional `connectedAccount` POST
// would need one, and this fixture needs no credential, so `scripts/accept_s2.sh`'s new step
// registers this fixture's own address as both `endpoint` and `manifestSource` and uses
// `credentialKind:'shared'`, which never sends that POST).
//
// Endpoints:
//   GET  /healthz -> {status:"ok"}, no auth (matches the openapi fixture's own convention).
//   POST /        -> JSON-RPC 2.0: initialize, tools/list, tools/call. No auth — this fixture's
//                    two tools carry no sensitive data, unlike the openapi fixture's bearer-token
//                    `/stock` (that fixture's own file header explains why *it* needs auth: to
//                    prove a credential reaches the target through the gate's ConnectedAccount
//                    store). Every unknown method gets a JSON-RPC `-32601 Method not found` error.
//
// Tools (both named with an `accept_s2_mcp_` prefix so `find_operations({need:"accept_s2_mcp"})`
// deterministically matches both, and only both — see importMcpTools, mcp.ts: `readOnlyHint` ->
// mode `observe`, everything else -> mode `execute`):
//   accept_s2_mcp_echo  (readOnlyHint: true  -> observe) — echoes its `text` argument back.
//   accept_s2_mcp_note  (readOnlyHint: false -> execute) — "creates" a note, returns a fake id.

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'accept_s2_mcp_echo',
    description: 'Echoes the given text back — a read-only observe-class fixture tool.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'accept_s2_mcp_note',
    description: 'Creates a fixture note and returns its id — an execute-class fixture tool.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    annotations: { readOnlyHint: false },
  },
];

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function handleToolsCall(id, params) {
  const name = params && typeof params.name === 'string' ? params.name : undefined;
  const args = (params && params.arguments) || {};
  if (name === 'accept_s2_mcp_echo') {
    const text = typeof args.text === 'string' ? args.text : '';
    return jsonRpcResult(id, { content: [{ type: 'text', text: `echo: ${text}` }] });
  }
  if (name === 'accept_s2_mcp_note') {
    const title = typeof args.title === 'string' ? args.title : '';
    const noteId = `note-${Math.random().toString(36).slice(2, 10)}`;
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: `created note ${noteId}: ${title}` }],
    });
  }
  return jsonRpcError(id, -32602, `unknown tool: ${String(name)}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://accept-s2-mcp.internal');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/') {
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 200, jsonRpcError(null, -32700, `parse error: ${String(err)}`));
    return;
  }

  const { id, method, params } = body ?? {};

  if (method === 'initialize') {
    sendJson(
      res,
      200,
      jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'accept-s2-mcp-fixture', version: '1.0.0' },
      }),
    );
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, jsonRpcResult(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    sendJson(res, 200, handleToolsCall(id, params));
    return;
  }

  sendJson(res, 200, jsonRpcError(id, -32601, `method not found: ${String(method)}`));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'accept-s2-mcp: listening', port: PORT }));
});
