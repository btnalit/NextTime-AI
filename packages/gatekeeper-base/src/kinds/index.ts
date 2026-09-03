export type {
  Transport,
  TransportKind,
  TransportInvokeContext,
  TransportInvokeResult,
} from './types.js';

export { HttpTransport, importOpenApi } from './http.js';
export type { HttpTransportOptions, OpenApiDocumentLike } from './http.js';

export { McpTransport, importMcpTools } from './mcp.js';
export type { McpTransportOptions, McpToolLike, McpToolsListResult } from './mcp.js';

export { CliTransport, renderCommandTemplate } from './cli.js';
export type { CliTransportOptions, ExecFileFn } from './cli.js';

export { SshTransport, classifyCommand } from './ssh.js';
export type {
  SshTransportOptions,
  SshTarget,
  SshPolicyRule,
  SshClassification,
  SshExecFn,
} from './ssh.js';
