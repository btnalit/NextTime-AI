import type { PlatformWorkspaceWire } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { ModelRow } from '../../lib/governance.js';
import { Button } from '../ui/Button.js';
import { Field, Input } from '../ui/Field.js';
import { PlatformError } from './PlatformError.js';
import { UserPicker } from './UserPicker.js';
import { AllowedModelsChecklist, EntryModelSelect } from './WorkspaceModelControls.js';

export interface CreateWorkspaceFormProps {
  readonly http: CapabilityCaller;
  /** The llm-proxy catalog (`list_platform_models`) — the allowed-model checklist's universe. */
  readonly models: readonly ModelRow[];
  readonly onCreated: (workspace: PlatformWorkspaceWire) => void;
  readonly onCancel: () => void;
}

/**
 * components/platform/CreateWorkspaceForm: `create_workspace` (P-A2, design §2 "多工作区只在组织
 * 需要隔离图时由管理员在「工作区配置」里新建（名称、入口模型、允许的模型…）"). The first owner is
 * an existing platform user — there is no "create a user while creating a workspace" path, since
 * `create_workspace`'s `ownerUserId` is a `platformUserId`.
 *
 * Both model fields are optional on the wire (`entryModel` omitted = pi's own default,
 * `allowedModels` omitted = every catalog model), so both are omitted rather than sent empty. The
 * entry-model options narrow to the checklist as it is ticked — `create_workspace` refuses a
 * non-empty allowed list that does not contain the entry model, and the two controls being one
 * draft here means that combination is not reachable by picking a model and then un-ticking it.
 */
export function CreateWorkspaceForm({
  http,
  models,
  onCreated,
  onCancel,
}: CreateWorkspaceFormProps) {
  const [name, setName] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [entryModel, setEntryModel] = useState<string | null>(null);
  const [allowedModels, setAllowedModels] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const catalogIds = models.map((model) => model.id);
  const entryModelOptions = allowedModels.length > 0 ? allowedModels : catalogIds;
  // Un-ticking the picked entry model drops back to 平台默认 rather than submitting a combination
  // the kernel will refuse with `entry_model_not_allowed`.
  const entryModelValue =
    entryModel !== null && entryModelOptions.includes(entryModel) ? entryModel : null;
  const ready = name.trim().length > 0 && ownerUserId !== '';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready || submitting) return;
    const params: Record<string, unknown> = { name: name.trim(), ownerUserId };
    if (entryModelValue !== null) params.entryModel = entryModelValue;
    if (allowedModels.length > 0) params.allowedModels = [...allowedModels];
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await http.call<PlatformWorkspaceWire>('create_workspace', params));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="create-workspace-form"
    >
      <Field id="cw-name" label="名称 Name" required>
        <Input
          id="cw-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={submitting}
          autoFocus
        />
      </Field>

      <UserPicker
        http={http}
        id="cw-owner"
        label="首位 owner First owner"
        hint="这个用户会成为该工作区的 owner，并在「管理 → 工作区配置」里看到它。 This user becomes the workspace's owner and sees it under 管理 → 工作区配置."
        value={ownerUserId}
        onChange={setOwnerUserId}
        disabled={submitting}
        testId="create-workspace-owner"
      />

      <EntryModelSelect
        id="cw-entry-model"
        options={entryModelOptions}
        value={entryModelValue}
        onChange={setEntryModel}
        disabled={submitting}
        testId="workspace-entry-model"
      />

      <AllowedModelsChecklist
        models={models}
        selected={allowedModels}
        onChange={setAllowedModels}
        disabled={submitting}
        testId="workspace-allowed-models"
      />

      <PlatformError
        error={error}
        title="无法新建工作区 Could not create this workspace"
        testId="create-workspace-error"
      />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          取消 Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting} disabled={!ready}>
          创建 Create
        </Button>
      </div>
    </form>
  );
}
