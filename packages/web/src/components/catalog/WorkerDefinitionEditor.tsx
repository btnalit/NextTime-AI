import { WORKER_DEFINITION_KIND_VALUES, type WorkerDefinitionKind } from '@nexttime/shared';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
import {
  EMPTY_WORKER_DEFINITION_FORM,
  type FieldErrors,
  type WorkerDefinitionForm,
  joinList,
  splitList,
  validateWorkerDefinition,
  workerDefinitionContentFromForm,
  workerDefinitionFormFromWire,
} from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import type {
  CapabilityNameRow,
  GatekeeperListRow,
  ModelRow,
  SkillRow,
} from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { workerDefinitionKindLabel } from '../../lib/labels.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { definitionName } from '../../lib/tasks.js';
import { Button } from '../ui/Button.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select, Textarea, describedBy } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { Tabs } from '../ui/Tabs.js';
import { DraftProposed, type ProposedDraft } from './DraftProposed.js';
import { JsonEditor } from './JsonEditor.js';

export interface WorkerDefinitionEditorProps {
  readonly http: CapabilityCaller;
  /** "编辑（生成新草稿版本）": `propose_worker_definition{definitionId}` proposes the next version
   *  under this family — `kind` is immutable per family and locked here. */
  readonly newVersionOf?: WorkerDefinitionSummary;
  /** J7/CW1 "从模板创建（ops-runner）": prefills a brand-new draft (`lib/catalog.ts`'s
   *  `opsRunnerTemplateForm()`) instead of starting blank. Ignored when `newVersionOf` is given —
   *  editing an existing family always prefills from that row, never from a template. */
  readonly initialForm?: WorkerDefinitionForm;
  /** `list_models` rows for the model dropdown (optional — still loading, or unavailable). */
  readonly models?: readonly ModelRow[];
  /** `list_capability_names` rows for the capabilities picker (optional). */
  readonly capabilityNames?: readonly CapabilityNameRow[];
  /** `list_gatekeepers` rows for the gates picker (optional). */
  readonly gatekeepers?: readonly GatekeeperListRow[];
  /** `list_skills` rows for the skills picker (optional) — filtered to `status === 'published'`
   *  here (a draft Skill is private to its own proposer, not a usable reference for anyone else's
   *  WorkerDefinition). */
  readonly skills?: readonly SkillRow[];
  readonly onProposed: (draft: ProposedDraft) => void;
  readonly onDone: () => void;
}

type View = 'form' | 'json';

function toggleListItem(list: readonly string[], value: string): readonly string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

interface CheckboxOption {
  readonly id: string;
  readonly label: ReactNode;
}

/** A `<fieldset>` of checkboxes over a directory list (capabilities / gates / skills) — the same
 *  "checklist + own inherit-less selection" shape `AgentProfileForm.tsx`'s local `ChecklistField`
 *  already established for exactly this kind of picker, minus the "inherit workspace default"
 *  toggle (no such semantics exist for a WorkerDefinition's own declared needs). Never silently
 *  drops an already-selected id/name just because the loaded directory does not carry it (still
 *  loading, a 403, or a value the directory no longer lists) — `extra` appends it after the
 *  directory's own options, labeled with the raw value itself, so a pre-filled selection is always
 *  visible and never lost on submit. */
function CheckboxListField({
  legend,
  hint,
  error,
  required,
  options,
  selected,
  onToggle,
  disabled,
  testId,
  emptyHint,
}: {
  readonly legend: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly options: readonly CheckboxOption[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly emptyHint: ReactNode;
}) {
  const known = new Set(options.map((option) => option.id));
  const extra = selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id }));
  const rendered = [...options, ...extra];
  return (
    <div className="field" data-testid={testId}>
      <span className="field-label">
        {legend}
        {required ? (
          <span className="field-required" aria-hidden>
            *
          </span>
        ) : null}
      </span>
      {rendered.length === 0 ? (
        <p className="text-3 text-small">{emptyHint}</p>
      ) : (
        <fieldset className="stack-s" aria-label={typeof legend === 'string' ? legend : testId}>
          {rendered.map((option) => (
            <label className="checkbox" key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={() => onToggle(option.id)}
                disabled={disabled}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {hint !== undefined && !error ? <p className="field-hint">{hint}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * components/catalog/WorkerDefinitionEditor (S6-A A2 — docs/console-completion-plan.md §5.3;
 * S8 W2 U2, audit J7/R6/CW1): `kind` (entry / worker) plus the kind-specific `definition` record
 * (packages/shared/src/worker-definition.ts — systemPrompt, model, name, description,
 * capabilities, gates / skills for a worker, egressDeny) as a form with a JSON view. Capabilities /
 * gates / skills are pickers over `list_capability_names` / `list_gatekeepers` / `list_skills`
 * (never free text — J7); the underlying form fields stay the same newline-joined strings
 * `lib/catalog.ts` already validates/serializes (`splitList`/`joinList` convert at the picker
 * boundary only), so the JSON view and `propose_worker_definition{definition}` payload are
 * unchanged by this. `model` is a dropdown over `list_models` with an explicit "留空 = 使用工作区
 * 默认" option (the schema field is optional — `workerDefinitionContentFromForm` already omits it
 * when blank). A brand-new draft (`newVersionOf` absent) may only be `kind='worker'` — the
 * `WORKER_DEFINITION_KIND_VALUES` `entry` option is only offered when editing an existing family
 * (`newVersionOf.kind === 'entry'`), matching the audit's "owner 视角隐藏 kind=entry" (new entry
 * definitions are not a console-reachable action; an existing entry family's next version still
 * is, same as today). Submit validates with `workerDefinitionContentSchemaFor(kind)` and calls
 * `propose_worker_definition{definitionId?, kind, definition}`; the success state offers
 * `publish_worker_definition{definitionId, version}` with an explicit "不发布就找不回" consequence
 * (R6 — `list_worker_definitions` never returns drafts, so this editor's own success screen is the
 * only place a fresh draft's id is ever shown) and starts with keyboard focus on "发布".
 */
export function WorkerDefinitionEditor({
  http,
  newVersionOf,
  initialForm,
  models,
  capabilityNames,
  gatekeepers,
  skills,
  onProposed,
  onDone,
}: WorkerDefinitionEditorProps) {
  const t = useT();
  const permissions = usePermissions();
  const [form, setForm] = useState<WorkerDefinitionForm>(() =>
    newVersionOf
      ? workerDefinitionFormFromWire(
          newVersionOf.kind as WorkerDefinitionKind,
          newVersionOf.definition,
        )
      : (initialForm ?? EMPTY_WORKER_DEFINITION_FORM),
  );
  const [view, setView] = useState<View>('form');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [proposed, setProposed] = useState<ProposedDraft | null>(null);
  const content = useMemo(() => workerDefinitionContentFromForm(form), [form]);

  function update<K extends keyof WorkerDefinitionForm>(key: K, value: WorkerDefinitionForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  function applyJson(value: Record<string, unknown>): void {
    setForm(workerDefinitionFormFromWire(form.kind, value));
    setErrors({});
    setView('form');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const validated = validateWorkerDefinition(form);
    if (!validated.ok) {
      setErrors(validated.errors);
      setView('form');
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      const result = await http.call<ProposedDraft>('propose_worker_definition', {
        ...(newVersionOf ? { definitionId: newVersionOf.id } : {}),
        kind: form.kind,
        definition: validated.value,
      });
      setProposed({ ...result, name: form.name.trim() || undefined });
      onProposed(result);
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('propose_worker_definition');
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (proposed) {
    return (
      <DraftProposed
        kindLabel="Worker definition"
        draft={proposed}
        onPublish={
          permissions.isDenied('publish_worker_definition')
            ? undefined
            : () =>
                http.call<{ status: string }>('publish_worker_definition', {
                  definitionId: proposed.id,
                  version: proposed.version,
                })
        }
        onDone={onDone}
        unpublishedConsequence={t(
          'Worker 目录只显示已发布版本，这份草稿不会出现在任何列表里——不发布的话，之后只能凭上面的 id 续写。确认无误就现在点击「发布」。',
          'The Workers tab lists published versions only, so this draft will not appear in any list — unpublished, it can only be resumed later from the id above. Publish now if it is ready.',
        )}
      />
    );
  }

  const isWorker = form.kind === 'worker';
  const fieldError = (name: string) => errors[name] || null;
  // J7 "owner 视角隐藏 kind=entry": a brand-new draft may only start a `worker` family — an
  // `entry` WorkerDefinition is never created from scratch here, only carried forward as the next
  // version of an existing entry family (`newVersionOf.kind === 'entry'`, the select stays locked
  // below same as before).
  const kindOptions = newVersionOf
    ? WORKER_DEFINITION_KIND_VALUES
    : WORKER_DEFINITION_KIND_VALUES.filter((kind) => kind !== 'entry');
  const modelOptions = models ?? [];
  const modelValueKnown = form.model === '' || modelOptions.some((m) => m.id === form.model);
  const publishedSkills = (skills ?? []).filter((skill) => skill.status === 'published');

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="worker-definition-editor"
    >
      {newVersionOf ? (
        <Notice testId="worker-new-version-notice">
          为{' '}
          <strong>
            {definitionName([newVersionOf], newVersionOf.id, newVersionOf.version) ??
              newVersionOf.id}
          </strong>{' '}
          {t(
            <>
              提议下一个版本（当前 v{newVersionOf.version}）：同一 definitionId，kind
              不可更改；发布前只有你可见。
            </>,
            <>
              Proposing the next version of this family (current v{newVersionOf.version}): same
              definitionId, kind is immutable; private to you until published.
            </>,
          )}
        </Notice>
      ) : (
        <Notice testId="worker-private-notice">
          {initialForm
            ? t(
                '已用 ops-runner 模板预填——检查/按需调整后再保存草稿，然后发布。草稿只有你（提议者）可见，发布后所有成员可见。',
                'Prefilled from the ops-runner template — review or adjust before saving the draft, then publish. The draft is private to you until published.',
              )
            : t(
                '新建一个 WorkerDefinition 族（v1）。草稿只有你（提议者）可见，发布后所有成员可见。',
                'Starts a new WorkerDefinition family (v1). The draft is private to you until published.',
              )}
        </Notice>
      )}

      <Tabs<View>
        ariaLabel="Worker definition view"
        value={view}
        onChange={setView}
        options={[
          { value: 'form', label: t('表单', 'Form'), testId: 'worker-view-form' },
          { value: 'json', label: 'JSON', testId: 'worker-view-json' },
        ]}
      />

      {view === 'json' ? (
        <JsonEditor
          label={t(
            'definition（propose_worker_definition 的 definition 字段）',
            'The definition record',
          )}
          value={content}
          onApply={applyJson}
          disabled={busy}
          testId="worker-json"
        />
      ) : (
        <>
          <div className="row-wrap">
            <Field
              id="wd-kind"
              label={t('类型', 'kind')}
              hint={t(
                '入口定义 = 用户的入口智能体（能力有上限）；Worker 定义 = 被委派执行任务的 Worker。新建只能是 Worker 定义，入口定义只能由已有的入口定义续写下一版本。',
                "Entry definition = the user's entry agent (capability ceiling); Worker definition = a Worker tasks are delegated to. A new draft can only be a Worker definition — an entry definition only continues as the next version of an existing one.",
              )}
            >
              <Select
                id="wd-kind"
                value={form.kind}
                onChange={(event) => update('kind', event.target.value as WorkerDefinitionKind)}
                disabled={busy || newVersionOf !== undefined || kindOptions.length <= 1}
                data-testid="wd-kind"
              >
                {kindOptions.map((kind) => (
                  <option key={kind} value={kind}>
                    {workerDefinitionKindLabel(kind, t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="wd-name" label={t('名称', 'name')} error={fieldError('name')}>
              <Input
                id="wd-name"
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                disabled={busy}
                invalid={!!errors.name}
              />
            </Field>
            <Field
              id="wd-model"
              label={t('模型', 'model')}
              hint={t(
                '可选模型来自工作区的模型清单。',
                "Options come from the workspace's model list.",
              )}
              error={fieldError('model')}
            >
              <Select
                id="wd-model"
                value={form.model}
                onChange={(event) => update('model', event.target.value)}
                disabled={busy}
                invalid={!!errors.model}
              >
                <option value="">
                  {t('留空 = 使用工作区默认', 'Blank = use the workspace default')}
                </option>
                {!modelValueKnown ? <option value={form.model}>{form.model}</option> : null}
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            id="wd-description"
            label={t('描述', 'description')}
            error={fieldError('description')}
          >
            <Input
              id="wd-description"
              value={form.description}
              onChange={(event) => update('description', event.target.value)}
              disabled={busy}
              invalid={!!errors.description}
            />
          </Field>
          <Field
            id="wd-system-prompt"
            label={t('系统提示词', 'systemPrompt')}
            required
            error={fieldError('systemPrompt')}
          >
            <Textarea
              id="wd-system-prompt"
              value={form.systemPrompt}
              onChange={(event) => update('systemPrompt', event.target.value)}
              rows={8}
              disabled={busy}
              invalid={!!errors.systemPrompt}
              aria-describedby={describedBy('wd-system-prompt', false, !!errors.systemPrompt)}
            />
          </Field>
          <div className="row-wrap">
            <CheckboxListField
              legend={t('能力', 'capabilities')}
              required={!isWorker}
              hint={
                isWorker
                  ? t(
                      '未勾选 = 平台 Worker 上限去掉执行类能力。',
                      'None checked = the worker ceiling minus execute-class capabilities.',
                    )
                  : t(
                      '必须在 entry 上限之内（内核校验）。',
                      'Must fit the entry ceiling (kernel-checked).',
                    )
              }
              error={fieldError('capabilities')}
              options={(capabilityNames ?? []).map((c) => ({ id: c.name, label: c.name }))}
              selected={splitList(form.capabilities)}
              onToggle={(name) =>
                update('capabilities', joinList(toggleListItem(splitList(form.capabilities), name)))
              }
              disabled={busy}
              testId="wd-capabilities"
              emptyHint={t(
                '暂无可选能力（能力目录尚未加载或为空）。',
                'No capabilities available yet (the capability directory has not loaded, or is empty).',
              )}
            />
            <Field
              id="wd-egress-deny"
              label={t('出网拒绝', 'egressDeny')}
              hint={t(
                '每行一个主机名或 .后缀（如 .internal.example，匹配该域名及其所有子域名）；命中的出网请求会被拒绝，叠加在平台的固定拒绝清单之上；可留空（不额外收紧）。',
                'One hostname or .suffix per line (e.g. .internal.example, matching that domain and every subdomain); a matching egress request is denied, on top of the platform’s own fixed deny list; optional (leaving it blank tightens nothing further).',
              )}
              error={fieldError('egressDeny')}
            >
              <Textarea
                id="wd-egress-deny"
                value={form.egressDeny}
                onChange={(event) => update('egressDeny', event.target.value)}
                rows={4}
                mono
                disabled={busy}
                invalid={!!errors.egressDeny}
              />
            </Field>
          </div>
          {isWorker ? (
            <div className="row-wrap">
              <CheckboxListField
                legend={t('可作用的门', 'gates')}
                hint={t(
                  '工作区已注册的系统；未勾选 = 不授予任何门。',
                  "The workspace's registered systems; none checked = no gates granted.",
                )}
                error={fieldError('gates')}
                options={(gatekeepers ?? []).map((g) => ({ id: g.id, label: g.name }))}
                selected={splitList(form.gates)}
                onToggle={(id) =>
                  update('gates', joinList(toggleListItem(splitList(form.gates), id)))
                }
                disabled={busy}
                testId="wd-gates"
                emptyHint={t(
                  '工作区还没有注册系统。',
                  'No systems registered in this workspace yet.',
                )}
              />
              <CheckboxListField
                legend={t('使用的 Skill', 'skills')}
                hint={t(
                  '已发布的 Skill；未勾选 = 不装载任何 Skill。',
                  'Published Skills; none checked = no Skill mounted.',
                )}
                error={fieldError('skills')}
                options={publishedSkills.map((skill) => ({ id: skill.name, label: skill.name }))}
                selected={splitList(form.skills)}
                onToggle={(name) =>
                  update('skills', joinList(toggleListItem(splitList(form.skills), name)))
                }
                disabled={busy}
                testId="wd-skills"
                emptyHint={t('还没有已发布的 Skill。', 'No published Skills yet.')}
              />
            </div>
          ) : null}
        </>
      )}

      {error !== null ? (
        <ErrorBanner
          error={error}
          title={t('无法创建草稿', 'Could not propose the draft')}
          testId="worker-editor-error"
        />
      ) : null}

      <div className="row">
        <Button type="submit" variant="primary" loading={busy} data-testid="worker-submit">
          {t('保存草稿', 'Save draft')}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          {t('取消', 'Cancel')}
        </Button>
      </div>
    </form>
  );
}
