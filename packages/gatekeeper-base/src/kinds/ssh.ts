import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BlastRadius, Operation, OperationMode } from '@nexttime/shared';
import { BindingKindMismatchError, TransportInvokeError } from '../errors.js';
import type { Transport, TransportInvokeContext, TransportInvokeResult } from './types.js';

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

export type SshExecFn = (
  target: SshTarget,
  command: string,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

function connectionArgs(target: SshTarget): string[] {
  const args: string[] = [];
  if (target.identityFile) args.push('-i', target.identityFile);
  if (target.port) args.push('-p', String(target.port));
  args.push('-o', 'BatchMode=yes', `${target.user}@${target.host}`);
  return args;
}

const defaultSshExec: SshExecFn = async (target, command) => {
  const args = [...connectionArgs(target), command];
  const { stdout, stderr } = await execFileAsync('ssh', args, { maxBuffer: 10 * 1024 * 1024 });
  return { stdout, stderr };
};

export interface SshTransportOptions {
  readonly target: SshTarget;
  readonly policyTable: readonly SshPolicyRule[];
  /** Injectable for tests — defaults to a real `execFile('ssh', ...)` call. */
  readonly execImpl?: SshExecFn;
}

/** Resolves the literal command to run: a `command_template` is rendered like the `cli` transport
 *  (`{name}` substitution, one shell token per param — see `cli.ts`); a `command_pattern` binding
 *  takes the literal command from `params.command`, and requires it to actually match that
 *  Operation's own declared pattern (defense in depth: a caller cannot invoke a loosely-classified
 *  Operation with an unrelated command string). */
function resolveCommand(operation: Operation, params: unknown): string {
  if (operation.binding.kind !== 'ssh') {
    throw new BindingKindMismatchError(operation.name, 'ssh', operation.binding.kind);
  }
  const bag = (params ?? {}) as Record<string, unknown>;
  if (operation.binding.command_template) {
    return operation.binding.command_template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      const value = bag[name];
      if (value === undefined) {
        throw new Error(`ssh transport: missing param "${name}" for operation "${operation.name}"`);
      }
      return String(value);
    });
  }
  const command = bag.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error(
      `ssh transport: operation "${operation.name}" requires a string "command" param`,
    );
  }
  const pattern = operation.binding.command_pattern;
  if (pattern && !new RegExp(pattern).test(command)) {
    throw new Error(
      `ssh transport: command does not match operation "${operation.name}"'s own command_pattern`,
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
    const classification = classifyCommand(command, this.options.policyTable);
    try {
      const run = this.options.execImpl ?? defaultSshExec;
      const { stdout, stderr } = await run(this.options.target, command);
      return { data: { stdout, stderr }, detail: { command, classification } };
    } catch (err) {
      throw new TransportInvokeError(`ssh transport: command failed for "${operation.name}"`, {
        cause: err,
      });
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
