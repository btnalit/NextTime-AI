import { WORKER_DEFINITION_KIND_VALUES, type WorkerDefinitionKind } from '@nexttime/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
import {
  EMPTY_WORKER_DEFINITION_FORM,
  type FieldErrors,
  type WorkerDefinitionForm,
  validateWorkerDefinition,
  workerDefinitionContentFromForm,
  workerDefinitionFormFromWire,
} from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import type { ModelRow } from '../../lib/governance.js';
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

export interface WorkerDefinitionEditorProps {
  readonly http: CapabilityCaller;
  /** "编辑（生成新草稿版本）": `propose_worker_definition{definitionId}` proposes the next version
   *  under this family — `kind` is immutable per family and locked here. */
  readonly newVersionOf?: WorkerDefinitionSummary;
  /** `list_models` rows for the model suggestions (optional). */
  readonly models?: readonly ModelRow[];
  readonly onProposed: (draft: ProposedDraft) => void;
  readonly onDone: () => void;
}

type View = 'form' | 'json';

/**
 * components/catalog/WorkerDefinitionEditor (S6-A A2 — docs/console-completion-plan.md §5.3):
 * `kind` (entry / worker) plus the kind-specific `definition` record
 * (packages/shared/src/worker-definition.ts — systemPrompt, model, name, description,
 * capabilities, gates / skills for a worker, egressDeny) as a form with a JSON view. Submit
 * validates with `workerDefinitionContentSchemaFor(kind)` and calls
 * `propose_worker_definition{definitionId?, kind, definition}`; the success state offers
 * `publish_worker_definition{definitionId, version}` — needed here because
 * `list_worker_definitions` returns published rows only, so a fresh draft never shows in the tab.
 */
export function WorkerDefinitionEditor({
  http,
  newVersionOf,
  models,
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
      : EMPTY_WORKER_DEFINITION_FORM,
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
        note={t(
          'Worker 列表只显示已发布版本，草稿不会出现在列表里。',
          'The Workers tab lists published versions only — a draft does not appear there.',
        )}
      />
    );
  }

  const isWorker = form.kind === 'worker';
  const fieldError = (name: string) => errors[name] || null;

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
              不可更改；发布前只有你可见（I16）。
            </>,
            <>
              Proposing the next version of this family (current v{newVersionOf.version}): same
              definitionId, kind is immutable; private to you until published (I16).
            </>,
          )}
        </Notice>
      ) : (
        <Notice testId="worker-private-notice">
          {t(
            '新建一个 WorkerDefinition 族（v1）。草稿只有你（提议者）可见，发布后所有成员可见（I16）。',
            'Starts a new WorkerDefinition family (v1). The draft is private to you until published (I16).',
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
                'entry = 用户入口智能体（能力有上限）；worker = 被委派的 Worker。',
                "entry = the user's entry agent (capability ceiling); worker = a delegated Worker.",
              )}
            >
              <Select
                id="wd-kind"
                value={form.kind}
                onChange={(event) => update('kind', event.target.value as WorkerDefinitionKind)}
                disabled={busy || newVersionOf !== undefined}
                data-testid="wd-kind"
              >
                {WORKER_DEFINITION_KIND_VALUES.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
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
                '<provider>/<model>；留空则由工作区策略决定。 Blank =',
                "the workspace policy's default.",
              )}
              error={fieldError('model')}
            >
              <Input
                id="wd-model"
                value={form.model}
                onChange={(event) => update('model', event.target.value)}
                disabled={busy}
                mono
                list="wd-model-options"
                invalid={!!errors.model}
              />
              <datalist id="wd-model-options">
                {(models ?? []).map((model) => (
                  <option key={model.id} value={model.id} />
                ))}
              </datalist>
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
            <Field
              id="wd-capabilities"
              label={t('能力', 'capabilities')}
              required={!isWorker}
              hint={
                isWorker
                  ? t(
                      '每行一个；留空 = 平台 Worker 上限去掉执行类能力。',
                      'One per line; blank = the worker ceiling minus execute-class capabilities.',
                    )
                  : t(
                      '每行一个；必须在 entry 上限之内（内核校验）。',
                      'One per line; must fit the entry ceiling (kernel-checked).',
                    )
              }
              error={fieldError('capabilities')}
            >
              <Textarea
                id="wd-capabilities"
                value={form.capabilities}
                onChange={(event) => update('capabilities', event.target.value)}
                rows={4}
                mono
                disabled={busy}
                invalid={!!errors.capabilities}
              />
            </Field>
            <Field
              id="wd-egress-deny"
              label={t('出网拒绝', 'egressDeny')}
              hint={t(
                '每行一个主机名或 .后缀；可空。',
                'One hostname or .suffix per line; optional.',
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
              <Field
                id="wd-gates"
                label={t('可作用的门', 'gates')}
                hint={t('每行一个 Gatekeeper id；可空。', 'One Gatekeeper id per line; optional.')}
                error={fieldError('gates')}
              >
                <Textarea
                  id="wd-gates"
                  value={form.gates}
                  onChange={(event) => update('gates', event.target.value)}
                  rows={3}
                  mono
                  disabled={busy}
                  invalid={!!errors.gates}
                />
              </Field>
              <Field
                id="wd-skills"
                label={t('使用的 Skill', 'skills')}
                hint={t(
                  '每行一个已发布 Skill 的名称；可空。',
                  'One published Skill name per line; optional.',
                )}
                error={fieldError('skills')}
              >
                <Textarea
                  id="wd-skills"
                  value={form.skills}
                  onChange={(event) => update('skills', event.target.value)}
                  rows={3}
                  mono
                  disabled={busy}
                  invalid={!!errors.skills}
                />
              </Field>
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
