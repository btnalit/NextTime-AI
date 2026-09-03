/**
 * Gate tool projection shared by `entry` and `worker` mode: `list_allowed_operations` → one pi
 * tool per Operation, named `<gate>.<op>` (design doc §7.4/§9.3). The two modes differ only in
 * *which* Operations they project and *which* capability the tool calls — a Worker projects every
 * allowed Operation onto `request_action` (the kernel resolves observe vs execute; execute becomes
 * an ActionRequest), an entry agent projects observe-class Operations only onto
 * `observe_operation` (it holds no execute-mode capability at all —
 * governance/capability/handles.ts `entryScope()`).
 */

/** One row of `list_allowed_operations`'s result (application/gateway/worker-result-handler.ts). */
export interface AllowedOperationWire {
  readonly gatekeeperId: string;
  readonly gateName: string;
  readonly name: string;
  readonly operation: {
    readonly mode?: string;
    readonly params_schema?: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
}

/** provider tool-name charset every major LLM API restricts function/tool names to
 *  (`^[a-zA-Z0-9_-]{1,64}$` — no dots) — verified against the vendored provider adapters in
 *  `@earendil-works/pi-coding-agent`'s own bundle (anthropic-messages/openai-completions/bedrock-
 *  converse all sanitize against this exact character class). §7.4's own `<gate>.<op>` naming is
 *  therefore a *display* convention, not a literal wire tool name — `<gate>.<op>` (unsanitized) is
 *  kept as each tool's `label`; the registered `name` is the sanitized form, with a
 *  gatekeeperId-based fallback on collision (two Gatekeepers sharing a `gateName`). Documented
 *  deviation — see docs/development-tasks.md S2.9 "实现说明".
 */
export function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** The `{name, label}` a projected Operation registers under; `usedNames` is the per-session
 *  collision set (mutated). Both modes must use this one function so a scripted model, a runbook,
 *  or an acceptance script can predict the tool name from `<gateName>.<opName>` alone. */
export function gateToolName(
  op: AllowedOperationWire,
  usedNames: Set<string>,
): { readonly name: string; readonly label: string } {
  const label = `${op.gateName}.${op.name}`;
  let name = sanitizeToolName(label);
  if (usedNames.has(name)) {
    name = sanitizeToolName(`${op.gatekeeperId}.${op.name}`);
  }
  usedNames.add(name);
  return { name, label };
}

export function gateToolDescription(op: AllowedOperationWire, label: string): string {
  return typeof op.operation.description === 'string'
    ? op.operation.description
    : `Gatekeeper Operation "${label}" (§7.4/§9.3 gate projection).`;
}
