/**
 * gate-tool-name: the one rule every consumer of `list_allowed_operations` names a gate-projected
 * tool by — the kernel's MCP projection (`kernel/src/interfaces/mcp/tool-projection.ts`) and the
 * pi extension's modes (`platform-extension/src/modes/gate-tools.ts`). Both used to carry their own
 * copy; one function here keeps them from drifting (legacy 768).
 *
 * A tool name must match `^[a-zA-Z0-9_-]{1,64}$` (every major LLM API restricts tool names to it;
 * no dots), so `<gate>.<op>` — the design doc's display convention (§7.4 / §9.3) — is sanitized
 * into one, and kept as the tool's label. Names are handed out first come, first served in list
 * order (`list_allowed_operations` lists gates in registration order and each gate's Operations by
 * name, legacy 144), so the same list always yields the same names.
 */

/** The longest tool name the LLM APIs accept. */
export const TOOL_NAME_MAX_LENGTH = 64;

/** `raw` with every character outside `[a-zA-Z0-9_-]` replaced by `_`, cut to
 *  {@link TOOL_NAME_MAX_LENGTH}. */
export function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, TOOL_NAME_MAX_LENGTH);
}

/** What naming reads of one `list_allowed_operations` row. */
export interface GateToolNameSource {
  readonly gatekeeperId: string;
  readonly gateName: string;
  /** The Operation's name. */
  readonly name: string;
}

/**
 * The tool name for one gate Operation, added to `usedNames` (the names already taken in this
 * tool list — the consumer's own tools first, then earlier gate tools). Never one already in it:
 *
 * 1. `<gateName>_<op>`, the name a person or a runbook can predict from `<gate>.<op>`;
 * 2. taken (another gate of the same name, or the consumer's own tool) → `<gatekeeperId>_<op>`;
 * 3. taken too → that name with `_2`, `_3`, … appended, cut so the whole stays within
 *    {@link TOOL_NAME_MAX_LENGTH}. This is where two Operation names sanitize to the same tool
 *    name in one gate (`disk.usage` and `disk_usage` on the second of two gates of one name), or
 *    agree in everything the 64-character cut keeps (the gatekeeperId takes 37 of them).
 *
 * Without the third step two tools shared a name: an MCP call reached the later one and pi
 * projected only the earlier one (legacy 768).
 */
export function allocateGateToolName(op: GateToolNameSource, usedNames: Set<string>): string {
  let name = sanitizeToolName(`${op.gateName}.${op.name}`);
  if (usedNames.has(name)) {
    const byGatekeeperId = sanitizeToolName(`${op.gatekeeperId}.${op.name}`);
    name = byGatekeeperId;
    for (let n = 2; usedNames.has(name); n += 1) {
      const suffix = `_${n}`;
      name = `${byGatekeeperId.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    }
  }
  usedNames.add(name);
  return name;
}
