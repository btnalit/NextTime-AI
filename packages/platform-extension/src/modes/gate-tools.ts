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
    // Present on every real Operation (`@nexttime/shared`'s `OperationSchema` requires it) but
    // typed loosely (via the index signature) rather than as its own required field — same
    // "wire row, read defensively" posture `mode` above already takes.
    readonly blast_radius?: string;
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

/**
 * S5.4 (docs/development-tasks.md S5.4; ops-runner.yaml's own "the tool's own description says
 * which" instruction depends on this): every gate-projected tool's description ends with one
 * sentence naming its mode (observe vs. execute, and what execute-class means — an ActionRequest,
 * not an immediate effect) and, when the Operation carries one, its `blast_radius`. Applied to the
 * manifest description when present, and to the placeholder fallback the same way — a Worker or
 * entry agent reading a tool's description should never have to guess whether calling it is safe.
 */
export function gateToolDescription(op: AllowedOperationWire, label: string): string {
  const base =
    typeof op.operation.description === 'string' && op.operation.description.trim().length > 0
      ? op.operation.description.trim()
      : `Gatekeeper Operation "${label}".`;
  const modeSentence =
    op.operation.mode === 'execute'
      ? 'Execute-class: a governed write — calling it creates an ActionRequest that a human approves before anything happens.'
      : 'Observe-class: read-only, returns data directly.';
  const blastSentence =
    typeof op.operation.blast_radius === 'string'
      ? ` Blast radius: ${op.operation.blast_radius}.`
      : '';
  return `${base} ${modeSentence}${blastSentence}`;
}

// -------------------------------------------------------------------------------------------
// gate tool result truncation (S8 W3-K1, leftover 75 first half, docs/STATUS.md §4 row 75: "门
// 操作原始输出未截断" — a real inventory-scan Worker's own raw gate-tool output alone burned
// ~120k token, 59% of one Task's budget). Shared by `entry` and `worker` mode's own gate-projected
// tool result paths (`modes/worker.ts`'s `buildGateTool`, `modes/entry.ts`'s `buildGateObserveTool`) — the one
// place both modes stringify a gate's raw response for the model.
// -------------------------------------------------------------------------------------------

const DEFAULT_GATE_TOOL_RESULT_MAX_CHARS = 16_000;

/** Reads `NEXTTIME_GATE_TOOL_RESULT_MAX_CHARS` once, at module load (= once per mode's process
 *  start — this package's `NEXTTIME_*` env var convention, `index.ts`'s own `readRequiredEnv`
 *  callers). An unset, unparsable, or non-positive value falls back to the default — a malformed
 *  override is worth ignoring, never worth crashing a Worker/entry container over. */
function resolveGateToolResultMaxChars(): number {
  const raw = process.env.NEXTTIME_GATE_TOOL_RESULT_MAX_CHARS;
  if (!raw) return DEFAULT_GATE_TOOL_RESULT_MAX_CHARS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GATE_TOOL_RESULT_MAX_CHARS;
}

/** The cap this process was started with — computed once, not re-read per call. */
export const GATE_TOOL_RESULT_MAX_CHARS = resolveGateToolResultMaxChars();

/** Keeps the head of `text` up to `maxChars` (default: this process's `GATE_TOOL_RESULT_MAX_CHARS`)
 *  and appends one marker line stating how many characters were omitted and that the full result
 *  is not shown. Text at or under the limit is returned byte-for-byte unchanged (no marker line —
 *  a caller composing further text after this call, e.g. `worker.ts`'s pending-approval guidance
 *  sentence, must be able to tell truncation happened only by comparing lengths, never by a marker
 *  appearing on an untouched result). */
export function truncateToolResult(
  text: string,
  maxChars: number = GATE_TOOL_RESULT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const omittedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${omittedChars} more characters omitted — the full result is not shown ...]`;
}
