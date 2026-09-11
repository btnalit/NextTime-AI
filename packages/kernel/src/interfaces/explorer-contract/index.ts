import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CryptoKey } from 'jose';
import {
  ExplainNodeNotFoundError,
  ForbiddenError,
  type ResolveCallerDeps,
  UnauthorizedError,
  getDecisionChainForExplorer,
  getProvenanceForExplorer,
  getProvenanceReportForExplorer,
  getTemporalBoundsForExplorer,
  getTemporalSnapshotForExplorer,
  listDecisionsForExplorer,
  listGraphEdgesForExplorer,
  listGraphNodesForExplorer,
  loadHandlePublicKeyFor,
  resolveCaller,
  resolveRequestCaller,
  searchGraphForExplorer,
} from '../../application/gateway/index.js';
import {
  WORKSPACE_COOKIE,
  WORKSPACE_HEADER,
  parseCookieHeader,
} from '../../application/identity/index.js';
import {
  type CausalChainResponse,
  type EdgeListResponse,
  type NodeListResponse,
  type ProvenanceEdge,
  type ProvenanceNode,
  type ProvenanceResponse,
  SearchRequestSchema,
  type SearchResultResponse,
  type TemporalBoundsResponse,
  type TemporalSnapshotResponse,
} from './schemas.js';
import {
  toDecisionResponse,
  toEdgeResponse,
  toNodeResponse,
  toProvenanceEdge,
  toProvenanceNode,
} from './wire.js';

/**
 * interfaces/explorer-contract: the nine Explorer endpoints (design doc §9.5, "S3, 只做这些";
 * docs/development-tasks.md §S3.5) — `GET /api/graph/nodes`, `GET /api/graph/edges`, `POST
 * /api/graph/search`, `GET /api/temporal/bounds`, `GET /api/temporal/snapshot`, `GET
 * /api/decisions`, `GET /api/decisions/:id/chain`, `GET /api/provenance`, `GET
 * /api/provenance/report`. Mounted at these exact, unprefixed paths (not `/explorer-api/*`)
 * because that is what the unmodified the reference Explorer static bundle's own `fetch(...)` call
 * sites hard-code (`explorer/build.sh`'s own README: the bundle is never patched to call anything
 * else) — `deploy/caddy/Caddyfile`'s existing `@backend path /api/* ...` matcher already reverse-
 * proxies every one of these to this kernel unchanged; the one Caddyfile addition this task makes
 * is injecting `X-API-Key` on the Explorer's own paths, since the static bundle sends none itself
 * (see that file's own comment).
 *
 * Depends only on the `application`/`governance` service interfaces
 * (`application/gateway/index.js`) — never reaches into `substrate` directly (depcruise
 * `kernel-interfaces-must-not-reach-into-substrate-directly`), same rule `interfaces/http` follows.
 *
 * **Auth**: human channel only, `X-API-Key` (design doc §7.6 "Explorer 是 human 通道客户端，用 API
 * key，不用 Handle") — reuses `resolveCaller` (application/gateway/resolve-caller.ts) by wrapping
 * the header value as a synthetic `Bearer <key>` Authorization value, the exact same function
 * `interfaces/http/capability-route.ts` uses for the ordinary `Authorization: Bearer <key>`
 * header; a caller that somehow resolves to the `handle` channel (a Handle JWT passed as the
 * X-API-Key value — not a real deployment scenario) is still rejected, since Explorer only ever
 * authenticates human API keys. `workspaceId` is always the resolved Principal's own workspace
 * (RLS then scopes every read to it — Ontology objects and other workspaces are never returned,
 * simply because nothing here ever queries them: only `substrate/graph`'s `objects`/`links` and
 * `substrate/epistemic`'s `decisions` ever get read, never `substrate/ontology`).
 *
 * **Never re-enters `dispatchCapability`**: see `explorer-read-service.ts`'s own module doc
 * comment for why that is not a style choice — every capability these reads would otherwise map
 * to is registered `channel: 'handle'`, and `authorizeCapabilityCall` would reject a human caller
 * outright.
 *
 * **Response envelope**: raw JSON matching `explorer/schemas.py` exactly — `{ok,result}` is this
 * codebase's *own* capability-result envelope (`packages/shared/src/http.ts`,
 * `interfaces/http/capability-route.ts`); Explorer is a foreign wire contract we mirror, so
 * `GET /api/decisions` deliberately returns a bare array (not `{items}`) — see that route's own
 * comment — matching what `DecisionWorkspace.tsx`'s `setDecisions(data)` expects.
 *
 * **207 partial success**: only `/api/decisions/:id/chain` uses it (design doc §9.5's own
 * convention, mirrored from the reference Explorer's `analytics.py` precedent) — see
 * `getDecisionChainForExplorer`'s own doc comment for exactly which sub-reads can fail
 * independently.
 */

/** S4.1: the console session cookie (application/identity) replaced the W7 Explorer-only cookie,
 *  so this route tree no longer mints anything — `ResolveCallerDeps` is all it needs. Kept as a
 *  distinct alias so the two route trees' dependency contracts can still diverge later. */
export type ExplorerRouteDeps = ResolveCallerDeps;

interface ExplorerCaller {
  readonly workspaceId: string;
  readonly principalId: string;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function queryParam(request: FastifyRequest, key: string): string | undefined {
  const query = request.query as Record<string, string | string[] | undefined>;
  const raw = firstQueryValue(query[key]);
  return raw === undefined || raw === '' ? undefined : raw;
}

function queryNumber(request: FastifyRequest, key: string): number | undefined {
  const raw = queryParam(request, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractApiKey(request: FastifyRequest): string | undefined {
  return firstQueryValue(request.headers['x-api-key'] as string | string[] | undefined);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Two credentials, checked in this order:
 *   1. `X-API-Key` (a script, curl, scripts/accept_s3.sh's driver) -> `resolveCaller`'s own
 *      `Authorization: Bearer <token>` contract; must resolve to the human channel.
 *   2. Otherwise the console session cookie (S4.1, application/identity/console-session.ts —
 *      the same cookie the console itself holds after `POST /api/auth/login`; it replaced W7's
 *      Explorer-only cookie) -> user -> that user's membership Principal in the workspace named
 *      by `X-Workspace-Id`, the `nexttime_workspace` selector cookie the console sets, or the
 *      user's only membership. The Explorer bundle is an unmodified third-party UI that cannot add
 *      headers, which is what the selector cookie is for.
 * An explicit header always wins over the ambient cookie — a caller that sends a key means it,
 * and a wrong key must not silently succeed via a cookie left over from someone else's login in
 * the same browser profile. These are reads (the one POST, `/api/graph/search`, is a read with a
 * body), so the CSRF header is not required here. Throws `UnauthorizedError`/`ForbiddenError`
 * for everything else.
 */
async function authenticateExplorerCaller(
  request: FastifyRequest,
  deps: ExplorerRouteDeps,
): Promise<ExplorerCaller> {
  const apiKey = extractApiKey(request);
  if (apiKey) {
    const caller = await resolveCaller(`Bearer ${apiKey}`, deps);
    if (caller.channel !== 'human') {
      throw new UnauthorizedError('Explorer requires a human API key, not a Handle');
    }
    return { workspaceId: caller.principal.workspaceId, principalId: caller.principal.id };
  }

  const caller = await resolveRequestCaller(
    {
      cookie: request.headers.cookie,
      workspaceId:
        firstHeader(request.headers[WORKSPACE_HEADER]) ??
        parseCookieHeader(request.headers.cookie).get(WORKSPACE_COOKIE),
      requireCsrfHeader: false,
    },
    deps,
  );
  if (caller.channel !== 'human') throw new UnauthorizedError('Explorer requires a human caller');
  return { workspaceId: caller.principal.workspaceId, principalId: caller.principal.id };
}

/** FastAPI's default `HTTPException` body shape (`{"detail": "..."}`) — several Explorer
 *  workspaces read `.detail` on a non-2xx response (`explorer/src/workspaces/*`'s own fetch error
 *  handling, e.g. `OntologyLoader.tsx`); Graph/Decision/Lineage's own error handling only checks
 *  `response.ok`/`response.status` today but there is no reason to send a different shape than the
 *  upstream backend itself would. */
function sendDetail(reply: FastifyReply, status: number, detail: string): { detail: string } {
  reply.code(status);
  return { detail };
}

type Handler = (
  request: FastifyRequest,
  reply: FastifyReply,
  caller: ExplorerCaller,
) => Promise<unknown>;

/** Wraps one route: authenticate (401 on failure), run `fn`, map `ExplainNodeNotFoundError` to
 *  404 and anything else to a generic 500 — never leaks an internal error message to the client,
 *  same convention `interfaces/http/capability-route.ts`'s `mapCapabilityError` follows. */
function guarded(deps: ExplorerRouteDeps, routeName: string, fn: Handler) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    let caller: ExplorerCaller;
    try {
      caller = await authenticateExplorerCaller(request, deps);
    } catch (err) {
      // S4.1: a valid console session without a usable workspace (none selected and several
      // memberships, or no membership in the selected one) is a 403, not a credentials problem.
      if (err instanceof ForbiddenError) return sendDetail(reply, 403, err.message);
      return sendDetail(
        reply,
        401,
        'Invalid or missing credentials. Send an API key as the X-API-Key header, or sign in to the console first.',
      );
    }

    try {
      return await fn(request, reply, caller);
    } catch (err) {
      if (err instanceof ExplainNodeNotFoundError) {
        return sendDetail(reply, 404, err.message);
      }
      request.log.error({
        route: routeName,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return sendDetail(reply, 500, 'internal error');
    }
  };
}

const MAX_FILENAME_ID_LEN = 128;

/** Mirrors `explorer/routes/provenance.py`'s own `_safe_content_disposition_filename` — strips
 *  CR/LF/NUL/quote/backslash (CWE-113 header injection) and length-caps the result. Deliberately
 *  not a single regex with literal control-character escapes (biome's
 *  `noControlCharactersInRegex`): one `replaceAll` per unsafe character avoids the lint entirely
 *  without a suppression comment. */
function safeContentDispositionFilename(nodeId: string, suffix: string): string {
  const sanitized = nodeId
    .replaceAll('\r', '_')
    .replaceAll('\n', '_')
    .replaceAll('\0', '_')
    .replaceAll('"', '_')
    .replaceAll('\\', '_')
    .slice(0, MAX_FILENAME_ID_LEN);
  return `${sanitized}${suffix}`;
}

function renderMarkdownReport(report: {
  readonly nodeId: string;
  readonly label: string;
  readonly type: string;
  readonly graph: {
    readonly nodes: readonly ProvenanceNode[];
    readonly edges: readonly ProvenanceEdge[];
  };
}): string {
  const lines: string[] = [
    `# Provenance Report: ${report.label}`,
    '',
    `- Node ID: \`${report.nodeId}\``,
    `- Type: \`${report.type}\``,
    '',
    '## Lineage Nodes',
  ];
  for (const node of report.graph.nodes) {
    let line = `- \`${node.id}\` (${node.prov_type}): ${node.label}`;
    if (node.source_document) line += ` [source: ${node.source_document}]`;
    lines.push(line);
  }
  const byDirection: Record<string, string[]> = { upstream: [], downstream: [] };
  for (const edge of report.graph.edges) {
    const bucket = byDirection[edge.direction];
    const target = bucket ?? [];
    target.push(`- \`${edge.source}\` -[${edge.label}]-> \`${edge.target}\``);
    byDirection[edge.direction] = target;
  }
  for (const direction of ['upstream', 'downstream'] as const) {
    const entries = byDirection[direction];
    if (entries && entries.length > 0) {
      const heading = direction === 'upstream' ? 'Upstream' : 'Downstream';
      lines.push('', `## ${heading}`, ...entries);
    }
  }
  return lines.join('\n');
}

export function registerExplorerRoutes(app: FastifyInstance, deps: ExplorerRouteDeps): void {
  // W7's `POST`/`DELETE /api/explorer/session` were retired in S4.1: the console session cookie
  // (`POST /api/auth/login`, interfaces/http/auth-routes.ts) now authenticates these routes.

  app.get(
    '/api/graph/nodes',
    guarded(deps, 'graph.nodes', async (request, _reply, caller) => {
      const page = await listGraphNodesForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
        {
          type: queryParam(request, 'type'),
          search: queryParam(request, 'search'),
          limit: queryNumber(request, 'limit'),
          cursor: queryParam(request, 'cursor'),
          skip: queryNumber(request, 'skip'),
        },
      );
      const body: NodeListResponse = {
        nodes: page.items.map(toNodeResponse),
        total: page.total,
        skip: page.skip,
        limit: page.limit,
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
      };
      return body;
    }),
  );

  app.get(
    '/api/graph/edges',
    guarded(deps, 'graph.edges', async (request, _reply, caller) => {
      const page = await listGraphEdgesForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
        {
          type: queryParam(request, 'type'),
          source: queryParam(request, 'source'),
          target: queryParam(request, 'target'),
          limit: queryNumber(request, 'limit'),
          cursor: queryParam(request, 'cursor'),
          skip: queryNumber(request, 'skip'),
        },
      );
      const body: EdgeListResponse = {
        edges: page.items.map(toEdgeResponse),
        total: page.total,
        skip: page.skip,
        limit: page.limit,
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
      };
      return body;
    }),
  );

  app.post(
    '/api/graph/search',
    guarded(deps, 'graph.search', async (request, reply, caller) => {
      const parsed = SearchRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendDetail(reply, 400, 'invalid search request body');

      const objectType =
        typeof parsed.data.filters?.objectType === 'string'
          ? parsed.data.filters.objectType
          : undefined;
      const { results, total } = await searchGraphForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
        {
          query: parsed.data.query,
          objectType,
          limit: parsed.data.limit,
        },
      );
      const body: SearchResultResponse = {
        results: results.map((item) => ({ node: toNodeResponse(item.node), score: item.score })),
        total,
        query: parsed.data.query,
      };
      return body;
    }),
  );

  app.get(
    '/api/temporal/bounds',
    guarded(deps, 'temporal.bounds', async (_request, _reply, caller) => {
      const bounds = await getTemporalBoundsForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
      );
      const body: TemporalBoundsResponse = {
        min: bounds.min ? bounds.min.toISOString() : null,
        max: bounds.max ? bounds.max.toISOString() : null,
      };
      return body;
    }),
  );

  app.get(
    '/api/temporal/snapshot',
    guarded(deps, 'temporal.snapshot', async (request, _reply, caller) => {
      const at = queryParam(request, 'at');
      const result = await getTemporalSnapshotForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
        {
          at: at ? new Date(at) : undefined,
        },
      );
      const body: TemporalSnapshotResponse = {
        timestamp: result.at.toISOString(),
        active_node_ids: [...result.activeObjectIds],
        active_node_count: result.activeObjectIds.length,
      };
      return body;
    }),
  );

  app.get(
    '/api/decisions',
    guarded(deps, 'decisions.list', async (request, _reply, caller) => {
      const rows = await listDecisionsForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
        {
          category: queryParam(request, 'category'),
          skip: queryNumber(request, 'skip'),
          limit: queryNumber(request, 'limit'),
        },
      );
      // Bare array — see this module's own doc comment ("Response envelope").
      return rows.map(toDecisionResponse);
    }),
  );

  app.get(
    '/api/decisions/:id/chain',
    guarded(deps, 'decisions.chain', async (request, reply, caller) => {
      const { id } = request.params as { id: string };
      const result = await getDecisionChainForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
        {
          decisionId: id,
          depth: queryNumber(request, 'depth'),
        },
      );
      if (result.partial) reply.code(207);
      const body: CausalChainResponse = {
        decision_id: result.decisionId,
        chain: [...result.chain],
        ...(result.partial
          ? { message: `Partial success: ${result.failedSources.join(', ')} failed to load.` }
          : {}),
      };
      return body;
    }),
  );

  app.get(
    '/api/provenance',
    guarded(deps, 'provenance.get', async (request, _reply, caller) => {
      const nodeId = queryParam(request, 'node_id');
      const result = await getProvenanceForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
        { nodeId },
      );
      const body: ProvenanceResponse = {
        nodes: result.graph.nodes.map(toProvenanceNode),
        edges: result.graph.edges.map(toProvenanceEdge),
        source: result.source,
      };
      return body;
    }),
  );

  app.get(
    '/api/provenance/report',
    guarded(deps, 'provenance.report', async (request, reply, caller) => {
      const nodeId = queryParam(request, 'node_id');
      if (!nodeId) return sendDetail(reply, 400, 'node_id is required');
      const format = (queryParam(request, 'format') ?? 'json').toLowerCase();

      const report = await getProvenanceReportForExplorer(
        deps.pool,
        caller.workspaceId,
        caller.principalId,
        {
          nodeId,
        },
      );
      const nodes = report.graph.nodes.map(toProvenanceNode);
      const edges = report.graph.edges.map(toProvenanceEdge);

      if (format === 'md' || format === 'markdown') {
        reply.header('Content-Type', 'text/plain; charset=utf-8');
        reply.header(
          'Content-Disposition',
          `attachment; filename="${safeContentDispositionFilename(nodeId, '_provenance.md')}"`,
        );
        return renderMarkdownReport({
          nodeId: report.nodeId,
          label: report.label,
          type: report.type,
          graph: { nodes, edges },
        });
      }

      reply.header('Content-Type', 'application/json');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${safeContentDispositionFilename(nodeId, '_provenance.json')}"`,
      );
      return { node_id: report.nodeId, label: report.label, type: report.type, nodes, edges };
    }),
  );
}
