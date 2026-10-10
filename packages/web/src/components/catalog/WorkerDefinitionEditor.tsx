import {
  type AvailableGateInstanceWire,
  WORKER_DEFINITION_KIND_VALUES,
  type WorkerDefinitionKind,
} from '@nexttime/shared';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { actionHint, actionLabel } from '../../lib/capability-labels.js';
import { type EgressDenyNormalization, normalizeEgressDenyText } from '../../lib/catalog-input.js';
import {
  capabilityModeLabel,
  egressHostSuggestions,
  groupCapabilitiesByMode,
} from '../../lib/catalog-pickers.js';
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
import { hrefs } from '../../lib/router.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { definitionName } from '../../lib/tasks.js';
import { ModelHealthNote, ModelOption } from '../kit/model-health.js';
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
  /** After a publish from the success screen (`DraftProposed`'s `onPublished`). */
  readonly onPublished?: () => void;
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
 * The capability checklist (console-ux-3): `list_capability_names` returns 100+ names, so they are
 * grouped by the `mode` each row already carries (observe / write / propose / execute), with a
 * name filter and a "select all" per group that acts on the rows the filter leaves visible.
 * Selected names outside the directory are kept in their own group, as `CheckboxListField` does.
 */
function CapabilityPickerField({
  hint,
  error,
  required,
  rows,
  selected,
  onChange,
  disabled,
  emptyHint,
}: {
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly rows: readonly CapabilityNameRow[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly disabled?: boolean;
  readonly emptyHint: ReactNode;
}) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const known = new Set(rows.map((row) => row.name));
  const extraRows = selected
    .filter((name) => !known.has(name))
    .map((name) => ({ name, mode: '__unlisted__' }));
  const groups = groupCapabilitiesByMode([...rows, ...extraRows], filter, (name) =>
    actionLabel(name, t),
  );
  const filtering = filter.trim() !== '';

  function setGroup(names: readonly string[], on: boolean): void {
    if (on) onChange([...selected, ...names.filter((name) => !selected.includes(name))]);
    else onChange(selected.filter((name) => !names.includes(name)));
  }

  function toggleCollapsed(mode: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(mode)) next.delete(mode);
      else next.add(mode);
      return next;
    });
  }

  return (
    <div className="field" data-testid="wd-capabilities">
      <span className="field-label">
        {t('能力', 'capabilities')}
        {required ? (
          <span className="field-required" aria-hidden>
            *
          </span>
        ) : null}
      </span>
      {rows.length + extraRows.length === 0 ? (
        <p className="text-3 text-small">{emptyHint}</p>
      ) : (
        <>
          <div className="row-wrap">
            <Input
              id="wd-capabilities-filter"
              aria-label={t('筛选能力', 'Filter capabilities')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('按名称筛选…', 'Filter by name…')}
              mono
              data-testid="wd-capabilities-filter"
            />
            <span className="text-3 text-small" data-testid="wd-capabilities-count">
              {t(`已选 ${selected.length} 个`, `${selected.length} selected`)}
            </span>
          </div>
          {groups.length === 0 ? (
            <p className="text-3 text-small" data-testid="wd-capabilities-no-match">
              {t('没有名称匹配的能力。', 'No capability name matches.')}
            </p>
          ) : null}
          {groups.map((group) => {
            const names = group.rows.map((row) => row.name);
            const allOn = names.every((name) => selected.includes(name));
            const pickedInGroup = names.filter((name) => selected.includes(name)).length;
            const groupLabel =
              group.mode === '__unlisted__'
                ? t('目录外（已选）', 'Not in the directory (selected)')
                : capabilityModeLabel(group.mode, t);
            const open = filtering || !collapsed.has(group.mode);
            return (
              <fieldset
                key={group.mode}
                className="stack-s"
                aria-label={groupLabel}
                data-testid={`wd-capabilities-group-${group.mode}`}
              >
                <div className="row-wrap">
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => toggleCollapsed(group.mode)}
                    aria-expanded={open}
                    disabled={filtering}
                  >
                    {open ? '▾' : '▸'} {groupLabel} ({pickedInGroup}/{names.length})
                  </Button>
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => setGroup(names, !allOn)}
                    disabled={disabled}
                    data-testid={`wd-capabilities-group-toggle-${group.mode}`}
                  >
                    {allOn
                      ? filtering
                        ? t('取消选择筛选结果', 'Clear the filtered ones')
                        : t('取消本组', 'Clear group')
                      : filtering
                        ? t('全选筛选结果', 'Select the filtered ones')
                        : t('全选本组', 'Select group')}
                  </Button>
                </div>
                {open
                  ? group.rows.map((row) => (
                      <label className="checkbox" key={row.name}>
                        <input
                          type="checkbox"
                          checked={selected.includes(row.name)}
                          onChange={() => setGroup([row.name], !selected.includes(row.name))}
                          disabled={disabled}
                        />
                        {/* Audit P1-8: what it does first, the registry name as the secondary
                         *  text a builder recognizes from docs and errors. */}
                        <span title={actionHint(row.name, t) ?? undefined}>
                          {actionLabel(row.name, t)}{' '}
                          <span className="mono text-3 text-small">{row.name}</span>
                        </span>
                      </label>
                    ))
                  : null}
              </fieldset>
            );
          })}
        </>
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
 * `publish_worker_definition{definitionId, version}` with a "在「我的草稿」等你发布" reminder (R6 —
 * `CatalogPage.tsx`'s Workers tab now lists the caller's own drafts under "我的草稿", but this
 * editor's own success screen is still the fastest path to publish, so it keeps the focus-on-
 * "发布" nudge) and starts with keyboard focus on "发布".
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
  onPublished,
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
  /** The last egress-deny normalization's rewrites, shown under the field until the next edit. */
  const [egressChanges, setEgressChanges] = useState<EgressDenyNormalization['changes']>([]);
  const content = useMemo(() => workerDefinitionContentFromForm(form), [form]);
  // console-ux-3: the hosts of the systems this workspace has enabled are offered as one-click
  // egress-deny entries (`list_available_gate_instances` rows with a `gatekeeperId`, member-visible)
  // — a Worker that must reach them only through its gates can be fenced off from them directly.
  const gateInstances = useCapabilityList<AvailableGateInstanceWire>(
    http,
    'list_available_gate_instances',
    {},
    { autoLoadAll: true },
  );

  /** console-ux-2: the proxy matches a deny entry against the request's bare hostname
   *  (`matchesSuffix`, `@nexttime/shared` net-address.ts), so a pasted URL, a port or a leading
   *  "*." / "." never matched anything. Reduce every entry to its host, on blur and on submit. */
  function normalizeEgressDeny(current: WorkerDefinitionForm): WorkerDefinitionForm {
    const normalized = normalizeEgressDenyText(current.egressDeny);
    setEgressChanges(normalized.changes);
    return normalized.text === current.egressDeny
      ? current
      : { ...current, egressDeny: normalized.text };
  }

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
    const normalizedForm = normalizeEgressDeny(form);
    if (normalizedForm !== form) setForm(normalizedForm);
    const validated = validateWorkerDefinition(normalizedForm, t);
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
        kind: normalizedForm.kind,
        definition: validated.value,
      });
      setProposed({ ...result, name: normalizedForm.name.trim() || undefined });
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
        kindLabel={t('Worker 定义', 'Worker definition')}
        draft={proposed}
        detailHref={hrefs.catalog('workers', `${proposed.id}@${proposed.version}`)}
        onPublish={
          permissions.isDenied('publish_worker_definition')
            ? undefined
            : (review) =>
                http.call<{ status: string }>('publish_worker_definition', {
                  definitionId: proposed.id,
                  version: proposed.version,
                  ...review,
                })
        }
        onDone={onDone}
        onPublished={onPublished}
        unpublishedConsequence={t(
          '不发布的话，这份草稿只会留在 Worker 目录的「我的草稿」里，工作区其他成员都看不到、也无法委派给它，且 30 天未更新会被自动清理（也可以随时手动丢弃）——确认无误就现在点击「发布」。',
          'Left unpublished, this draft only sits under “My drafts” on the Workers tab — no one ' +
            'else in the workspace can see or delegate to it, and it is automatically cleaned up ' +
            'after 30 days with no update (or discarded manually at any time). Publish now if it ' +
            'is ready.',
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
  const egressSuggestions =
    gateInstances.state.status === 'ready'
      ? egressHostSuggestions(gateInstances.state.data.items, splitList(form.egressDeny))
      : [];
  const gateInstancesRefused =
    gateInstances.state.status === 'error' && isForbiddenError(gateInstances.state.error);
  const enabledInstanceCount =
    gateInstances.state.status === 'ready'
      ? gateInstances.state.data.items.filter((row) => row.gatekeeperId !== null).length
      : 0;

  function addEgressHost(host: string): void {
    update('egressDeny', joinList([...splitList(form.egressDeny), host]));
    setEgressChanges([]);
  }

  const newVersionName = newVersionOf
    ? (definitionName([newVersionOf], newVersionOf.id, newVersionOf.version) ?? newVersionOf.id)
    : null;

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="worker-definition-editor"
    >
      {newVersionOf ? (
        <Notice testId="worker-new-version-notice">
          {t(
            <>
              为 <strong>{newVersionName}</strong> 提议下一个版本（当前 v{newVersionOf.version}
              ）：沿用同一个定义，类型不可更改；发布前只有你可见。
            </>,
            <>
              Proposing the next version of <strong>{newVersionName}</strong> (current v
              {newVersionOf.version}): same definition, the kind cannot change; private to you until
              published.
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
        ariaLabel={t('Worker 定义视图', 'Worker definition view')}
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
            'Worker 定义（JSON）',
            'Worker definition (JSON)',
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
                  <ModelOption key={model.id} model={model} selected={model.id === form.model} />
                ))}
              </Select>
              <ModelHealthNote
                models={modelOptions}
                selectedId={form.model}
                canFix={false}
                testId="wd-model-health"
              />
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
            <CapabilityPickerField
              required={!isWorker}
              hint={
                isWorker
                  ? t(
                      '未勾选 = 平台 Worker 上限去掉执行类能力。执行类动作仍需审批（按策略自动批准或人工审批）。',
                      'None checked = the worker ceiling minus execute-class capabilities. ' +
                        'Execute-class actions still require approval either way (auto-approved ' +
                        'by policy, or by a person).',
                    )
                  : t(
                      '必须在 entry 上限之内（内核校验）。',
                      'Must fit the entry ceiling (kernel-checked).',
                    )
              }
              error={fieldError('capabilities')}
              rows={capabilityNames ?? []}
              selected={splitList(form.capabilities)}
              onChange={(next) => update('capabilities', joinList(next))}
              disabled={busy}
              emptyHint={t(
                '暂无可选能力（能力目录尚未加载或为空）。',
                'No capabilities available yet (the capability directory has not loaded, or is empty).',
              )}
            />
            <Field
              id="wd-egress-deny"
              label={t('出网拒绝', 'egressDeny')}
              hint={
                <>
                  {t(
                    '每行一个主机名，例如 internal.example——同时拒绝它的所有子域名；命中的出网请求会被拒绝，叠加在平台的固定拒绝清单之上；可留空（不额外收紧）。粘贴的网址会自动只保留主机名（去掉 https://、路径和端口）。',
                    'One hostname per line, e.g. internal.example — every subdomain is denied too; a matching egress request is denied on top of the platform’s own fixed deny list; optional (blank tightens nothing further). A pasted URL is reduced to its hostname (scheme, path and port removed).',
                  )}
                  {egressChanges.length > 0 ? (
                    <span className="block" data-testid="wd-egress-deny-normalized">
                      {t('已转换：', 'Converted: ')}
                      {egressChanges
                        .map((change) =>
                          change.to === ''
                            ? t(
                                `${change.from}（无主机名，已去掉）`,
                                `${change.from} (no hostname, removed)`,
                              )
                            : `${change.from} → ${change.to}`,
                        )
                        .join(t('；', '; '))}
                    </span>
                  ) : null}
                </>
              }
              error={fieldError('egressDeny')}
            >
              <Textarea
                id="wd-egress-deny"
                value={form.egressDeny}
                onChange={(event) => {
                  update('egressDeny', event.target.value);
                  setEgressChanges([]);
                }}
                onBlur={() => setForm((prev) => normalizeEgressDeny(prev))}
                rows={4}
                mono
                disabled={busy}
                invalid={!!errors.egressDeny}
                placeholder="internal.example"
              />
              {egressSuggestions.length > 0 ? (
                <div className="row-wrap" data-testid="wd-egress-suggestions">
                  <span className="text-3 text-small">
                    {t('工作区系统的主机：', 'Hosts of this workspace’s systems:')}
                  </span>
                  {egressSuggestions.map((suggestion) => (
                    <Button
                      key={suggestion.host}
                      variant="ghost"
                      size="s"
                      onClick={() => addEgressHost(suggestion.host)}
                      disabled={busy}
                      title={suggestion.systems.join(', ')}
                      data-testid="wd-egress-suggestion"
                    >
                      + {suggestion.host}
                    </Button>
                  ))}
                </div>
              ) : gateInstances.state.status === 'loading' ? (
                <span className="text-3 text-small" data-testid="wd-egress-suggestions-loading">
                  {t('正在读取工作区系统的主机…', 'Reading the hosts of this workspace’s systems…')}
                </span>
              ) : gateInstancesRefused ? (
                <span className="text-3 text-small" data-testid="wd-egress-suggestions-refused">
                  {t(
                    '无权读取工作区的系统列表，请手动输入主机名。',
                    'Not allowed to read this workspace’s systems — type the hostnames instead.',
                  )}
                </span>
              ) : gateInstances.state.status === 'ready' ? (
                <span className="text-3 text-small" data-testid="wd-egress-suggestions-empty">
                  {enabledInstanceCount === 0
                    ? t(
                        '工作区还没有启用平台门实例，没有可推荐的主机。',
                        'No platform gate instance is enabled in this workspace — no host to suggest.',
                      )
                    : t(
                        '工作区系统的主机都已在列表中。',
                        'Every host of this workspace’s systems is already listed.',
                      )}
                </span>
              ) : null}
              {gateInstances.state.status === 'error' && !gateInstancesRefused ? (
                <ErrorBanner
                  error={gateInstances.state.error}
                  title={t('无法读取工作区的系统列表', 'Could not read this workspace’s systems')}
                  onRetry={() => void gateInstances.reload()}
                  testId="wd-egress-suggestions-error"
                />
              ) : null}
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
              {/* Audit P1-7: an empty gate list is legal but almost never meant — say what it
               *  means before the draft is proposed, not after the Worker fails to reach anything. */}
              {(gatekeepers ?? []).length > 0 && splitList(form.gates).length === 0 ? (
                <Notice tone="warn" testId="wd-gates-none-warning">
                  {t(
                    '没有勾选门：这个 Worker 碰不到任何系统，委派给它的任务只能做不需要系统的事。',
                    'No gate ticked: this Worker reaches no system, so delegated tasks can only do work that needs none.',
                  )}
                </Notice>
              ) : null}
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
