import type { HttpClient } from '../lib/http-client.js';
import { ConnectionCard } from './ConnectionCard.js';
import { NavBar } from './NavBar.js';

export interface ConnectionsPageProps {
  readonly httpClient: HttpClient;
  readonly onForgetKey: () => void;
}

/**
 * components/ConnectionsPage: "连接系统" page shell (design doc §7.6, §9.2; docs/development-
 * tasks.md S2.10 deliverable 5). S2.13 (`governance/connections`) — the module that actually
 * implements `create_connection`/`publish_manifest`/`connect_gatekeeper` — has not landed on `main`
 * as of this PR (only the capability *shapes*, from S2.1 scaffolding); see `ConnectionCard.tsx`'s
 * own module doc comment for what this page does about that.
 */
export function ConnectionsPage({ httpClient, onForgetKey }: ConnectionsPageProps) {
  return (
    <div className="page">
      <NavBar active="connections" />
      <header className="page-header">
        <h1>Connections</h1>
        <div className="header-actions">
          <button type="button" className="secondary" onClick={onForgetKey}>
            Forget key
          </button>
        </div>
      </header>

      <p className="hint">
        Connect a new system: fill in its address and credentials below. `http`/`mcp` auto-import a
        manifest draft for the workspace owner to publish (S2.13, not yet implemented on this kernel
        build — see the note below the form after submitting).
      </p>

      <ConnectionCard httpClient={httpClient} />
    </div>
  );
}
