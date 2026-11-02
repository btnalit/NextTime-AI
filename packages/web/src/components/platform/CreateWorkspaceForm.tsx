import type { PlatformWorkspaceWire } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { ModelRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { useGuardedClose } from '../kit/discard-guard.js';
import { StillNeeded } from '../kit/still-needed.js';
import { Button } from '../ui/Button.js';
import { Field, Input, Select } from '../ui/Field.js';
import { PlatformError } from './PlatformError.js';
import { UserPicker } from './UserPicker.js';
import { AllowedModelsChecklist, EntryModelSelect } from './WorkspaceModelControls.js';

export interface CreateWorkspaceFormProps {
  readonly http: CapabilityCaller;
  /** The llm-proxy catalog (`list_platform_models`) — the allowed-model checklist's universe. */
  readonly models: readonly ModelRow[];
  /** The signed-in administrator's user id: the first owner defaults to them (the usual case —
   *  an admin creating a workspace for themselves), still changeable in the picker. Omitted = no
   *  default. The form itself cannot know the current user; the page passes it when it does. */
  readonly defaultOwnerUserId?: string;
  /** 用途 preselected (the 管理员智能体 page's 新建试验工作区 opens the form on 试验). */
  readonly defaultPurpose?: 'standard' | 'admin_trial';
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
 *
 * 用途 (S11 AA3a, `create_workspace {purpose}`): 常规 (omitted on the wire) or 试验 — a trial
 * workspace, the only kind a platform administrator's admin agent acts in. It is fixed for good
 * (the kernel refuses a change either way, migration core 0050) and never the platform default, so
 * the hint says both before the workspace exists. 临时 stays the CLI's (it also sets the expiry).
 */
export function CreateWorkspaceForm({
  http,
  models,
  defaultOwnerUserId,
  defaultPurpose = 'standard',
  onCreated,
  onCancel,
}: CreateWorkspaceFormProps) {
  // Legacy 497: in a drawer whose form was edited, 取消 asks before discarding it.
  const guardedClose = useGuardedClose();
  const t = useT();
  const [name, setName] = useState('');
  const [ownerUserId, setOwnerUserId] = useState(defaultOwnerUserId ?? '');
  const [entryModel, setEntryModel] = useState<string | null>(null);
  const [allowedModels, setAllowedModels] = useState<readonly string[]>([]);
  const [purpose, setPurpose] = useState<'standard' | 'admin_trial'>(defaultPurpose);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const catalogIds = models.map((model) => model.id);
  const entryModelOptions = allowedModels.length > 0 ? allowedModels : catalogIds;
  // Un-ticking the picked entry model drops back to 平台默认 rather than submitting a combination
  // the kernel will refuse with `entry_model_not_allowed`.
  const entryModelValue =
    entryModel !== null && entryModelOptions.includes(entryModel) ? entryModel : null;
  const ready = name.trim().length > 0 && ownerUserId !== '';
  // DoD item 4: a disabled 新建 says what it still waits for (the field labels' own words).
  const missing = [
    name.trim().length > 0 ? null : t('填写名称', 'enter a name'),
    ownerUserId !== '' ? null : t('选择首位所有者', 'pick the first owner'),
  ].filter((item): item is string => item !== null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready || submitting) return;
    const params: Record<string, unknown> = { name: name.trim(), ownerUserId };
    if (entryModelValue !== null) params.entryModel = entryModelValue;
    if (allowedModels.length > 0) params.allowedModels = [...allowedModels];
    if (purpose === 'admin_trial') params.purpose = purpose;
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
      <Field id="cw-name" label={t('名称', 'Name')} required>
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
        label={t('首位所有者', 'First owner')}
        hint={t(
          '这个用户会成为该工作区的所有者，并在「管理 → 工作区配置」里看到它。',
          "This user becomes the workspace's owner and sees it under Manage → Workspace config.",
        )}
        value={ownerUserId}
        onChange={setOwnerUserId}
        disabled={submitting}
        testId="create-workspace-owner"
      />

      <Field
        id="cw-purpose"
        label={t('用途', 'Purpose')}
        hint={
          purpose === 'admin_trial'
            ? t(
                '试验工作区是平台管理员的管理员智能体唯一能操作的工作区，用来探索和试做；那里的结果要经人应用管理员提案才进入正式工作区。创建后不能改回常规，也不能设为默认工作区。平台管理员要是它的成员，管理员智能体才能在这里工作。',
                "A trial workspace is the only workspace a platform administrator's admin agent acts in — for exploring and trying things out; what it makes there reaches other workspaces only through an admin proposal a person applies. It stays a trial workspace for good and cannot be the default workspace. The admin agent works here only for a platform administrator who is a member.",
              )
            : t(
                '常规工作区给人和他们的智能体日常使用。创建后用途不能再改。',
                'A standard workspace is for people and their agents. Its purpose cannot be changed later.',
              )
        }
      >
        <Select
          id="cw-purpose"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value as 'standard' | 'admin_trial')}
          disabled={submitting}
          data-testid="create-workspace-purpose"
        >
          <option value="standard">{t('常规', 'Standard')}</option>
          <option value="admin_trial">{t('试验（管理员智能体）', 'Trial (admin agent)')}</option>
        </Select>
      </Field>

      <EntryModelSelect
        id="cw-entry-model"
        options={entryModelOptions}
        models={models}
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
        title={t('无法新建工作区', 'Could not create this workspace')}
        testId="create-workspace-error"
      />

      <div className="row overlay-actions" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={() => guardedClose(onCancel)} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!ready}
          data-testid="create-workspace-submit"
        >
          {t('创建', 'Create')}
        </Button>
        <StillNeeded items={missing} hidden={submitting} testId="create-workspace-missing" />
      </div>
    </form>
  );
}
