import { type FormEvent, useMemo, useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
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
import { isForbiddenError } from '../../lib/errors.js';
import type { GatekeeperListRow, ProcedureRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { definitionName } from '../../lib/tasks.js';
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
  gatekeepers,
  workerDefinitions,
  onProposed,
  onDone,
}: ProcedureEditorProps) {
  const t = useT();
  const permissions = usePermissions();
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
    const validated = validateProcedure(form);
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
        onPublish={
          permissions.isDenied('publish_procedure')
            ? undefined
            : () => http.call<{ status: string }>('publish_procedure', { procedureId: proposed.id })
        }
        onDone={onDone}
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
          从 <strong>{copyOf.name}</strong> v{copyOf.version} 复制：内核的 propose_procedure 不接受
          procedureId，提交会创建一个<strong>新的</strong>{' '}
          {t('Procedure（新 id、v1）。', 'Copied from')} {copyOf.name} v{copyOf.version}:
          propose_procedure takes no procedureId, so submitting creates a <strong>new</strong>{' '}
          Procedure (new id, v1).
        </Notice>
      ) : (
        <Notice testId="procedure-private-notice">
          {t(
            '草稿只有你（提议者）可见，发布后所有成员可见（I16）；发布时每个 operation / worker 步骤引用的对象必须已发布。',
            'The draft is private to you until published (I16); publishing resolves every operation / worker step against published objects.',
          )}
        </Notice>
      )}

      <Tabs<View>
        ariaLabel="Procedure view"
        value={view}
        onChange={setView}
        options={[
          { value: 'form', label: t('表单', 'Form'), testId: 'procedure-view-form' },
          { value: 'json', label: 'JSON', testId: 'procedure-view-json' },
        ]}
      />

      {view === 'json' ? (
        <JsonEditor
          label={t(
            'procedure（propose_procedure 的 procedure 字段）',
            'The propose_procedure payload',
          )}
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
                      aria-label={`Move step ${index + 1} up`}
                    >
                      {t('上移', 'Up')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="s"
                      disabled={busy || index === form.steps.length - 1}
                      onClick={() => moveStep(index, 1)}
                      aria-label={`Move step ${index + 1} down`}
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
                      aria-label={`Remove step ${index + 1}`}
                    >
                      {t('移除', 'Remove')}
                    </Button>
                  </div>
                  {step.kind === 'operation' ? (
                    <div className="row-wrap">
                      <Field
                        id={`${prefix}-gatekeeper`}
                        label={t('门', 'gatekeeperId')}
                        required
                        error={fieldError('gatekeeperId')}
                      >
                        {gatekeepers && gatekeepers.length > 0 ? (
                          <Select
                            id={`${prefix}-gatekeeper`}
                            value={step.gatekeeperId}
                            onChange={(event) =>
                              updateStep(index, { gatekeeperId: event.target.value })
                            }
                            disabled={busy}
                          >
                            <option value="">选择 select…</option>
                            {gatekeepers.map((gate) => (
                              <option key={gate.id} value={gate.id}>
                                {gate.name} · {gate.kind}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            id={`${prefix}-gatekeeper`}
                            value={step.gatekeeperId}
                            onChange={(event) =>
                              updateStep(index, { gatekeeperId: event.target.value })
                            }
                            disabled={busy}
                            mono
                          />
                        )}
                      </Field>
                      <Field
                        id={`${prefix}-operation`}
                        label={t('Operation 名', 'operationName')}
                        required
                        error={fieldError('operationName')}
                      >
                        <Input
                          id={`${prefix}-operation`}
                          value={step.operationName}
                          onChange={(event) =>
                            updateStep(index, { operationName: event.target.value })
                          }
                          disabled={busy}
                          mono
                        />
                      </Field>
                    </div>
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
                            <option value="">选择 select…</option>
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
