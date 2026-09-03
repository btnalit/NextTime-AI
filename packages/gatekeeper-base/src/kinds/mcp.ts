import type { Operation } from '@nexttime/shared';
import { BindingKindMismatchError, TransportInvokeError } from '../errors.js';
import type { Transport, TransportInvokeContext, TransportInvokeResult } from './types.js';

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
        throw new TransportInvokeError(`mcp transport: ${method} error: ${body.error.message}`);
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
  readonly annotations?: { readonly readOnlyHint?: boolean };
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
    };
  });
}
