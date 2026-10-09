/**
 * lib/live-stream: what the console can tell about a Turn's live text from the text alone.
 *
 * The kernel scrubs secret-looking values from the live stream (kernel
 * governance/redaction/secret-stream.ts). It holds back the end of the text while that end could
 * still be part of a secret; past its bound it drops what it held, emits one `[redacted]` in its
 * place and streams nothing more until the Turn's next event — the stored reply, scrubbed,
 * replaces the streamed text when it arrives. So a running Turn whose live text ends in
 * `[redacted]` has paused, not hung (a value scrubbed mid-text is followed by more text).
 */
export const STREAM_REDACTED_MARKER = '[redacted]';

export function liveOutputPaused(streamingText: string): boolean {
  return streamingText.trimEnd().endsWith(STREAM_REDACTED_MARKER);
}
