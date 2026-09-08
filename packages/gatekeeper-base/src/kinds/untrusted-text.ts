const MAX_UNTRUSTED_TEXT_BYTES = 2048;

/**
 * Bounds `text` — which came from a target system this gate does not control, not from this gate
 * itself — to at most `maxBytes` of UTF-8 and marks it as untrusted (review lane 5, P3 batch:
 * `ssh.ts`'s `describeExecFailure` and `mcp.ts`'s JSON-RPC/`isError` error text previously folded
 * arbitrarily large, target-controlled text straight into a failure reason that becomes part of an
 * ActionRequest's failure reason / audit trail — unbounded and with no signal to a downstream
 * reader that the text is not this gate's own). Truncation is byte-aware: it never splits a
 * multi-byte UTF-8 character, only ever drops a trailing partial one.
 */
export function boundUntrustedText(text: string, maxBytes = MAX_UNTRUSTED_TEXT_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return `untrusted: ${text}`;
  const truncated = buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  return `untrusted: ${truncated}… [truncated, ${buf.length} bytes total]`;
}
