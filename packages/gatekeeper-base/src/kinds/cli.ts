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
 */
export function renderCommandTemplate(template: string, params: Record<string, unknown>): string[] {
  return template
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) =>
      token.replace(/\{([^}]+)\}/g, (_match, name: string) => {
        const value = params[name];
        if (value === undefined) {
          throw new Error(
            `renderCommandTemplate: missing param "${name}" for template "${template}"`,
          );
        }
        return String(value);
      }),
    );
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
