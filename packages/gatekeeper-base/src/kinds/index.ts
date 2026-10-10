export type {
  Transport,
  TransportKind,
  TransportInvokeContext,
  TransportInvokeResult,
} from './types.js';

export {
  HttpTransport,
  encodePathSegment,
  gateOwnedParamsOf,
  importOpenApi,
  isGateOwnedHeader,
  isGateOwnedQueryParam,
  resolveBindingUrl,
} from './http.js';
export type {
  GateOwnedParam,
  GateOwnedParamLocation,
  HttpTransportOptions,
  OpenApiDocumentLike,
} from './http.js';

export { McpTransport, importMcpTools } from './mcp.js';
export type { McpTransportOptions, McpToolLike, McpToolsListResult } from './mcp.js';

export {
  NO_REDIRECTS,
  isRedirectStatus,
  redirectRefusalMessage,
  redirectTargetForDisplay,
  refuseRedirect,
} from './redirect.js';
export type { RedirectAdvice } from './redirect.js';

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
