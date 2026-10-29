import { type FormEvent, useMemo, useRef, useState } from 'react';
import { byData, useFocusAfterRender } from '../../hooks/useFocusAfterRender.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import {
  EMPTY_PROCEDURE_FORM,
  type FieldErrors,
  PROCEDURE_STEP_KINDS,
  type ProcedureForm,
  type ProcedureStepForm,
  type ProcedureStepKind,
  errorsUnder,
  newProcedureStep,
  procedureContentFromForm,
  procedureFormFrom,
  procedureStepToWire,
  validateProcedure,
  withPlanKeyRenamed,
  withPlanKeysKept,
} from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { reviewFieldNames } from '../../lib/credential-review.js';
import { describeError, isForbiddenError } from '../../lib/errors.js';
import type { GatekeeperListRow, ProcedureRow } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import {
  parsedProcedureParameters,
  parsedProcedureSteps,
  procedurePlanPlaces,
} from '../../lib/procedure-template.js';
import { hrefs } from '../../lib/router.js';
import { emptySchemaDraft } from '../../lib/schema-fields.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import {
  definitionVersions,
  latestPerDefinition,
  unnamedDefinitionLabel,
  versionOptionText,
  workerDefinitionChoices,
} from '../../lib/tasks.js';
import { Button } from '../ui/Button.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select, Textarea, describedBy } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { Tabs } from '../ui/Tabs.js';
import { DraftProposed, type ProposedDraft } from './DraftProposed.js';
import { JsonEditor } from './JsonEditor.js';
import { OperationStepFields } from './OperationStepFields.js';
import {
  type ProcedurePlanContext,
  VerifyCheckFields,
  WorkerPlanFields,
} from './ProcedurePlanFields.js';
import { SchemaFieldsEditor } from './SchemaFieldsEditor.js';

export interface ProcedureEditorProps {
  readonly http: CapabilityCaller;
  /** 「另存为新的流程」: pre-filled from the row and proposed without `procedureId`, so the result is
   *  a *new* Procedure (new id, v1). */
  readonly copyOf?: ProcedureRow;
  /** 「编辑（新版本草稿）」 (S11 W1a E2-0, legacy 48 ②): the published row whose family gets the next
   *  version — `propose_procedure{procedure, procedureId}`, pre-filled the same way. A Procedure
   *  is addressed by id, so the name may change. Takes precedence over `copyOf`. */
  readonly nextVersionOf?: ProcedureRow;
  /** With `nextVersionOf`: when the kernel refuses because the family's latest version is still a
   *  draft (409 `draft_pending`), the error offers to show that draft. */
  readonly onShowPendingDraft?: () => void;
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
  nextVersionOf,
  onShowPendingDraft,
  gatekeepers,
  workerDefinitions,
  onProposed,
  onDone,
  onPublished,
}: ProcedureEditorProps) {
  const t = useT();
  const permissions = usePermissions();
  const can = useRoleCan(http);
  /** The row the form is prefilled from — the family's current version or the copied one. */
  const source = nextVersionOf ?? copyOf;
  // S11 GO5d-2: a copy keeps what its steps say of a goal's plan, and its parameters.
  const [form, setForm] = useState<ProcedureForm>(() =>
    source ? procedureFormFrom(source) : EMPTY_PROCEDURE_FORM,
  );
  const [view, setView] = useState<View>('form');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [proposed, setProposed] = useState<ProposedDraft | null>(null);
  const content = useMemo(() => procedureContentFromForm(form), [form]);
  // Legacy 485: a step can only run a `kind='worker'` definition (the kernel's `invoke.ts` and
  // `step-attempt.ts` refuse an entry one), so only Workers are offered; the entry definitions
  // stay in `workerDefinitions` so a step that already names one says what it is.
  const workerRows = useMemo(
    () => workerDefinitions?.filter((row) => row.kind === 'worker'),
    [workerDefinitions],
  );
  const kindOf = (definitionId: string) =>
    workerDefinitions?.find((row) => row.id === definitionId)?.kind;
  // Legacy 453: the Procedure as the plan it would make — what a binding can already be told.
  const context = useMemo<ProcedurePlanContext>(() => {
    const parsed = parsedProcedureSteps(content.steps as readonly unknown[]);
    return {
      parsed,
      places: procedurePlanPlaces(parsed),
      parameters: parsedProcedureParameters(content.parameters),
    };
  }, [content]);

  function updateStep(index: number, patch: Partial<ProcedureStepForm>): void {
    setForm((prev) => ({
      ...prev,
      steps: prev.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
  }

  // UX P3-5 on #738: a control its own change takes away (a removed step's 移除, 添加启动参数, an
  // 上移 now at the top) hands focus on, not to <body>.
  const formRef = useRef<HTMLFormElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const stepCard = (key: string | undefined) =>
    key === undefined ? undefined : byData(stepsRef.current, '[data-step-uid]', 'stepUid', key);

  function moveStep(index: number, delta: -1 | 1): void {
    const moved = form.steps[index]?.key;
    const at = index + delta;
    // The same button on the step moved, or the other one when it is now at that end.
    const atEnd = delta === -1 ? at === 0 : at === form.steps.length - 1;
    const want = delta === -1 ? (atEnd ? 'down' : 'up') : atEnd ? 'up' : 'down';
    focusAfterRender(() => stepCard(moved)?.querySelector<HTMLElement>(`[data-move="${want}"]`));
    setForm((prev) => {
      const steps = [...prev.steps];
      const target = index + delta;
      const current = steps[index];
      const other = steps[target];
      if (current === undefined || other === undefined) return prev;
      steps[index] = other;
      steps[target] = current;
      return { ...prev, steps: withPlanKeysKept(prev.steps, steps) };
    });
  }

  /** A step's errors no field of it shows (legacy 453) — listed on the step, so none is lost. */
  function leftover(index: number, kind: ProcedureStepKind) {
    const shown = [
      'kind',
      'gatekeeperId',
      'operationName',
      'definitionId',
      'version',
      'description',
      ...(kind === 'worker'
        ? ['key', 'dependsOn', 'maxAttempts', 'input', 'bindings', 'outputSchema']
        : kind === 'verify'
          ? ['check']
          : []),
    ];
    return errorsUnder(errors, `steps.${index}`).filter(
      (problem) =>
        problem.path !== '' &&
        !shown.some((field) => problem.path === field || problem.path.startsWith(`${field}.`)),
    );
  }

  function applyJson(value: Record<string, unknown>): void {
    setForm(procedureFormFrom(value));
    setErrors({});
    setView('form');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const validated = validateProcedure(form, t);
    // Legacy 485: a step naming an entry definition is refused here, not when it runs; its field
    // already says why (live, so it clears once another definition is picked).
    const entryStep = form.steps.findIndex(
      (step) => step.kind === 'worker' && kindOf(step.definitionId) === 'entry',
    );
    if (!validated.ok || entryStep !== -1) {
      setErrors(validated.ok ? {} : validated.errors);
      setView('form');
      if (entryStep !== -1) {
        focusAfterRender(() =>
          formRef.current?.querySelector<HTMLElement>(`[id="steps.${entryStep}-definition"]`),
        );
      }
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      const result = await http.call<ProposedDraft>('propose_procedure', {
        procedure: validated.value,
        ...(nextVersionOf ? { procedureId: nextVersionOf.id } : {}),
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
                // Legacy 300 and review #493 on #764 (F1): publishes exactly the version and
                // content this screen proposed.
                http.call<{ status: string }>('publish_procedure', {
                  procedureId: proposed.id,
                  version: proposed.version,
                  draftDigest: proposed.draftDigest,
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
      ref={formRef}
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="procedure-editor"
    >
      {nextVersionOf ? (
        <Notice testId="procedure-new-version-notice">
          {t(
            <>
              为 <strong>{nextVersionOf.name}</strong> 提议新版本（当前 v{nextVersionOf.version}
              ，已预填它的内容）：仍是同一个流程（同一个
              ID），名称可以改；发布后，从这个流程发起的目标默认用新版本。发布前草稿只有你、工作区所有者和构建者可见；发布时每个
              Operation / Worker 步骤引用的对象必须已发布。
            </>,
            <>
              Proposing a new version of <strong>{nextVersionOf.name}</strong> (current v
              {nextVersionOf.version}, its content pre-filled): the same Procedure (same id), the
              name may change; once published, goals started from it use the new version by default.
              Until then the draft is visible only to you, the workspace owner and builders;
              publishing resolves every Operation / Worker step against published objects.
            </>,
          )}
        </Notice>
      ) : copyOf ? (
        <Notice tone="warn" testId="procedure-copy-notice">
          {t(
            <>
              从 <strong>{copyOf.name}</strong> v{copyOf.version} 复制：保存后是一个
              <strong>新的</strong>流程（新 ID、v1），原来的流程不变。
            </>,
            <>
              Copied from <strong>{copyOf.name}</strong> v{copyOf.version}: saving creates a{' '}
              <strong>new</strong> Procedure (new id, v1); the original stays as it is.
            </>,
          )}
        </Notice>
      ) : (
        <Notice testId="procedure-private-notice">
          {t(
            '草稿只有你（提议者）、工作区所有者和构建者可见，发布后所有成员可见；发布时每个 Operation / Worker 步骤引用的对象必须已发布。',
            'Until published, the draft is visible only to you, the workspace owner and builders; publishing resolves every Operation / Worker step against published objects.',
          )}
        </Notice>
      )}

      <Tabs<View>
        ariaLabel={t('流程视图', 'Procedure view')}
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

          <div className="stack-s" ref={stepsRef}>
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
                {t('还没有步骤；一个流程至少描述一个有序动作。', 'No steps yet.')}
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
                  data-step-uid={step.key}
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
                    {/* ux-lint-allow-disabled: the first step cannot move up. */}
                    <Button
                      variant="ghost"
                      size="s"
                      disabled={busy || index === 0}
                      onClick={() => moveStep(index, -1)}
                      data-move="up"
                      aria-label={t(`上移第 ${index + 1} 步`, `Move step ${index + 1} up`)}
                    >
                      {t('上移', 'Up')}
                    </Button>
                    {/* ux-lint-allow-disabled: the last step cannot move down. */}
                    <Button
                      variant="ghost"
                      size="s"
                      disabled={busy || index === form.steps.length - 1}
                      onClick={() => moveStep(index, 1)}
                      data-move="down"
                      aria-label={t(`下移第 ${index + 1} 步`, `Move step ${index + 1} down`)}
                    >
                      {t('下移', 'Down')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="s"
                      icon="close"
                      disabled={busy}
                      onClick={() => {
                        // The next step's kind, or 添加步骤 when it was the last.
                        const next = form.steps[index + 1]?.key;
                        focusAfterRender(() =>
                          next !== undefined
                            ? stepCard(next)?.querySelector('select')
                            : stepsRef.current?.querySelector<HTMLElement>(
                                '[data-testid="procedure-add-step"]',
                              ),
                        );
                        setForm((prev) => ({
                          ...prev,
                          steps: withPlanKeysKept(
                            prev.steps,
                            prev.steps.filter((_, i) => i !== index),
                          ),
                        }));
                      }}
                      aria-label={t(`移除第 ${index + 1} 步`, `Remove step ${index + 1}`)}
                    >
                      {t('移除', 'Remove')}
                    </Button>
                  </div>
                  {step.kind === 'operation' ? (
                    <OperationStepFields
                      http={http}
                      prefix={prefix}
                      gatekeeperId={step.gatekeeperId}
                      operationName={step.operationName}
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
                        error={
                          fieldError('definitionId') ??
                          (kindOf(step.definitionId) === 'entry' ? entryStepText(t) : null)
                        }
                      >
                        {workerDefinitions && workerDefinitions.length > 0 ? (
                          <Select
                            id={`${prefix}-definition`}
                            value={step.definitionId}
                            onChange={(event) => {
                              const picked = definitionVersions(
                                workerDefinitions,
                                event.target.value,
                              )[0];
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
                            {step.definitionId !== '' &&
                            !workerRows?.some((row) => row.id === step.definitionId) ? (
                              <option value={step.definitionId}>
                                {kindOf(step.definitionId) === 'entry'
                                  ? t(
                                      `${unnamedDefinitionLabel('entry', t)}（不能作为流程步骤）`,
                                      `${unnamedDefinitionLabel('entry', t)} (cannot be a step)`,
                                    )
                                  : t(
                                      '当前的 Worker 定义（不在已发布列表里）',
                                      'The current Worker definition (not among the published)',
                                    )}
                              </option>
                            ) : null}
                            {workerDefinitionChoices(latestPerDefinition(workerRows ?? []), t).map(
                              (choice) => (
                                <option key={choice.id} value={choice.id}>
                                  {[choice.label, choice.distinguisher]
                                    .filter((part) => part !== undefined)
                                    .join(' · ')}
                                </option>
                              ),
                            )}
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
                        {/* field-inventory #26: the published versions of the picked definition
                         *  are already loaded, so the version is chosen, not typed. A typed
                         *  number remains only when the definition list could not be read. */}
                        {workerDefinitions && workerDefinitions.length > 0 ? (
                          <Select
                            id={`${prefix}-version`}
                            value={step.version}
                            onChange={(event) => updateStep(index, { version: event.target.value })}
                            disabled={busy}
                            data-testid={`${prefix}-version`}
                          >
                            {step.definitionId === '' ? (
                              <option value="">
                                {t('先选 Worker 定义', 'Pick a definition first')}
                              </option>
                            ) : null}
                            {step.definitionId !== '' &&
                            step.version !== '' &&
                            !definitionVersions(workerDefinitions, step.definitionId).some(
                              (row) => String(row.version) === step.version,
                            ) ? (
                              <option value={step.version}>
                                {t(
                                  `v${step.version}（不在列表里）`,
                                  `v${step.version} (not listed)`,
                                )}
                              </option>
                            ) : null}
                            {definitionVersions(workerDefinitions, step.definitionId).map(
                              (row, _index, versions) => (
                                <option key={row.version} value={String(row.version)}>
                                  {versionOptionText(row, versions, t)}
                                </option>
                              ),
                            )}
                          </Select>
                        ) : (
                          <Input
                            id={`${prefix}-version`}
                            type="number"
                            min={1}
                            value={step.version}
                            onChange={(event) => updateStep(index, { version: event.target.value })}
                            disabled={busy}
                          />
                        )}
                      </Field>
                    </div>
                  ) : null}
                  {step.kind === 'worker' ? (
                    <WorkerPlanFields
                      index={index}
                      step={step}
                      steps={form.steps}
                      parameters={form.parameters ?? null}
                      context={context}
                      errors={errors}
                      busy={busy}
                      onChange={(patch) => updateStep(index, patch)}
                      onKeyRenamed={(from, to) =>
                        setForm((prev) => ({
                          ...prev,
                          steps: withPlanKeyRenamed(prev.steps, from, to),
                        }))
                      }
                    />
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
                  {step.kind === 'verify' ? (
                    <VerifyCheckFields
                      http={http}
                      index={index}
                      step={step}
                      wire={procedureStepToWire(step)}
                      gatekeepers={gatekeepers}
                      errors={errors}
                      busy={busy}
                      onChange={(patch) => updateStep(index, patch)}
                    />
                  ) : null}
                  {leftover(index, step.kind).length > 0 ? (
                    <div
                      className="field-error stack-s"
                      role="alert"
                      data-testid="procedure-step-errors"
                    >
                      <ul className="stack-s">
                        {leftover(index, step.kind).map((problem) => (
                          <li key={problem.path}>
                            <span className="mono">{problem.path}</span>：{problem.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {form.parameters ? (
            <SchemaFieldsEditor
              id="procedure-parameters"
              legend={t('启动参数', 'Parameters')}
              explanation={t(
                '用这个流程生成目标时要填写这些参数；Worker 步骤的输入绑定可以从中取值。',
                'A goal made from this Procedure is proposed with these parameters; Worker steps’ input bindings can take values from them.',
              )}
              draft={form.parameters}
              errors={errorsUnder(errors, 'parameters')}
              busy={busy}
              descriptionPlaceholder={t(
                '填写的人看到的说明（可空）',
                'What the person filling it in sees (optional)',
              )}
              onChange={(parameters) => setForm((prev) => ({ ...prev, parameters }))}
              onRemove={() => {
                focusAfterRender(() =>
                  formRef.current?.querySelector<HTMLElement>(
                    '[data-testid="procedure-add-parameters"]',
                  ),
                );
                setForm((prev) => ({ ...prev, parameters: null }));
              }}
              removeLabel={t('去掉启动参数', 'Drop the parameters')}
              testId="procedure-parameters"
            />
          ) : (
            <div>
              <Button
                variant="secondary"
                size="s"
                icon="plus"
                disabled={busy}
                onClick={() => {
                  focusAfterRender(() =>
                    formRef.current?.querySelector<HTMLElement>(
                      '[data-testid="procedure-parameters-add-field"]',
                    ),
                  );
                  setForm((prev) => ({ ...prev, parameters: emptySchemaDraft() }));
                }}
                data-testid="procedure-add-parameters"
              >
                {t('添加启动参数', 'Add parameters')}
              </Button>
            </div>
          )}
        </>
      )}

      {error !== null ? (
        <ErrorBanner
          error={error}
          title={t('无法创建草稿', 'Could not propose the draft')}
          action={
            nextVersionOf && onShowPendingDraft && describeError(error).code === 'draft_pending' ? (
              <Button
                variant="secondary"
                size="s"
                onClick={onShowPendingDraft}
                data-testid="procedure-show-pending-draft"
              >
                {t('查看那份草稿', 'Show that draft')}
              </Button>
            ) : undefined
          }
          testId="procedure-editor-error"
        />
      ) : null}

      <div className="row overlay-actions">
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

/** Legacy 485: why a step cannot name an entry definition. */
function entryStepText(t: Translate): string {
  return t(
    '入口定义不能作为流程步骤：流程的步骤只能交给 Worker 执行，请换一个 Worker 定义。',
    'An entry definition cannot be a step: a Procedure step runs on a Worker. Choose a Worker definition.',
  );
}
