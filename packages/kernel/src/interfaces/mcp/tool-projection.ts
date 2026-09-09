import type { CapabilityScope, HandleClaims } from '@nexttime/shared';
import { listByChannel } from '@nexttime/shared';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { PoolLike } from '../../adapters/db/pool.js';
import { dispatchCapability } from '../../application/gateway/index.js';
import { type JsonSchemaObject, MCP_TOOL_ALIASES } from './reference-tool-aliases.js';

/**
 * interfaces/mcp/tool-projection: "MCP 工具 = Handle 通道可用行的投影" (design doc §9.3) — builds
 * the `tools/list` result and resolves a `tools/call` name back to a capability dispatch, for one
 * already-authenticated Handle's own `scope`.
 *
 * Three sources, mirroring `packages/platform-extension`'s `modes/{entry,worker}.ts` (the same
 * projection, for a pi tool instead of an MCP tool — this module cannot import that package
 * directly, `.dependency-cruiser.cjs`'s `no-cross-package-internal-import` rule, so the small
 * amount of naming logic they share is independently re-implemented here, not duplicated by
 * reference):
 *
 *   1. **Native tools** — one per literal capability name in `scope.capabilities` (the two dynamic
 *      gate-pattern rows, `<gate>.<op>`/`<gate>.<op>:execute`, are never dispatchable by that
 *      literal name — capabilities.ts's own doc comment — and are excluded here too; they are the
 *      *trigger* for source 3 below, not a tool of their own).
 *   2. **Reference tool-name aliases** (`MCP_TOOL_ALIASES`, the sibling `-aliases.ts` module — see
 *      its own doc comment for the full contract table and why the source name it documents is
 *      never spelled out in this file: design doc §7.10's kernel-purity rule keeps a named
 *      third-party reference confined to exactly one file) — an extra tool under that reference's
 *      own name, whenever its target capability is in scope and the name does not collide with a
 *      native tool already being projected (a real collision never happens with today's 5 aliases
 *      — see that module's own doc comment — this guard is defensive, not load-bearing today).
 *   3. **Gate-projected tools** — one per allowed Gatekeeper Operation (`list_allowed_operations`),
 *      named `<gateName>.<opName>` (sanitized): observe-class via `observe_operation` when
 *      `<gate>.<op>` is in scope (the `entry`/`interactive` ceiling — never execute-class,
 *      structurally, per `governance/capability/handles.ts`'s `entryScope()`), execute-class via
 *      `request_action` when `request_action` is in scope (a Worker-ceiling Handle, mirroring
 *      `platform-extension/modes/worker.ts`'s uniform "always request_action, kernel resolves
 *      mode" behavior — never expected from an `issue_handle`-minted interactive Handle, which can
 *      never hold `request_action`, but handled here for any other Handle kind that connects).
 */

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

interface ResolvedToolCall {
  readonly capability: string;
  readonly params: unknown;
}

export interface McpToolCatalog {
  readonly tools: readonly McpTool[];
  /** Resolves an MCP `tools/call` name to `{capability, params}` for `dispatchCapability`, or
   *  `undefined` if no tool of that name exists in this catalog. */
  resolve(toolName: string, args: Record<string, unknown>): ResolvedToolCall | undefined;
}

const GATE_OBSERVE_PATTERN = '<gate>.<op>';
const GATE_EXECUTE_PATTERN = '<gate>.<op>:execute';

/** provider tool-name charset every major LLM API restricts function/tool names to (no dots) —
 *  same convention `platform-extension/modes/gate-tools.ts` documents and uses; re-implemented
 *  here rather than imported (see this file's own module doc comment). */
function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

interface AllowedOperationWire {
  readonly gatekeeperId: string;
  readonly gateName: string;
  readonly name: string;
  readonly operation: {
    readonly mode?: string;
    readonly description?: string;
    readonly params_schema?: JsonSchemaObject;
    readonly [key: string]: unknown;
  };
}

function gateToolName(op: AllowedOperationWire, usedNames: Set<string>): string {
  const label = `${op.gateName}.${op.name}`;
  let name = sanitizeToolName(label);
  if (usedNames.has(name)) name = sanitizeToolName(`${op.gatekeeperId}.${op.name}`);
  usedNames.add(name);
  return name;
}

function gateToolDescription(op: AllowedOperationWire, name: string): string {
  return typeof op.operation.description === 'string'
    ? op.operation.description
    : `Gatekeeper Operation "${name}" (design doc §7.4/§9.3 gate projection).`;
}

const EMPTY_INPUT_SCHEMA: JsonSchemaObject = { type: 'object', properties: {} };

function toInputSchema(paramsSchema: ZodTypeAny): JsonSchemaObject {
  const jsonSchema = zodToJsonSchema(paramsSchema, { $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  jsonSchema.$schema = undefined;
  if (jsonSchema.type !== 'object') {
    // Every capability's paramsSchema in packages/shared/src/capabilities.ts is a z.object(...)
    // (possibly z.record for the handful of jsonRecord placeholders, which zod-to-json-schema
    // renders as `{type:'object', additionalProperties:true}` — still an object) — this branch is
    // a defensive fallback, not an expected path.
    return EMPTY_INPUT_SCHEMA;
  }
  return jsonSchema as unknown as JsonSchemaObject;
}

async function fetchAllowedOperations(
  pool: PoolLike,
  claims: HandleClaims,
): Promise<readonly AllowedOperationWire[]> {
  if (!claims.scope.capabilities.includes('list_allowed_operations')) return [];
  try {
    const result = (await dispatchCapability(
      { pool },
      { channel: 'handle', claims },
      'list_allowed_operations',
      {},
    )) as { items?: AllowedOperationWire[] };
    return result.items ?? [];
  } catch {
    // Degrade to "no gate tools projected" — same posture platform-extension's own entry.ts
    // takes on a failed list_allowed_operations call (logs and continues with no gate tools),
    // never fails the whole tools/list response over one capability's own error.
    return [];
  }
}

/**
 * Builds the tool catalog for one already-authenticated Handle's `claims`. `deps.pool` is used
 * only to resolve gate-projected tools (`list_allowed_operations`) — building the native/alias
 * tool lists is pure, in-memory work over the shared registry.
 */
export async function buildToolCatalog(
  deps: { readonly pool: PoolLike },
  claims: HandleClaims,
): Promise<McpToolCatalog> {
  const scope: CapabilityScope = claims.scope;
  const scopeCapabilities = new Set(scope.capabilities);

  const tools: McpTool[] = [];
  const resolvers = new Map<string, (args: Record<string, unknown>) => ResolvedToolCall>();
  const nativeNames = new Set<string>();

  // 1. Native tools — every literal, dispatchable capability name in scope.
  for (const capability of listByChannel('handle')) {
    const capabilityName = capability.name;
    if (capabilityName === GATE_OBSERVE_PATTERN || capabilityName === GATE_EXECUTE_PATTERN)
      continue;
    if (!scopeCapabilities.has(capabilityName)) continue;
    tools.push({
      name: capabilityName,
      description: capability.description,
      inputSchema: toInputSchema(capability.paramsSchema),
    });
    nativeNames.add(capabilityName);
    resolvers.set(capabilityName, (args) => ({ capability: capabilityName, params: args }));
  }

  // 2. Reference tool-name aliases — additive, never colliding with a native tool name.
  for (const alias of MCP_TOOL_ALIASES) {
    if (!scopeCapabilities.has(alias.capability)) continue;
    if (nativeNames.has(alias.aliasName)) continue;
    tools.push({
      name: alias.aliasName,
      description: alias.description,
      inputSchema: alias.inputSchema,
    });
    resolvers.set(alias.aliasName, (args) => ({
      capability: alias.capability,
      params: alias.translate(args),
    }));
  }

  // 3. Gate-projected tools — only when the caller's scope actually admits gate access.
  const wantsObserveGates = scopeCapabilities.has(GATE_OBSERVE_PATTERN);
  const wantsExecuteGates = scopeCapabilities.has('request_action');
  if (wantsObserveGates || wantsExecuteGates) {
    const operations = await fetchAllowedOperations(deps.pool, claims);
    const usedNames = new Set<string>(nativeNames);
    for (const op of operations) {
      const isExecute = op.operation.mode === 'execute';
      if (isExecute && !wantsExecuteGates) continue;
      if (!isExecute && !wantsObserveGates) continue;
      const name = gateToolName(op, usedNames);
      tools.push({
        name,
        description: gateToolDescription(op, name),
        inputSchema: op.operation.params_schema ?? EMPTY_INPUT_SCHEMA,
      });
      const targetCapability = isExecute ? 'request_action' : 'observe_operation';
      resolvers.set(name, (args) => ({
        capability: targetCapability,
        params: { gatekeeperId: op.gatekeeperId, operation: op.name, params: args },
      }));
    }
  }

  return {
    tools,
    resolve(toolName, args) {
      return resolvers.get(toolName)?.(args);
    },
  };
}
