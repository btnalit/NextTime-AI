import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { ProcedureRow } from '../../lib/governance.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { useGatekeeperDirectory } from '../approvals/useDirectoryNames.js';
import { ProcedureEditor } from './ProcedureEditor.js';

/** Loads the pickers' directories only while the Procedure editor is open (member-level reads,
 *  cached per session by `useCapabilityList`/`useGatekeeperDirectory`); the editor degrades to
 *  typed ids without them. */
export function ProcedureEditorHost({
  http,
  copyOf,
  onProposed,
  onDone,
  onPublished,
}: {
  readonly http: CapabilityCaller;
  readonly copyOf?: ProcedureRow;
  readonly onProposed: () => void;
  readonly onDone: () => void;
  readonly onPublished?: () => void;
}) {
  // G7 (closing wave C6): the shared directory (`useDirectoryNames.tsx`) — was its own
  // `useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers')`.
  const gatekeepers = useGatekeeperDirectory(http);
  // A step picker, not a browsable list — autoLoadAll so a workspace with > 100 published Worker
  // definitions still offers every one of them, not just the first page (S8 W1-A4).
  const definitions = useCapabilityList<WorkerDefinitionSummary>(
    http,
    'list_worker_definitions',
    {},
    { autoLoadAll: true },
  );
  return (
    <ProcedureEditor
      http={http}
      copyOf={copyOf}
      gatekeepers={gatekeepers.rows}
      workerDefinitions={
        definitions.state.status === 'ready' ? definitions.state.data.items : undefined
      }
      onProposed={onProposed}
      onDone={onDone}
      onPublished={onPublished}
    />
  );
}
