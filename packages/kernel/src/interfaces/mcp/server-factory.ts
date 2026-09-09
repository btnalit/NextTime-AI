import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { HandleClaims } from '@nexttime/shared';
import type { PoolLike } from '../../adapters/db/pool.js';
import {
  CapabilityNotFoundError,
  CapabilityNotImplementedError,
  ForbiddenError,
  InvalidCapabilityParamsError,
  dispatchCapability,
} from '../../application/gateway/index.js';
import type { McpToolCatalog } from './tool-projection.js';

/**
 * interfaces/mcp/server-factory: builds one MCP `Server` instance (the low-level SDK class — see
 * this module's own reasoning below for why, not `McpServer`) wired to `dispatchCapability` for a
 * single already-authenticated Handle's `claims` and pre-built tool catalog. Split out of
 * `index.ts` (which owns the Fastify/HTTP transport wiring) so this MCP-protocol-level piece is
 * independently testable against the SDK's own `InMemoryTransport` — no Fastify, no real HTTP
 * listener, no database (`server-factory.test.ts`), which matters on a host with no local
 * Postgres: the DB-gated `index.test.ts` end-to-end suite proves the HTTP/auth wiring for real
 * once a Postgres is available (CI), while this file's own tests prove the JSON-RPC/tool-catalog
 * wiring on every run, everywhere.
 *
 * **Why the low-level `Server` class, not `McpServer`:** `McpServer.registerTool`'s `inputSchema`
 * wants a Zod raw shape (`Record<string, ZodTypeAny>`) or a `AnySchema`, not an arbitrary JSON
 * Schema object — but this module's tools are a heterogeneous mix (capability `paramsSchema`
 * Zod objects converted via `zod-to-json-schema`, hand-authored reference-tool-alias JSON Schemas,
 * and a Gatekeeper Operation's own already-JSON-Schema `params_schema`, `tool-projection.ts`).
 * Normalizing all three into one JSON-Schema shape and implementing `tools/list`/`tools/call`
 * directly (`ListToolsRequestSchema`/`CallToolRequestSchema`) is the same approach
 * `platform-extension`'s pi tool registration already takes for its own heterogeneous tool
 * sources — this is exactly the "advanced use case" the `Server` class's own doc comment
 * (`@deprecated Use McpServer instead for the high-level API. Only use Server for advanced use
 * cases.`) describes, not an accidental use of a deprecated API.
 */

const MCP_SERVER_NAME = 'nexttime-kernel';
const MCP_SERVER_VERSION = '0.1.0';

/** Maps a `dispatchCapability` failure to an MCP `CallToolResult` with `isError:true` — the tool-
 *  call equivalent of `interfaces/http/capability-route.ts`'s `mapCapabilityError`, but far
 *  shorter: a tool result only needs a readable message for the calling agent, not a wire-stable
 *  HTTP status/code pair (nothing parses `tools/call` error text programmatically the way an HTTP
 *  client branches on `error.code`). The four capability-dispatch error classes get a short,
 *  stable prefix; every other error (an unmapped domain error from inside a handler — e.g. a
 *  Fact-not-found) falls through to its own `.message`, which is already a readable sentence in
 *  this codebase's conventions (every thrown error here is authored for a human to read, not a
 *  machine to parse). */
export function mapCapabilityErrorToToolResult(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof CapabilityNotFoundError) message = `not_found: ${err.message}`;
  else if (err instanceof InvalidCapabilityParamsError) message = `invalid_params: ${err.message}`;
  else if (err instanceof CapabilityNotImplementedError)
    message = `not_implemented: ${err.message}`;
  else if (err instanceof ForbiddenError) message = `forbidden: ${err.message}`;
  else message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Builds one MCP `Server` for `claims`/`catalog` — never connected to a transport by this
 *  function; the caller (`index.ts`'s per-request handler, or a test's `InMemoryTransport`) owns
 *  `server.connect(transport)` and `server.close()`. */
export function buildMcpServer(
  pool: PoolLike,
  claims: HandleClaims,
  catalog: McpToolCatalog,
): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const resolved = catalog.resolve(toolName, args);
    if (!resolved) {
      return { content: [{ type: 'text', text: `unknown tool "${toolName}"` }], isError: true };
    }
    try {
      const result = await dispatchCapability(
        { pool },
        { channel: 'handle', claims },
        resolved.capability,
        resolved.params,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return mapCapabilityErrorToToolResult(err);
    }
  });

  return server;
}
