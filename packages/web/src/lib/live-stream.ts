/**
 * lib/live-stream: what the console can tell about a Turn's live text from the text alone.
 *
 * The kernel scrubs secret-looking values from the live stream (kernel
 * governance/redaction/secret-stream.ts). It holds back the end of the text while that end could
 * still be part of a secret; past its bound it drops what it held, emits one `[redacted]` in its
 * place and streams nothing more until the Turn's next event — the stored reply, scrubbed,
 * replaces the streamed text when it arrives. So a running Turn whose live text ends in
 * `[redacted]` has paused, not hung.
 *
 * Exactly at the end, no trailing whitespace: a value scrubbed mid-text is released together with
 * the whitespace after it (`the password: [redacted] `) while the next word is still held, and
 * that is not a pause. A pause is `before + '[redacted]'` (secret-stream.ts `take`). One false
 * positive remains: a value that ends a text segment right before a tool call shows the hint while
 * the tool runs — telling the two apart needs an explicit pause event from the kernel.
 */
export const STREAM_REDACTED_MARKER = '[redacted]';

export function liveOutputPaused(streamingText: string): boolean {
  return streamingText.endsWith(STREAM_REDACTED_MARKER);
}
