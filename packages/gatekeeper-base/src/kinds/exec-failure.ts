/**
 * Legacy 287 (review of #586, #501 P2-2): how a failed `execFile` of the exec transports (`cli`,
 * `ssh`) reads.
 *
 *   - `answered`: the process exited with a status — the command's own answer (for `ssh`, 255 is
 *     ssh's own status and `ssh.ts` reads further).
 *   - `not_started`: the binary could not be spawned (`ENOENT`, `EACCES` from `spawn`) — nothing
 *     ran.
 *   - `stopped`: the process was stopped before it answered — killed by a signal, or killed by
 *     Node past the output limit (`maxBuffer`: a command that wrote that much was running) — or
 *     failed in a way this module does not recognise. It may have partially or fully run.
 *
 * The exec timeout's own kill is `TransportTimeoutError` (`exec-timeout.ts`), decided before this.
 */
export type ExecFailure =
  | { readonly kind: 'answered'; readonly exitCode: number }
  | { readonly kind: 'not_started' }
  | { readonly kind: 'stopped'; readonly why: string };

const MAX_BUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

export function execFailureOf(err: unknown): ExecFailure {
  if (err === null || typeof err !== 'object') {
    return { kind: 'stopped', why: 'it failed in a way the gate does not recognise' };
  }
  const { code, signal, syscall } = err as { code?: unknown; signal?: unknown; syscall?: unknown };
  if (code === MAX_BUFFER_CODE) {
    return { kind: 'stopped', why: 'its output passed the limit and the gate stopped it' };
  }
  if (typeof code === 'number') return { kind: 'answered', exitCode: code };
  if (typeof signal === 'string' && signal !== '') {
    return { kind: 'stopped', why: `it was killed by ${signal}` };
  }
  if (typeof code === 'string' && typeof syscall === 'string' && syscall.startsWith('spawn')) {
    return { kind: 'not_started' };
  }
  return { kind: 'stopped', why: 'it failed in a way the gate does not recognise' };
}
