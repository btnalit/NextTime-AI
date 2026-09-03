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
 */
export class SharedEnvCredentialResolver implements CredentialResolver {
  private readonly options: { readonly name?: string; readonly env?: NodeJS.ProcessEnv };
  private readonly envVarName: string;

  constructor(options: { readonly name?: string; readonly env?: NodeJS.ProcessEnv } = {}) {
    this.options = options;
    this.envVarName = `GATE_CREDENTIAL_${options.name ?? 'DEFAULT'}`;
  }

  async resolve(_onBehalfOf: string | undefined): Promise<ResolvedCredential> {
    const env = this.options.env ?? process.env;
    const raw = env[this.envVarName];
    if (!raw) {
      throw new CredentialResolutionError(
        `shared credential env var "${this.envVarName}" is not set`,
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
}
