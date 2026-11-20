import { getCapability } from './capabilities.js';
import { namesASecretField } from './secret-field-name.js';

/**
 * tool-call-secrets: which keys of one tool call's payloads hold a secret — a key the capability
 * declares secret (`redactedParamKeys`, the same list the kernel keeps out of the audit log), when
 * the tool is a capability tool (entry, interactive and worker mode name each capability tool after
 * its capability), or one whose name names a secret (`namesASecretField`).
 *
 * The kernel applies it to every tool call it keeps (application/chat/tool-call-record.ts); worker
 * mode applies it before it sends a call (legacy 155), to send every secret value the kernel will
 * hide in the call's result (`boundToolCallArgs`). One rule, so the two never differ.
 */
export function toolCallSecretKeyRule(
  toolName: string | null | undefined,
): (key: string) => boolean {
  const declared = new Set(toolName ? (getCapability(toolName)?.redactedParamKeys ?? []) : []);
  return (key) => declared.has(key) || namesASecretField(key);
}
