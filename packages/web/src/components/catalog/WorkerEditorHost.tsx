import { useCapabilityList } from '../../hooks/useCapability.js';
import type { WorkerDefinitionForm } from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type {
  CapabilityNameRow,
  GatekeeperListRow,
  ModelRow,
  SkillRow,
} from '../../lib/governance.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { WorkerDefinitionEditor } from './WorkerDefinitionEditor.js';

/** Loads the picker directories (`list_models`, `list_gatekeepers`, `list_skills`) only while the
 *  Worker editor is open — member-level reads, cached per session by `useCapabilityList`; the
 *  editor degrades to raw ids/names without them (same convention `ProcedureEditorHost` above
 *  already established). `list_skills` uses `autoLoadAll` (it is keyset-paginated, S8 W1-C) so the
 *  skills picker never silently hides a published Skill past the first page — same reasoning as
 *  `ProcedureEditorHost`'s own `list_worker_definitions` load. `capabilityNames` (S8 W3 K2, leftover
 *  84) is a prop, not a hook call here — `WorkersTab` above already loads it (the "从模板创建" button
 *  needs it loaded *before* this host ever mounts), so this component reuses that same load rather
 *  than opening a second one. */
export function WorkerEditorHost({
  http,
  newVersionOf,
  initialForm,
  capabilityNames,
  onProposed,
  onDone,
}: {
  readonly http: CapabilityCaller;
  readonly newVersionOf?: WorkerDefinitionSummary;
  readonly initialForm?: WorkerDefinitionForm;
  readonly capabilityNames?: readonly CapabilityNameRow[];
  readonly onProposed: () => void;
  readonly onDone: () => void;
}) {
  const models = useCapabilityList<ModelRow>(http, 'list_models');
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const skills = useCapabilityList<SkillRow>(http, 'list_skills', {}, { autoLoadAll: true });
  return (
    <WorkerDefinitionEditor
      http={http}
      newVersionOf={newVersionOf}
      initialForm={initialForm}
      models={models.state.status === 'ready' ? models.state.data.items : undefined}
      capabilityNames={capabilityNames}
      gatekeepers={gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : undefined}
      skills={skills.state.status === 'ready' ? skills.state.data.items : undefined}
      onProposed={onProposed}
      onDone={onDone}
    />
  );
}
