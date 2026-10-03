import { readFile } from 'node:fs/promises';
import { CredentialResolutionError } from '../errors.js';
import type { CredentialResolver, ResolvedCredential } from './types.js';

/**
 * Shared credential resolver (design doc §5.1.4/§7.5): reads `GATE_CREDENTIAL_<NAME>` from the
 * gate's own env — for systems where one credential is shared by every caller (infrastructure,
 * inventory, ...), never per-user. `<NAME>` defaults to `DEFAULT` (one shared credential is the
 * common case: a gate instance backs exactly one target system/account). A gate that genuinely
 * needs more than one named shared credential can construct multiple `SharedEnvCredentialResolver`
 * instances with different `name`s.
 *
 * The env var's value is treated as an opaque bearer token/API key string by default
 * (`{token: <value>}`); a transport that needs a structured credential (e.g. separate
 * username/password) should parse `GATE_CREDENTIAL_<NAME>` itself as JSON — this resolver does not
 * assume a shape beyond "non-empty string".
 *
 * **From a file first (R-24, review 2026-10-02):** a credential in container env is readable by
 * anything that can inspect the container (the read-only collector socket proxy among them), so
 * `GATE_CREDENTIAL_<NAME>_FILE` names a file holding the same value (trailing newline ignored) —
 * the `*_FILE` convention `GATE_STORE_KEY_FILE` / `GATE_KERNEL_TOKEN_FILE` already follow. Read on
 * every resolve, so a rotated file takes effect without a restart. The env var still works when
 * the file is absent or empty — an operator env file that was never migrated must not break a host
 * apply — and then logs one deprecation warning. An unreadable file (wrong mode or group) with no
 * env fallback is a resolution error naming the file, never a silent "not set".
 */
export class SharedEnvCredentialResolver implements CredentialResolver {
  private readonly options: {
    readonly name?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly log?: (line: string) => void;
  };
  private readonly envVarName: string;
  private warnedEnvFallback = false;

  constructor(
    options: {
      readonly name?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly log?: (line: string) => void;
    } = {},
  ) {
    this.options = options;
    this.envVarName = `GATE_CREDENTIAL_${options.name ?? 'DEFAULT'}`;
  }

  async resolve(_onBehalfOf: string | undefined): Promise<ResolvedCredential> {
    const env = this.options.env ?? process.env;
    const filePath = env[`${this.envVarName}_FILE`];
    let fileError: string | undefined;
    let raw: string | undefined;
    if (filePath) {
      try {
        const content = (await readFile(filePath, 'utf8')).replace(/\r?\n$/, '');
        if (content.length > 0) raw = content;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT')
          fileError = code ?? (err instanceof Error ? err.message : String(err));
      }
    }
    if (raw === undefined) {
      raw = env[this.envVarName] || undefined;
      if (raw !== undefined && filePath) this.warnEnvFallback(filePath, fileError);
    }
    if (!raw) {
      throw new CredentialResolutionError(
        fileError
          ? `shared credential file "${filePath}" (${this.envVarName}_FILE) could not be read (${fileError}) and env var "${this.envVarName}" is not set`
          : `shared credential env var "${this.envVarName}" is not set`,
      );
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as ResolvedCredential;
      }
    } catch {
      // Not JSON — treat the whole value as an opaque token below.
    }
    return { token: raw };
  }

  private warnEnvFallback(filePath: string, fileError: string | undefined): void {
    if (this.warnedEnvFallback) return;
    this.warnedEnvFallback = true;
    const log = this.options.log ?? ((line: string) => console.error(line));
    log(
      JSON.stringify({
        level: 'warn',
        msg: `credential ${this.envVarName} read from the environment (deprecated, visible to container inspect) — put it in ${this.envVarName}_FILE and remove the env var`,
        file: filePath,
        ...(fileError ? { fileError } : {}),
      }),
    );
  }
}
