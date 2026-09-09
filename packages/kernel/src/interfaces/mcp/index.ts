import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HandleClaims } from '@nexttime/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CryptoKey } from 'jose';
import type { PoolLike } from '../../adapters/db/pool.js';
import { authenticateHandle } from '../../application/gateway/index.js';
import {
  HandleExpired,
  HandleInvalid,
  HandleRevoked,
  loadHandleKeyPair,
} from '../../governance/capability/index.js';
import {
  DEFAULT_MCP_RATE_LIMIT,
  DEFAULT_MCP_RATE_WINDOW_MS,
  PerHandleRateLimiter,
} from './rate-limiter.js';
import { buildMcpServer } from './server-factory.js';
import { buildToolCatalog } from './tool-projection.js';

/**
 * interfaces/mcp: MCP TS SDK server, streamable HTTP transport, mounted at `POST /mcp` (design doc
 * §7.1, §7.4, §9.3; docs/development-tasks.md S3.6/W2-B). Depends only on the application and
 * governance layers' service interfaces — never reaches into substrate directly (depcruise
 * `kernel-interfaces-must-not-reach-into-substrate-directly`).
 *
 * **Auth: Handle channel only, no API key.** This route deliberately does *not* call `application/
 * gateway`'s `resolveCaller` (which tries an API key first, then a Handle) — an MCP client is by
 * definition an external tool/agent process (Claude Code, a developer's local `pi`, §7.4
 * "interactive"), never the human web console, so a Bearer token here is authenticated as a
 * CapabilityHandle only (`authenticateHandle`, the same primitive `resolve-caller.ts`'s own Handle
 * branch uses) — a valid API key presented here is simply not a recognized credential and 401s the
 * same as a garbage token. Missing header, malformed Bearer scheme, or a Handle that fails
 * signature/expiry/revocation verification (`HandleExpired`/`HandleRevoked`/`HandleInvalid`) all
 * map to 401, before the MCP/JSON-RPC layer is ever engaged — the same "decided before dispatch"
 * posture `interfaces/http/capability-route.ts` and `interfaces/ws/rpc.ts` already have for their
 * own auth failures. Any *other* error (e.g. the database is unreachable) is a 500, not a 401 —
 * conflating the two would misreport a real outage as "your credential is bad".
 *
 * **Stateless per the MCP SDK's own documented pattern** (`StreamableHTTPServerTransportOptions`'s
 * own JSDoc: "Stateless mode - explicitly set session ID to undefined ... good for simple
 * API-style servers"): a fresh `Server` + `StreamableHTTPServerTransport` is built for *every* HTTP
 * request, tools/list and tools/call included — never a session map keyed by `mcp-session-id`.
 * This is the right shape here specifically because every tool call is already a fully
 * self-contained `dispatchCapability` call (no server-side conversation state to preserve across
 * requests), and it means every single request re-authenticates and rebuilds the tool catalog from
 * the Handle's *current* scope — a revoked-mid-session Handle or a Grant change takes effect on the
 * caller's very next call, not only once some cached session expires.
 *
 * Tools are generated from `tool-projection.ts` (the shared-registry projection + the reference
 * tool-name alias table, `reference-tool-aliases.ts`) for the connecting Handle's own `scope` —
 * `tools/list` is therefore always exactly that Handle's own allowed set, never the platform's
 * full registry.
 */

/** A tool-call body should never need more than this — same order of magnitude as the largest
 *  capability params this kernel accepts elsewhere (no other route declares an explicit
 *  `bodyLimit`; this is the first one that needs to, being the first surface reachable by an
 *  arbitrary external process — see rate-limiter.ts's own doc comment for the fuller "why /mcp is
 *  different" reasoning). */
const MCP_BODY_LIMIT_BYTES = 1_048_576;

export interface McpRouteDeps {
  readonly pool: PoolLike;
  /** Same injection point `interfaces/http`/`interfaces/ws` already accept (`ResolveCallerDeps`)
   *  — a `CapabilityRouteDeps`/`WsRouteDeps` value the composition root already built is directly
   *  usable here with no adaptation. Defaults to a cached call to `governance/capability/keys.ts`'s
   *  `loadHandleKeyPair()`. */
  readonly loadHandlePublicKey?: () => Promise<CryptoKey>;
  /** Overrides the default per-Handle rate limiter — tests only. */
  readonly rateLimiter?: PerHandleRateLimiter;
}

// Module-level cache for the default key loader, independent of (not shared with)
// `application/gateway/resolve-caller.ts`'s own identically-shaped private cache — this module
// does not own that file and cannot import its private loader; see this file's own module doc
// comment on why a small amount of duplication across module-ownership boundaries is the right
// call here, not a shared helper. Reset on failure so a later request can retry (e.g. secrets
// mounted after the first request arrives).
let cachedPublicKeyPromise: Promise<CryptoKey> | undefined;

async function defaultLoadHandlePublicKey(): Promise<CryptoKey> {
  if (!cachedPublicKeyPromise) {
    cachedPublicKeyPromise = loadHandleKeyPair()
      .then((keyPair) => keyPair.publicKey)
      .catch((err: unknown) => {
        cachedPublicKeyPromise = undefined;
        throw err;
      });
  }
  return cachedPublicKeyPromise;
}

type AuthResult =
  | { readonly ok: true; readonly claims: HandleClaims }
  | { readonly ok: false; readonly status: 401 | 500 };

/** Bearer-token parsing, independently re-implemented from `resolve-caller.ts`'s private
 *  `parseBearerToken` for the same module-ownership reason as the public-key cache above. */
function parseBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1]?.trim();
}

async function resolveHandleClaims(
  request: FastifyRequest,
  deps: McpRouteDeps,
): Promise<AuthResult> {
  const token = parseBearerToken(request.headers.authorization);
  if (!token) return { ok: false, status: 401 };

  try {
    const publicKey = await (deps.loadHandlePublicKey ?? defaultLoadHandlePublicKey)();
    const claims = await authenticateHandle(deps.pool, token, { publicKey });
    return { ok: true, claims };
  } catch (err) {
    if (
      err instanceof HandleExpired ||
      err instanceof HandleRevoked ||
      err instanceof HandleInvalid
    ) {
      return { ok: false, status: 401 };
    }
    request.log.error({ err }, 'interfaces/mcp: unexpected error verifying Handle');
    return { ok: false, status: 500 };
  }
}

function sendPlainError(reply: FastifyReply, status: number, error: string): void {
  reply.code(status).send({ error });
}

/** Registers `POST /mcp` (+ `GET`/`DELETE /mcp` → 405, this transport supports neither server-push
 *  SSE nor session termination — stateless, see this file's own module doc comment) on `app`. */
export function registerMcpRoute(app: FastifyInstance, deps: McpRouteDeps): void {
  const rateLimiter =
    deps.rateLimiter ??
    new PerHandleRateLimiter({
      limit: DEFAULT_MCP_RATE_LIMIT,
      windowMs: DEFAULT_MCP_RATE_WINDOW_MS,
    });

  app.post('/mcp', { bodyLimit: MCP_BODY_LIMIT_BYTES }, async (request, reply) => {
    const authResult = await resolveHandleClaims(request, deps);
    if (!authResult.ok) {
      sendPlainError(
        reply,
        authResult.status,
        authResult.status === 401 ? 'unauthorized' : 'internal_error',
      );
      return;
    }
    const { claims } = authResult;

    if (!rateLimiter.tryConsume(claims.jti)) {
      sendPlainError(reply, 429, 'rate_limited');
      return;
    }

    const catalog = await buildToolCatalog({ pool: deps.pool }, claims);
    const server = buildMcpServer(deps.pool, claims, catalog);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Hands the raw Node req/res to the SDK transport — Fastify must not also try to write its own
    // response for this request (same `hijack()` contract every raw-response-writing route in this
    // codebase would need; none exists yet, this is the first).
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      // `request.body` is Fastify's already-parsed JSON body (its default `application/json`
      // content-type parser) — passed as `parsedBody`, matching the SDK's own documented
      // pre-parsed-body usage (this file's own module doc comment), so the transport never tries
      // to re-read the (already-consumed) request stream itself.
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, 'interfaces/mcp: request handling failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'internal error' },
          }),
        );
      } else {
        reply.raw.end();
      }
    }
  });

  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.code(405).header('allow', 'POST').send();
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
