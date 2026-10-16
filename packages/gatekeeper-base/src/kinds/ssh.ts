import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BlastRadius, Operation, OperationMode } from '@nexttime/shared';
import {
  BindingKindMismatchError,
  OperationRefusedError,
  TransportInvokeError,
  TransportOutcomeUnknownError,
  TransportTimeoutError,
} from '../errors.js';
import { execFailureOf } from './exec-failure.js';
import { DEFAULT_EXEC_TIMEOUT_MS, runWithExecTimeout } from './exec-timeout.js';
import type { Transport, TransportInvokeContext, TransportInvokeResult } from './types.js';
import { boundUntrustedText } from './untrusted-text.js';

/**
 * `ssh` transport (design doc §7.5): a command template or a command-pattern policy-table match,
 * for systems whose only interface is an interactive CLI over ssh. **Command policy table**: an
 * ordered list of regex patterns → `{mode, blast_radius, auto_approvable}`; no match → I17's
 * "unclassified" default (`require_approval` semantics: `mode: execute, blast_radius: medium,
 * auto_approvable: false`, flagged `unclassified: true`).
 *
 * Execution: `execFile('ssh', [...connectionArgs, command])` — never a local shell (`exec`), so
 * there is no local shell-injection surface. The remote command is still, unavoidably, a single
 * string handed to the remote host's own shell (that is how `ssh user@host "cmd"` works — a
 * device with only a CLI has no argv-array remote-exec mode); the policy table above, not local
 * escaping, is what governs which commands may run. `ssh2` (a native-binding npm dependency) was
 * considered and rejected: `pnpm-workspace.yaml` already declines `ssh2`'s native build scripts as
 * an unused transitive dependency of `worker-supervisor`'s dockerode — adding it back as a direct,
 * *built* dependency here would reintroduce exactly what that file's own comment declined. Shelling
 * out to the system `ssh` binary (already present in any image that needs to reach ssh-only
 * devices) has no such native-build cost and is simpler to test (inject a fake `execFileImpl`).
 */

export interface SshTarget {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  /** Path to a private key file, passed as `-i`. Omit to use the ssh client's own default
   *  identity/agent resolution. */
  readonly identityFile?: string;
  /** `-o StrictHostKeyChecking=…`: `yes` (pinned key required), `accept-new` (pin on first
   *  contact), `no` (test fixtures only). Omit → OpenSSH default, which under BatchMode refuses an
   *  unknown host (S2.12 host run: every fixture command failed with "Host key verification
   *  failed" until this existed). */
  readonly strictHostKeyChecking?: 'yes' | 'accept-new' | 'no';
  /** `-o UserKnownHostsFile=…` — where the pinned key(s) live (under the gate's data dir). */
  readonly knownHostsFile?: string;
}

export interface SshPolicyRule {
  /** Regex source, matched against the whole command string. */
  readonly pattern: string;
  readonly mode: OperationMode;
  readonly blastRadius: BlastRadius;
  readonly autoApprovable: boolean;
}

export interface SshClassification {
  readonly mode: OperationMode;
  readonly blastRadius: BlastRadius;
  readonly autoApprovable: boolean;
  /** `true` when no policy rule matched — I17's default applies. */
  readonly unclassified: boolean;
}

const UNCLASSIFIED_DEFAULT: SshClassification = {
  mode: 'execute',
  blastRadius: 'medium',
  autoApprovable: false,
  unclassified: true,
};

/** Classifies `command` against `policyTable` (first match wins, in order); I17's default when
 *  nothing matches. Pure — no IO, unit-testable without a real ssh connection. */
export function classifyCommand(
  command: string,
  policyTable: readonly SshPolicyRule[],
): SshClassification {
  for (const rule of policyTable) {
    if (new RegExp(rule.pattern).test(command)) {
      return {
        mode: rule.mode,
        blastRadius: rule.blastRadius,
        autoApprovable: rule.autoApprovable,
        unclassified: false,
      };
    }
  }
  return UNCLASSIFIED_DEFAULT;
}

/** `options.signal` aborts when the transport's exec timeout passes — an impl kills the child. A
 *  rejection carries what `execFile` puts on its error (`code`, `signal`, `stderr`) and — from the
 *  default impl — `sshClientLog`: what the ssh client itself logged (`-E`), kept apart from the
 *  remote command's stderr (legacy 287, `sshFailureOutcomeUnknown`). */
export type SshExecFn = (
  target: SshTarget,
  command: string,
  options: { readonly signal: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

/** Exported for tests — the exact argv handed to `ssh` (never a shell). R-51: `-n` gives the
 *  remote command an empty stdin (a command that reads stdin gets EOF instead of hanging), and
 *  `ConnectTimeout` / `ServerAliveInterval` bound an unreachable or silently dead peer well inside
 *  the transport's exec timeout. */
export function sshConnectionArgs(
  target: SshTarget,
  options: { readonly clientLogFile?: string } = {},
): string[] {
  const args: string[] = ['-n'];
  if (target.identityFile) args.push('-i', target.identityFile);
  if (target.port) args.push('-p', String(target.port));
  if (target.strictHostKeyChecking) {
    args.push('-o', `StrictHostKeyChecking=${target.strictHostKeyChecking}`);
  }
  if (target.knownHostsFile) args.push('-o', `UserKnownHostsFile=${target.knownHostsFile}`);
  args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15');
  // Legacy 287: `-E` sends the ssh client's own messages to this file instead of stderr — "Permission
  // denied", "Host key verification failed", "connect to host … refused" — so they can never be
  // confused with the remote command's stderr, which stays on stderr.
  if (options.clientLogFile !== undefined) args.push('-E', options.clientLogFile);
  args.push(`${target.user}@${target.host}`);
  return args;
}

const defaultSshExec: SshExecFn = async (target, command, { signal }) => {
  // Legacy 287: a private file for the ssh client's own log (`-E`), read back on failure and
  // removed either way. Without a writable temp dir the command still runs, with no client log —
  // every exit 255 then reads as "outcome unknown" (`sshFailureOutcomeUnknown`), the safe side.
  const logDir = await mkdtemp(join(tmpdir(), 'nt-ssh-')).catch(() => undefined);
  const clientLogFile = logDir !== undefined ? join(logDir, 'client.log') : undefined;
  try {
    // `--` ends option parsing: OpenSSH keeps parsing options after the destination, so a command
    // beginning with `-o` (e.g. `-oProxyCommand=…`) would otherwise be consumed as a *client*
    // option and run locally inside the gate with its identity file (review lane 5, P0-1).
    const args = [...sshConnectionArgs(target, { clientLogFile }), '--', command];
    const pending = execFileAsync('ssh', args, {
      maxBuffer: 10 * 1024 * 1024,
      signal,
      killSignal: 'SIGKILL',
    });
    pending.child.stdin?.end();
    try {
      const { stdout, stderr } = await pending;
      return { stdout, stderr };
    } catch (err) {
      if (clientLogFile !== undefined && err !== null && typeof err === 'object') {
        const sshClientLog = await readFile(clientLogFile, 'utf8').catch(() => undefined);
        if (sshClientLog !== undefined) Object.assign(err, { sshClientLog });
      }
      throw err;
    }
  } finally {
    if (logDir !== undefined) await rm(logDir, { recursive: true, force: true }).catch(() => {});
  }
};

/** `execFile` rejections carry the child's stderr and exit code — the only place ssh explains
 *  itself ("Host key verification failed.", "Permission denied (publickey)", "UNPROTECTED PRIVATE
 *  KEY FILE"). Folded into the error message so an ActionRequest's failure reason is diagnosable.
 *  `stderr` is target-controlled and, per `execFileAsync`'s own `maxBuffer: 10 * 1024 * 1024`, can
 *  be up to 10MB — `boundUntrustedText` (review lane 5, P3 batch) bounds it to 2KB and marks it
 *  untrusted before it becomes part of a failure reason / audit trail.
 *
 *  Never `err.message` of a command that ran (`execFile`'s carries `cmd`): Node's is `Command
 *  failed: ssh -n -i <identity file> -p <port> … <user>@<host> -- <rendered command>` — the gate's
 *  key path and target, and every param the template put in the command (`mysql -p{password}`),
 *  which then lands in the ActionRequest's failure reason, its audit row and the agent's result.
 *  A command that exits non-zero with no stderr (`grep` with no match) said nothing else. */
function describeExecFailure(err: unknown): string {
  if (!(err instanceof Error)) return 'the command failed';
  const withIo = err as Error & {
    stderr?: unknown;
    code?: unknown;
    signal?: unknown;
    cmd?: unknown;
    sshClientLog?: unknown;
  };
  const stderr = typeof withIo.stderr === 'string' ? withIo.stderr.trim() : '';
  const code = withIo.code !== undefined ? ` (exit ${String(withIo.code)})` : '';
  const signal = typeof withIo.signal === 'string' ? ` (signal ${withIo.signal})` : '';
  // Legacy 287: the ssh client's own last word (`-E`) — once on stderr, now in its own log.
  const clientLine =
    typeof withIo.sshClientLog === 'string' ? sshFailureLine(withIo.sshClientLog) : undefined;
  const client =
    clientLine !== undefined ? `ssh client: ${boundUntrustedText(clientLine, 512)}` : '';
  if (stderr && client) return `${client}; ${boundUntrustedText(stderr)}${code}${signal}`;
  if (client) return `${client}${code}${signal}`;
  if (stderr) return `${boundUntrustedText(stderr)}${code}${signal}`;
  if (withIo.cmd !== undefined || typeof withIo.code === 'number' || signal !== '') {
    return `the command failed with no output on stderr${code}${signal}`;
  }
  return `${err.message}${code}`;
}

/**
 * Legacy 287: OpenSSH exits 255 when ssh itself fails — before the session started (the host did
 * not resolve or refused the connection, its key did not verify, authentication failed: nothing
 * ran), or during it (the connection dropped while the command was running — a RouterOS address
 * change that cuts its own session, a reboot, a dead peer `ServerAliveInterval` gave up on: it may
 * have run). These are the ssh client's own messages for the first kind, matched whole against
 * its own log (`-E`, `sshClientLog`) — never against stderr, where the remote command writes
 * whatever it likes (review of #586: `Error: Permission denied (os error 13)` from the command
 * itself once read as "never started"). A session that dropped mid-command logs nothing there
 * ("Connection to … closed by remote host." goes to stderr), so it reads as the second kind.
 */
const SSH_SESSION_NEVER_STARTED: readonly RegExp[] = [
  /^ssh: Could not resolve hostname \S+: .+$/,
  /^ssh: connect to host \S+ port \d+: .+$/,
  /^Host key verification failed\.$/,
  /^\S+@\S+: Permission denied \((?:[\w-]+,)*[\w-]+\)\.$/,
  /^kex_exchange_identification: .+$/,
  /^banner exchange: .+$/,
  /^Connection timed out during banner exchange$/,
  /^Unable to negotiate with \S+ port \d+: .+$/,
  /^Bad owner or permissions on .+$/,
];

/** The generic line OpenSSH adds after the specific one ("kex_exchange_identification: read:
 *  Connection reset by peer" then "Connection reset by … port 22"). On its own it says nothing
 *  about when the connection broke — the same words end a session that dropped mid-command. */
const SSH_GENERIC_LAST_LINE =
  /^(?:Connection (?:closed|reset) by \S+ port \d+|Connection to \S+ port \d+ timed out)$/;

const SSH_CLIENT_FAILURE_EXIT = 255;

/** ssh's own last word in its log: its last line, or the one before a generic trailer. */
function sshFailureLine(log: string): string | undefined {
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.pop();
  return last !== undefined && SSH_GENERIC_LAST_LINE.test(last) ? lines.pop() : last;
}

/**
 * Whether a failed `ssh` run's outcome is unknown — it may have run its command and gave no
 * answer (legacy 287; review of #586, #501 P2-2):
 *   - an exit status other than 255 is the remote command's own answer: no;
 *   - ssh itself could not be spawned: no, nothing ran;
 *   - 255 with a never-started message as ssh's own last word in its log
 *     (`SSH_SESSION_NEVER_STARTED`): no. Any other 255 — a dropped session, a remote command
 *     that itself exits 255, or no client log to read: yes;
 *   - killed by a signal, stopped past the output limit, anything else: yes.
 */
export function sshFailureOutcomeUnknown(err: unknown): boolean {
  const failure = execFailureOf(err);
  if (failure.kind === 'not_started') return false;
  if (failure.kind === 'stopped') return true;
  if (failure.exitCode !== SSH_CLIENT_FAILURE_EXIT) return false;
  const log = (err as { sshClientLog?: unknown }).sshClientLog;
  if (typeof log !== 'string') return true;
  const line = sshFailureLine(log);
  return line === undefined || !SSH_SESSION_NEVER_STARTED.some((pattern) => pattern.test(line));
}

export interface SshTransportOptions {
  readonly target: SshTarget;
  readonly policyTable: readonly SshPolicyRule[];
  /** Injectable for tests — defaults to a real `execFile('ssh', ...)` call. */
  readonly execImpl?: SshExecFn;
  /** R-51: a command still running after this long is killed and the call fails with
   *  `TransportTimeoutError` (default `DEFAULT_EXEC_TIMEOUT_MS`, below the kernel's apply budget). */
  readonly execTimeoutMs?: number;
}

/** Resolves the literal command to run: a `command_template` is rendered like the `cli` transport
 *  (`{name}` substitution, one shell token per param — see `cli.ts`); a `command_pattern` binding
 *  takes the literal command from `params.command`, and requires it to actually match that
 *  Operation's own declared pattern (defense in depth: a caller cannot invoke a loosely-classified
 *  Operation with an unrelated command string). */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** One shell word: a value made only of shell-inert characters is passed through unchanged (so
 *  `command_pattern`s written for plain values keep matching); anything else is POSIX
 *  single-quoted (`'` → `'\''`), which is inert under sh/bash/dash/busybox. */
export function shellQuote(value: string): string {
  if (SHELL_SAFE_WORD.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A refusal (R-51): thrown before anything runs on the target, so it takes the
 *  `OperationRefusedError` path — 403 `operation_refused`, and `apply` frees its idempotency key —
 *  instead of an opaque 500 that pinned the key. */
export class SshCommandRejectedError extends OperationRefusedError {
  constructor(reason: string) {
    super(`ssh transport: command rejected — ${reason}`);
    this.name = 'SshCommandRejectedError';
  }
}

/** A command line is refused when it starts with `-` (would be read as an ssh option — belt to
 *  the `--` braces in defaultSshExec) or spans lines (a second command the policy regex never
 *  saw). Everything else is the operator's declared contract: the Operation's `command_pattern`
 *  and the gate's policy table classify the line as a whole. */
export function assertCommandShape(command: string): void {
  if (/^\s*-/.test(command)) {
    throw new SshCommandRejectedError('command must not start with "-"');
  }
  if (/[\r\n]/.test(command)) {
    throw new SshCommandRejectedError('command must be a single line');
  }
}

const BLAST_RADIUS_RANK: Record<BlastRadius, number> = { low: 0, medium: 1, high: 2 };

/**
 * Live policy enforcement (review lane 5, P0-3): the classification used to be computed and then
 * dropped, so an Operation published as `observe` with a loose `command_pattern` let
 * `/gate/observe` — no ActionRequest, no approval — run anything. An observe-class Operation may
 * only run a command the policy table classifies as observe, and no Operation may run a command
 * whose classified blast radius exceeds what the Operation declared (the kernel's policy decision
 * was made on the declared value).
 */
export function assertClassificationAllowed(
  operation: Operation,
  classification: SshClassification,
): void {
  if (
    operation.mode === 'observe' &&
    (classification.unclassified || classification.mode !== 'observe')
  ) {
    const actual = classification.unclassified ? 'unclassified' : classification.mode;
    throw new SshCommandRejectedError(
      `operation "${operation.name}" is observe-class but the command classifies as ${actual}`,
    );
  }
  if (BLAST_RADIUS_RANK[classification.blastRadius] > BLAST_RADIUS_RANK[operation.blast_radius]) {
    throw new SshCommandRejectedError(
      `command classifies as blast radius "${classification.blastRadius}", above the operation's declared "${operation.blast_radius}"`,
    );
  }
}

/** An Operation's `command_pattern` as a RegExp — a pattern that does not compile is the gate's own
 *  misconfiguration, found before the target is touched (legacy 310: a plain failure). */
function commandPatternOf(operationName: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new TransportInvokeError(
      `ssh transport: operation "${operationName}"'s command_pattern is not a valid regular expression`,
      { cause: err },
    );
  }
}

function resolveCommand(operation: Operation, params: unknown): string {
  if (operation.binding.kind !== 'ssh') {
    throw new BindingKindMismatchError(operation.name, 'ssh', operation.binding.kind);
  }
  const bag = (params ?? {}) as Record<string, unknown>;
  if (operation.binding.command_template) {
    return operation.binding.command_template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      const value = bag[name];
      if (value === undefined) {
        // Before the target is touched (legacy 310): a plain failure, not an unclassified one.
        throw new TransportInvokeError(
          `ssh transport: missing param "${name}" for operation "${operation.name}"`,
        );
      }
      // One shell *word* per param: the template is a remote shell line, so a raw value like
      // `eth0; reload` would run two commands. POSIX single-quoting makes the value inert
      // (review lane 5, P0-2). Templates must not quote placeholders themselves.
      return shellQuote(String(value));
    });
  }
  const command = bag.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new TransportInvokeError(
      `ssh transport: operation "${operation.name}" requires a string "command" param`,
    );
  }
  const pattern = operation.binding.command_pattern;
  if (pattern && !commandPatternOf(operation.name, pattern).test(command)) {
    throw new SshCommandRejectedError(
      `command does not match operation "${operation.name}"'s own command_pattern`,
    );
  }
  return command;
}

export class SshTransport implements Transport {
  readonly kind = 'ssh' as const;
  /** Authenticates with the identity file in `target`, never with a resolved credential. */
  readonly credentialRequired = false as const;
  private readonly options: SshTransportOptions;

  constructor(options: SshTransportOptions) {
    this.options = options;
  }

  async invoke(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<TransportInvokeResult> {
    void ctx;
    const command = resolveCommand(operation, params);
    assertCommandShape(command);
    const classification = classifyCommand(command, this.options.policyTable);
    assertClassificationAllowed(operation, classification);
    try {
      const run = this.options.execImpl ?? defaultSshExec;
      const { stdout, stderr } = await runWithExecTimeout(
        this.options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        `ssh transport: command for "${operation.name}"`,
        (signal) => run(this.options.target, command, { signal }),
      );
      return { data: { stdout, stderr }, detail: { command, classification } };
    } catch (err) {
      if (err instanceof TransportTimeoutError) throw err;
      if (sshFailureOutcomeUnknown(err)) {
        const failure = execFailureOf(err);
        const what =
          failure.kind === 'stopped'
            ? `the ssh command for "${operation.name}" was stopped before it answered (${failure.why})`
            : `the ssh connection for "${operation.name}" failed after the command may have started`;
        throw new TransportOutcomeUnknownError(
          `ssh transport: ${what}: ${describeExecFailure(err)} — it may have partially or fully run`,
          { cause: err },
        );
      }
      throw new TransportInvokeError(
        `ssh transport: command failed for "${operation.name}": ${describeExecFailure(err)}`,
        { cause: err },
      );
    }
  }

  async simulate(
    operation: Operation,
    params: unknown,
    ctx?: TransportInvokeContext,
  ): Promise<{ description: string; detail?: unknown }> {
    void ctx;
    const command = resolveCommand(operation, params);
    const classification = classifyCommand(command, this.options.policyTable);
    return {
      description: `would run over ssh: ${command}`,
      detail: { command, classification },
    };
  }
}
