/**
 * A resolved credential is opaque to `GatekeeperBase` — only the transport that consumes it knows
 * its shape (a bearer token, a header map, a username/password pair, ...).
 */
export type ResolvedCredential = Record<string, unknown>;

export interface CredentialResolver {
  /** Resolves the credential a call should use. `onBehalfOf` is required for a ConnectedAccount
   *  resolver (design doc §5.1.4 ConnectedAccount "按 on_behalf_of 取用"); a shared-env resolver
   *  ignores it. Throws `CredentialResolutionError` (errors.ts) if none can be resolved. */
  resolve(onBehalfOf: string | undefined): Promise<ResolvedCredential>;
}
