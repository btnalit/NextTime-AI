/**
 * governance/gatekeepers/trust: the two pure P-B1 rules both planes apply per call
 * (docs/platform-admin-design.md §6.3; development-tasks.md P-B 决定 ② / ⑤). No IO.
 */

/** `true` when the connector's deny list names this Operation — refused on the very next call
 *  (`request_action` / `observe_operation`) and hidden from the read projections. */
export function isOperationDisabled(
  disabledOperations: readonly string[],
  operationName: string,
): boolean {
  return disabledOperations.includes(operationName);
}

export interface McpTrustInput {
  /** The linked platform gate instance's trust, `undefined` when the workspace connected the MCP
   *  endpoint itself (no `workspace_gate_links` row) — always `byo`. */
  readonly trust: 'byo' | 'vetted' | undefined;
  readonly destructiveHint: boolean | undefined;
  readonly idempotentHint: boolean | undefined;
}

/**
 * cloudflare-os `mcp-shared/src/tools.ts#classifyTool`, not invented here: an execute-class MCP
 * tool may be auto-approved only when the instance is `vetted` **and** the tool declares
 * `destructiveHint: false` **and** `idempotentHint: true`. Missing hints count as "not declared" —
 * the conservative side.
 */
export function mcpAutoApproveAllowed(input: McpTrustInput): boolean {
  return (
    input.trust === 'vetted' && input.destructiveHint === false && input.idempotentHint === true
  );
}
