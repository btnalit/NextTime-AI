import { type FormEvent, useMemo, useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import {
  EMPTY_PROCEDURE_FORM,
  type FieldErrors,
  PROCEDURE_STEP_KINDS,
  type ProcedureForm,
  type ProcedureStepForm,
  type ProcedureStepKind,
  newProcedureStep,
  procedureContentFromForm,
  procedureStepFromWire,
  validateProcedure,
} from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { reviewFieldNames } from '../../lib/credential-review.js';
import { isForbiddenError } from '../../lib/errors.js';
import { type OperationChoice, useGateOperations } from '../../lib/gate-operations.js';
import type { GatekeeperListRow, ProcedureRow } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { BLAST_RADIUS_TONES } from '../../lib/status-tone.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { definitionName } from '../../lib/tasks.js';
import { Combobox } from '../kit/combobox.js';
import { Button } from '../ui/Button.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select, Textarea, describedBy } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { Tabs } from '../ui/Tabs.js';
import { DraftProposed, type ProposedDraft } from './DraftProposed.js';
import { JsonEditor } from './JsonEditor.js';

export interface ProcedureEditorProps {
  readonly http: CapabilityCaller;
  /** "编辑（生成新草稿版本）": pre-filled from the row; `propose_procedure` addresses no family,
   *  so the result is a *new* Procedure (new id, v1). */
  readonly copyOf?: ProcedureRow;
  /** Directories for the operation / worker step pickers (optional — ids typed otherwise). */
  readonly gatekeepers?: readonly GatekeeperListRow[];
  readonly workerDefinitions?: readonly WorkerDefinitionSummary[];
  readonly onProposed: (draft: ProposedDraft) => void;
  readonly onDone: () => void;
  /** After a publish from the success screen (`DraftProposed`'s `onPublished`). */
  readonly onPublished?: () => void;
}

type View = 'form' | 'json';

const STEP_KIND_LABEL: Readonly<
  Record<ProcedureStepKind, { readonly zh: string; readonly en: string }>
> = {
  operation: { zh: '门', en: 'Operation' },
  worker: { zh: 'Worker', en: 'Worker' },
  approval: { zh: '审批', en: 'Approval' },
  verify: { zh: '验证', en: 'Verify' },
};

/** The note beside an Operation in the picker: its declared blast radius. */
function operationSecondary(choice: OperationChoice, t: Translate): string | undefined {
  if (choice.blastRadius === null) return undefined;
  const label = BLAST_RADIUS_TONES[choice.blastRadius].label;
  return typeof label === 'string' ? label : t(label.zh, label.en);
}

/**
 * An `operation` step's gate + Operation (console-ux-2): the Operation is chosen from the picked
 * gate's published Operations (`lib/gate-operations.ts`) instead of typed, so a typo can no longer
 * save a step that fails at publish. "手动输入" stays as a fallback — and is what renders while the
 * gate directory is unavailable (typed gate id), the list fails to load or is empty, or a
 * prefilled name is not on the list (a copied step whose Operation has since changed).
 */
function OperationStepFields({
  http,
  prefix,
  step,
  gatekeepers,
  busy,
  gateError,
  operationError,
  onChange,
}: {
  readonly http: CapabilityCaller;
  readonly prefix: string;
  readonly step: ProcedureStepForm;
  readonly gatekeepers?: readonly GatekeeperListRow[];
  readonly busy: boolean;
  readonly gateError: string | null;
  readonly operationError: string | null;
  readonly onChange: (patch: Partial<ProcedureStepForm>) => void;
}) {
  const t = useT();
  const [manualChosen, setManualChosen] = useState(false);
  const hasDirectory = gatekeepers !== undefined && gatekeepers.length > 0;
  const gate = gatekeepers?.find((row) => row.id === step.gatekeeperId);
  // Only a gate from the directory is queried — a half-typed id would be a 400 per keystroke.
  const operations = useGateOperations(http, gate ? { gatekeeperId: gate.id } : null);
  const choices: readonly OperationChoice[] =
    operations.state.status === 'ready' ? operations.state.choices : [];
  const name = step.operationName.trim();
  const listUnavailable =
    operations.state.status === 'error' ||
    (operations.state.status === 'ready' && choices.length === 0);
  const notOnList =
    operations.state.status === 'ready' &&
    name !== '' &&
    !choices.some((choice) => choice.name === name);
  const manual = !hasDirectory || manualChosen || listUnavailable || notOnList;

  return (
    <div className="stack-s">
      <div className="row-wrap">
        <Field id={`${prefix}-gatekeeper`} label={t('门', 'Gate')} required error={gateError}>
          {hasDirectory ? (
            <Select
              id={`${prefix}-gatekeeper`}
              value={step.gatekeeperId}
              onChange={(event) =>
                // A name picked from the previous gate's list may not exist on the new one; a
                // typed name is the person's own and stays.
                onChange({
                  gatekeeperId: event.target.value,
                  ...(manual ? {} : { operationName: '' }),
                })
              }
              disabled={busy}
            >
              <option value="">{t('选择一个门…', 'Choose a gate…')}</option>
              {gatekeepers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · {row.kind}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id={`${prefix}-gatekeeper`}
              value={step.gatekeeperId}
              onChange={(event) => onChange({ gatekeeperId: event.target.value })}
              onBlur={() => onChange({ gatekeeperId: step.gatekeeperId.trim() })}
              disabled={busy}
              mono
            />
          )}
        </Field>
        <Field
          id={`${prefix}-operation`}
          label={t('Operation 名', 'Operation')}
          required
          error={operationError}
          hint={
            manual
              ? t(
                  '手动输入：与门发布的 Operation 名完全一致（区分大小写）。',
                  'Manual entry: the Operation name exactly as the gate publishes it (case-sensitive).',
                )
              : undefined
          }
        >
          {manual ? (
            <Input
              id={`${prefix}-operation`}
              value={step.operationName}
              onChange={(event) => onChange({ operationName: event.target.value })}
              onBlur={() => onChange({ operationName: step.operationName.trim() })}
              disabled={busy}
              invalid={!!operationError || notOnList}
              mono
              data-testid="procedure-step-operation-input"
            />
          ) : (
            // console-ux-3: a gate imported from OpenAPI can publish hundreds of Operations —
            // searchable instead of a native select.
            <Combobox
              id={`${prefix}-operation`}
              options={choices.map((choice) => ({
                value: choice.name,
                label: choice.name,
                secondary: operationSecondary(choice, t),
              }))}
              value={step.operationName}
              onChange={(operationName) => onChange({ operationName })}
              loading={operations.state.status === 'loading'}
              disabled={busy || operations.state.status === 'idle'}
              invalid={!!operationError}
              mono
              placeholder={
                operations.state.status === 'idle'
                  ? t('先选择门', 'Choose a gate first')
                  : operations.state.status === 'loading'
                    ? t('正在加载 Operation…', 'Loading Operations…')
                    : t('输入以搜索 Operation…', 'Type to search Operations…')
              }
              testId="procedure-step-operation"
            />
          )}
        </Field>
      </div>
      {operations.state.status === 'error' ? (
        <Notice tone="warn" testId="procedure-step-operations-error">
          {t(
            '无法加载这个门的 Operation 列表，已切换为手动输入。',
            'Could not load this gate’s Operations — switched to manual entry.',
          )}{' '}
          <Button variant="ghost" size="s" onClick={operations.reload}>
            {t('重试', 'Retry')}
          </Button>
        </Notice>
      ) : null}
      {gate && operations.state.status === 'ready' && choices.length === 0 ? (
        <span className="text-3 text-small" data-testid="procedure-step-operations-empty">
          {t(
            `门「${gate.name}」还没有已发布的 Operation，请手动输入名称。`,
            `Gate “${gate.name}” has no published Operation yet — type the name manually.`,
          )}
        </span>
      ) : null}
      {gate && notOnList && choices.length > 0 ? (
        <Notice tone="warn" testId="procedure-step-unknown-operation">
          {t(
            `门「${gate.name}」上没有已发布的「${name}」；发布这个 Procedure 时会失败。请从列表选择，或检查拼写。`,
            `Gate “${gate.name}” publishes no “${name}”; publishing this Procedure would fail. Choose from the list or check the spelling.`,
          )}
        </Notice>
      ) : null}
      {gate && choices.length > 0 ? (
        <div>
          <Button
            variant="ghost"
            size="s"
            disabled={busy}
            onClick={() => {
              if (manual) {
                setManualChosen(false);
                if (notOnList) onChange({ operationName: '' });
              } else {
                setManualChosen(true);
              }
            }}
            data-testid="procedure-step-operation-mode"
          >
            {manual ? t('从列表选择', 'Choose from the list') : t('手动输入', 'Type it manually')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * components/catalog/ProcedureEditor (S6-A A2 — docs/console-completion-plan.md §5.3): name,
 * description and the ordered steps (`operation` / `worker` / `approval` / `verify`,
 * packages/shared/src/procedure.ts) as a form plus a JSON view of the wire content. Submit
 * validates against `ProposeProcedureContentSchema` (the handler's own parse) and calls
 * `propose_procedure{procedure}`; the success state offers `publish_procedure`.
 */
export function ProcedureEditor({
  http,
  copyOf,
  gatekeepers,
  workerDefinitions,
  onProposed,
  onDone,
  onPublished,
}: ProcedureEditorProps) {
  const t = useT();
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const [form, setForm] = useState<ProcedureForm>(() =>
    copyOf
      ? {
          name: copyOf.name,
          description: copyOf.description,
          steps: (copyOf.steps ?? []).map(procedureStepFromWire),
        }
      : EMPTY_PROCEDURE_FORM,
  );
  const [view, setView] = useState<View>('form');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [proposed, setProposed] = useState<ProposedDraft | null>(null);
  const content = useMemo(() => procedureContentFromForm(form), [form]);

  function updateStep(index: number, patch: Partial<ProcedureStepForm>): void {
    setForm((prev) => ({
      ...prev,
      steps: prev.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
  }

  function moveStep(index: number, delta: -1 | 1): void {
    setForm((prev) => {
      const steps = [...prev.steps];
      const target = index + delta;
      const current = steps[index];
      const other = steps[target];
      if (current === undefined || other === undefined) return prev;
      steps[index] = other;
      steps[target] = current;
      return { ...prev, steps };
    });
  }

  function applyJson(value: Record<string, unknown>): void {
    setForm({
      name: typeof value.name === 'string' ? value.name : '',
      description: typeof value.description === 'string' ? value.description : '',
      steps: Array.isArray(value.steps) ? value.steps.map(procedureStepFromWire) : [],
    });
    setErrors({});
    setView('form');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const validated = validateProcedure(form, t);
    if (!validated.ok) {
      setErrors(validated.errors);
      setView('form');
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      const result = await http.call<ProposedDraft>('propose_procedure', {
        procedure: validated.value,
      });
      setProposed(result);
      onProposed(result);
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('propose_procedure');
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (proposed) {
    return (
      <DraftProposed
        kindLabel="Procedure"
        draft={proposed}
        detailHref={hrefs.catalog('procedures', proposed.id)}
        fieldNames={reviewFieldNames('procedure', t)}
        onPublish={
          can('publish_procedure') === false
            ? undefined
            : (review) =>
                http.call<{ status: string }>('publish_procedure', {
                  procedureId: proposed.id,
                  ...review,
                })
        }
        onDone={onDone}
        onPublished={onPublished}
        reviewersSeeDraft
      />
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="procedure-editor"
    >
      {copyOf ? (
        <Notice tone="warn" testId="procedure-copy-notice">
          {t(
            <>
              从 <strong>{copyOf.name}</strong> v{copyOf.version} 复制：提交会创建一个
              <strong>新的</strong> Procedure（新 ID、v1），不是同一 Procedure 的新版本。
            </>,
            <>
              Copied from <strong>{copyOf.name}</strong> v{copyOf.version}: submitting creates a{' '}
              <strong>new</strong> Procedure (new id, v1), not a new version of this one.
            </>,
          )}
        </Notice>
      ) : (
        <Notice testId="procedure-private-notice">
          {t(
            '草稿只有你（提议者）和工作区的 owner、builder 可见，发布后所有成员可见；发布时每个 Operation / Worker 步骤引用的对象必须已发布。',
            'Until published, the draft is visible only to you, the workspace owner and builders; publishing resolves every Operation / Worker step against published objects.',
          )}
        </Notice>
      )}

      <Tabs<View>
        ariaLabel={t('Procedure 视图', 'Procedure view')}
        value={view}
        onChange={setView}
        options={[
          { value: 'form', label: t('表单', 'Form'), testId: 'procedure-view-form' },
          { value: 'json', label: 'JSON', testId: 'procedure-view-json' },
        ]}
      />

      {view === 'json' ? (
        <JsonEditor
          label={t('流程定义（JSON）', 'Procedure definition (JSON)')}
          value={content}
          onApply={applyJson}
          disabled={busy}
          testId="procedure-json"
        />
      ) : (
        <>
          <Field id="procedure-name" label={t('名称', 'name')} required error={errors.name || null}>
            <Input
              id="procedure-name"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              disabled={busy}
              invalid={!!errors.name}
              aria-describedby={describedBy('procedure-name', false, !!errors.name)}
            />
          </Field>
          <Field
            id="procedure-description"
            label={t('描述', 'description')}
            required
            error={errors.description || null}
          >
            <Textarea
              id="procedure-description"
              value={form.description}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, description: event.target.value }))
              }
              rows={2}
              disabled={busy}
              invalid={!!errors.description}
              aria-describedby={describedBy('procedure-description', false, !!errors.description)}
            />
          </Field>

          <div className="stack-s">
            <div className="row">
              <span className="section-title grow">
                {t('步骤', 'Steps')} ({form.steps.length})
              </span>
              <Button
                variant="secondary"
                size="s"
                icon="plus"
                disabled={busy}
                onClick={() =>
                  setForm((prev) => ({ ...prev, steps: [...prev.steps, newProcedureStep()] }))
                }
                data-testid="procedure-add-step"
              >
                {t('添加步骤', 'Add step')}
              </Button>
            </div>
            {errors.steps ? (
              <p className="field-error" role="alert">
                {errors.steps}
              </p>
            ) : null}
            {form.steps.length === 0 ? (
              <span className="text-3 text-small">
                {t('还没有步骤；一个 Procedure 至少描述一个有序动作。', 'No steps yet.')}
              </span>
            ) : null}
            {form.steps.map((step, index) => {
              const prefix = `steps.${index}`;
              const fieldError = (name: string) => errors[`${prefix}.${name}`] || null;
              return (
                <div
                  className="card card-padded stack-s"
                  key={step.key}
                  data-testid="procedure-step"
                >
                  <div className="row-wrap">
                    <span className="tag">{index + 1}</span>
                    <Field id={`${prefix}-kind`} label={t('类型', 'kind')}>
                      <Select
                        id={`${prefix}-kind`}
                        value={step.kind}
                        onChange={(event) =>
                          updateStep(index, { kind: event.target.value as ProcedureStepKind })
                        }
                        disabled={busy}
                        data-testid="procedure-step-kind"
                      >
                        {PROCEDURE_STEP_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(STEP_KIND_LABEL[kind].zh, STEP_KIND_LABEL[kind].en)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <span className="grow" />
                    <Button
                      variant="ghost"
                      size="s"
                      disabled={busy || index === 0}
                      onClick={() => moveStep(index, -1)}
                      aria-label={t(`上移第 ${index + 1} 步`, `Move step ${index + 1} up`)}
                    >
                      {t('上移', 'Up')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="s"
                      disabled={busy || index === form.steps.length - 1}
                      onClick={() => moveStep(index, 1)}
                      aria-label={t(`下移第 ${index + 1} 步`, `Move step ${index + 1} down`)}
                    >
                      {t('下移', 'Down')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="s"
                      icon="close"
                      disabled={busy}
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          steps: prev.steps.filter((_, i) => i !== index),
                        }))
                      }
                      aria-label={t(`移除第 ${index + 1} 步`, `Remove step ${index + 1}`)}
                    >
                      {t('移除', 'Remove')}
                    </Button>
                  </div>
                  {step.kind === 'operation' ? (
                    <OperationStepFields
                      http={http}
                      prefix={prefix}
                      step={step}
                      gatekeepers={gatekeepers}
                      busy={busy}
                      gateError={fieldError('gatekeeperId')}
                      operationError={fieldError('operationName')}
                      onChange={(patch) => updateStep(index, patch)}
                    />
                  ) : step.kind === 'worker' ? (
                    <div className="row-wrap">
                      <Field
                        id={`${prefix}-definition`}
                        label={t('Worker 定义', 'definitionId')}
                        required
                        error={fieldError('definitionId')}
                      >
                        {workerDefinitions && workerDefinitions.length > 0 ? (
                          <Select
                            id={`${prefix}-definition`}
                            value={step.definitionId}
                            onChange={(event) => {
                              const picked = workerDefinitions.find(
                                (row) => row.id === event.target.value,
                              );
                              updateStep(index, {
                                definitionId: event.target.value,
                                ...(picked ? { version: String(picked.version) } : {}),
                              });
                            }}
                            disabled={busy}
                          >
                            <option value="">
                              {t('选择一个 Worker 定义…', 'Choose a Worker definition…')}
                            </option>
                            {workerDefinitions.map((row) => (
                              <option key={`${row.id}@${row.version}`} value={row.id}>
                                {definitionName([row], row.id, row.version) ?? row.id} v
                                {row.version}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            id={`${prefix}-definition`}
                            value={step.definitionId}
                            onChange={(event) =>
                              updateStep(index, { definitionId: event.target.value })
                            }
                            disabled={busy}
                            mono
                          />
                        )}
                      </Field>
                      <Field
                        id={`${prefix}-version`}
                        label={t('版本', 'version')}
                        required
                        error={fieldError('version')}
                      >
                        <Input
                          id={`${prefix}-version`}
                          type="number"
                          min={1}
                          value={step.version}
                          onChange={(event) => updateStep(index, { version: event.target.value })}
                          disabled={busy}
                        />
                      </Field>
                    </div>
                  ) : null}
                  <Field
                    id={`${prefix}-description`}
                    label={t('说明', 'description')}
                    required={step.kind === 'approval' || step.kind === 'verify'}
                    error={fieldError('description')}
                  >
                    <Input
                      id={`${prefix}-description`}
                      value={step.description}
                      onChange={(event) => updateStep(index, { description: event.target.value })}
                      disabled={busy}
                    />
                  </Field>
                </div>
              );
            })}
          </div>
        </>
      )}

      {error !== null ? (
        <ErrorBanner
          error={error}
          title={t('无法创建草稿', 'Could not propose the draft')}
          testId="procedure-editor-error"
        />
      ) : null}

      <div className="row">
        <Button type="submit" variant="primary" loading={busy} data-testid="procedure-submit">
          {t('保存草稿', 'Save draft')}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          {t('取消', 'Cancel')}
        </Button>
      </div>
    </form>
  );
}
