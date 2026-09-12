import type { Operation } from '@nexttime/shared';
import { BindingKindMismatchError, TransportInvokeError } from '../errors.js';
import type { Transport, TransportInvokeContext, TransportInvokeResult } from './types.js';
import { boundUntrustedText } from './untrusted-text.js';

/**
 * `mcp` transport (design doc §7.5): proxies an external MCP server over HTTP JSON-RPC (streamable
 * HTTP / plain HTTP POST — the common case for a server-hosted MCP tool provider). stdio-transport
 * MCP servers are documented as **unsupported** here (task brief: "stdio may be left documented as
 * unsupported") — a gate instance backing a stdio MCP server needs a small stdio↔HTTP bridge
 * outside this package, not implemented in S2.4.
 *
 * `importMcpTools` turns a `tools/list` response into a manifest draft: `readOnlyHint` → observe,
 * everything else → execute/medium (design doc §7.5 "readOnlyHint 为 observe，其余 execute").
 */

export interface McpTransportOptions {
  readonly endpoint: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface JsonRpcResponse<T> {
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message: string };
}

export class McpTransport implements Transport {
  readonly kind = 'mcp' as const;
  private readonly options: McpTransportOptions;
  private nextId = 1;

  constructor(options: McpTransportOptions) {
    this.options = options;
  }

  private async call<T>(method: string, params: unknown, credential: unknown): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...credentialHeaders(credential),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TransportInvokeError(`mcp transport: ${method} responded ${response.status}`);
      }
      const body = (await response.json()) as JsonRpcResponse<T>;
      if (body.error) {
        throw new TransportInvokeError(
          `mcp transport: ${method} error: ${boundUntrustedText(body.error.message)}`,
        );
      }
      if (body.result === undefined) {
        throw new TransportInvokeError(`mcp transport: ${method} returned no result`);
      }
      return body.result;
    } catch (err) {
      if (err instanceof TransportInvokeError) throw err;
      throw new TransportInvokeError('mcp transport: request failed', { cause: err });
    } finally {
      clearTimeout(timeout);
    }
  }

  async invoke(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<TransportInvokeResult> {
    if (operation.binding.kind !== 'mcp') {
      throw new BindingKindMismatchError(operation.name, this.kind, operation.binding.kind);
    }
    const data = await this.call(
      'tools/call',
      { name: operation.binding.tool_name, arguments: params ?? {} },
      ctx.credential,
    );
    // Review lane 5, P2-3: `tools/call` returning HTTP 200 with `isError:true` is the MCP spec's
    // own signal that the *tool* failed — that used to be treated as a successful invoke and
    // persisted as a replayable `apply` result (idempotency store) with no signal anything went
    // wrong. Surfaced as a transport failure instead, same as a JSON-RPC-level error above.
    if (isMcpErrorResult(data)) {
      throw new TransportInvokeError(
        `mcp transport: tool "${operation.binding.tool_name}" returned isError:true: ${boundUntrustedText(mcpErrorResultText(data))}`,
      );
    }
    return { data };
  }

  async simulate(
    operation: Operation,
    params: unknown,
    ctx?: TransportInvokeContext,
  ): Promise<{ description: string; detail?: unknown }> {
    void ctx;
    if (operation.binding.kind !== 'mcp') {
      throw new BindingKindMismatchError(operation.name, this.kind, operation.binding.kind);
    }
    return {
      description: `would call MCP tool "${operation.binding.tool_name}"`,
      detail: { toolName: operation.binding.tool_name, arguments: params ?? {} },
    };
  }

  /** `tools/list` — used both by `describe_operations`-adjacent tooling and by
   *  `importMcpTools` callers that want to fetch live instead of passing a cached response. */
  async listTools(credential?: unknown): Promise<McpToolsListResult> {
    return this.call('tools/list', {}, credential);
  }
}

/** MCP `tools/call` results shape their failure as `{isError: true, content: [...]}` on an
 *  otherwise-200 JSON-RPC response — see `invoke`'s own doc comment. */
function isMcpErrorResult(data: unknown): data is { isError: true; content?: unknown } {
  return (
    typeof data === 'object' && data !== null && (data as Record<string, unknown>).isError === true
  );
}

/** Best-effort human-readable text from an `isError:true` result's `content` array (each item
 *  typically `{type:'text', text:'...'}` per the MCP content-block spec); falls back to the raw
 *  JSON when the shape doesn't match. */
function mcpErrorResultText(data: { content?: unknown }): string {
  const content = data.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => (typeof item.text === 'string' ? item.text : JSON.stringify(item)));
    if (texts.length > 0) return texts.join(' ');
  }
  return JSON.stringify(data);
}

function credentialHeaders(credential: unknown): Record<string, string> {
  if (!credential || typeof credential !== 'object') return {};
  const bag = credential as Record<string, unknown>;
  if (typeof bag.token === 'string') return { authorization: `Bearer ${bag.token}` };
  return {};
}

// -------------------------------------------------------------------------------------------
// importMcpTools
// -------------------------------------------------------------------------------------------

export interface McpToolLike {
  readonly name: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
}

export interface McpToolsListResult {
  readonly tools: readonly McpToolLike[];
}

export function importMcpTools(toolsList: McpToolsListResult): Operation[] {
  return toolsList.tools.map((tool) => {
    const mode = tool.annotations?.readOnlyHint ? 'observe' : 'execute';
    return {
      name: tool.name,
      binding: { kind: 'mcp', tool_name: tool.name },
      params_schema: tool.inputSchema ?? {},
      mode,
      blast_radius: mode === 'observe' ? 'low' : 'medium',
      reversibility: false,
      auto_approvable: mode === 'observe',
      await_decision: mode === 'execute',
      reads: [],
      writes: [],
      // P-B1 (design §6.3, cloudflare-os `classifyTool`): keep the three hints verbatim so the
      // kernel's approval decision can apply "vetted ∧ !destructive ∧ idempotent" at decision time.
      ...(tool.annotations?.readOnlyHint !== undefined
        ? { read_only_hint: tool.annotations.readOnlyHint }
        : {}),
      ...(tool.annotations?.destructiveHint !== undefined
        ? { destructive_hint: tool.annotations.destructiveHint }
        : {}),
      ...(tool.annotations?.idempotentHint !== undefined
        ? { idempotent_hint: tool.annotations.idempotentHint }
        : {}),
    };
  });
}
