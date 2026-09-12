import { GATE_SHARED_CREDENTIAL_SLOT } from '@nexttime/shared';
import { CredentialResolutionError } from '../errors.js';
import type { ConnectedAccountStore } from './connected-account.js';
import type { CredentialResolver, ResolvedCredential } from './types.js';

/**
 * credentials/hosted: the resolver a gate-host instance uses (docs/development-tasks.md P-B 决定 ⑪).
 *
 * `shared` reads the instance-wide slot `GATE_SHARED_CREDENTIAL_SLOT` an administrator filled from
 * the integrations page (browser → host, 决定 ⑩); an empty slot means "call without a credential" —
 * a fixture MCP server or a public read-only API needs none, and refusing would make those
 * unusable. `connected_account` reads the caller's own slot and, like the single-gate resolver,
 * refuses when it is empty: an authenticated system must never be called as nobody.
 * `SharedEnvCredentialResolver` cannot serve N instances from one process environment.
 */
export class HostedCredentialResolver implements CredentialResolver {
  private readonly store: ConnectedAccountStore;
  private readonly mode: 'shared' | 'connected_account';

  constructor(store: ConnectedAccountStore, mode: 'shared' | 'connected_account') {
    this.store = store;
    this.mode = mode;
  }

  async resolve(onBehalfOf: string | undefined): Promise<ResolvedCredential> {
    if (this.mode === 'shared') {
      return (await this.store.get(GATE_SHARED_CREDENTIAL_SLOT)) ?? {};
    }
    if (!onBehalfOf) {
      throw new CredentialResolutionError(
        'ConnectedAccount credential resolution requires on_behalf_of',
      );
    }
    const credential = await this.store.get(onBehalfOf);
    if (!credential) {
      throw new CredentialResolutionError(`no ConnectedAccount credential for "${onBehalfOf}"`);
    }
    return credential;
  }
}
