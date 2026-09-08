import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Operation } from '@nexttime/shared';
import { BindingKindMismatchError, TransportInvokeError } from '../errors.js';
import type { Transport, TransportInvokeContext, TransportInvokeResult } from './types.js';

/**
 * `cli` transport (design doc §7.5): a command template run inside the gate container (`kubectl`,
 * `gh`, a vendor CLI, ...). **Strict argument escaping**: `renderCommandTemplate` tokenizes the
 * template on whitespace and substitutes each `{name}` placeholder as one argv element — the
 * rendered command is executed via `execFile` (never `exec`/a shell string), so a param value can
 * never break out into a second shell token or command regardless of its content. `docker`
 * (S2.5) is the first prebuilt `cli`-kind manifest.
 */

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

const defaultExecFile: ExecFileFn = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args as string[], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/**
 * Tokenizes `template` on whitespace, substituting `{name}` occurrences with `String(params[name])`
 * — each resulting token is exactly one argv element (no shell involved, so no escaping needed for
 * spaces/metacharacters inside a param value; the whole substituted value is one argv slot even if
 * it contains spaces).
 *
 * Flag injection (review lane 5, P1-2): `execFile` prevents shell injection, but not argv-level
 * flag injection — a *positional* template token (the placeholder with nothing else around it,
 * e.g. `{container}`) whose substituted value happens to start with `-` is read by the target CLI
 * as an option, not as the positional value the template author intended (e.g. `container.restart`
 * with `container: '--force'` could flip an unrelated flag on whatever `docker`/`kubectl`/`gh`
 * command the template names). A template token that already starts with `-` in the template
 * itself (e.g. `--name={container}`) is exempt: its leading `-`/`--` bytes are the operator's own
 * literal text, not attacker-controlled, so a `-`-prefixed value glued onto it cannot rename or
 * add a flag. Only a token that is *entirely* the substitution (no literal prefix) is refused.
 */
export function renderCommandTemplate(template: string, params: Record<string, unknown>): string[] {
  return template
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const isFlagToken = token.startsWith('-');
      const rendered = token.replace(/\{([^}]+)\}/g, (_match, name: string) => {
        const value = params[name];
        if (value === undefined) {
          throw new Error(
            `renderCommandTemplate: missing param "${name}" for template "${template}"`,
          );
        }
        return String(value);
      });
      if (!isFlagToken && rendered.startsWith('-')) {
        throw new Error(
          `renderCommandTemplate: positional value "${rendered}" for template "${template}" must not start with "-" (flag injection) — use a --flag={name} template token if a flag-shaped value is actually intended`,
        );
      }
      return rendered;
    });
}

export interface CliTransportOptions {
  readonly execFileImpl?: ExecFileFn;
}

export class CliTransport implements Transport {
  readonly kind = 'cli' as const;
  /** Local binary/socket — no per-call credential to resolve. */
  readonly credentialRequired = false as const;
  private readonly options: CliTransportOptions;

  constructor(options: CliTransportOptions = {}) {
    this.options = options;
  }

  private render(operation: Operation, params: unknown): string[] {
    if (operation.binding.kind !== 'cli') {
      throw new BindingKindMismatchError(operation.name, this.kind, operation.binding.kind);
    }
    return renderCommandTemplate(
      operation.binding.command_template,
      (params ?? {}) as Record<string, unknown>,
    );
  }

  async invoke(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<TransportInvokeResult> {
    void ctx;
    const argv = this.render(operation, params);
    const [file, ...args] = argv;
    if (!file)
      throw new TransportInvokeError(`cli transport: empty command for "${operation.name}"`);
    try {
      const run = this.options.execFileImpl ?? defaultExecFile;
      const { stdout, stderr } = await run(file, args);
      return { data: { stdout, stderr } };
    } catch (err) {
      throw new TransportInvokeError(`cli transport: command failed for "${operation.name}"`, {
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
    const argv = this.render(operation, params);
    return { description: `would run: ${argv.join(' ')}`, detail: { argv } };
  }
}
