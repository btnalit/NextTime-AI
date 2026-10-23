import {
  MAX_STEP_ATTEMPTS,
  MAX_STEP_BINDINGS,
  type OutputSchema,
  PROCEDURE_PARAMS_SOURCE,
  type ProcedureStep,
  StepAcceptanceCheckSchema,
} from '@nexttime/shared';
import { useState } from 'react';
import {
  type FieldErrors,
  type ProcedureBindingForm,
  type ProcedureCheckKind,
  type ProcedureStepForm,
  errorsUnder,
  newProcedureBinding,
  procedurePlanKey,
  procedurePreviousWorkerKey,
  procedureWorkerKeys,
} from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { DEFAULT_ATTEMPTS } from '../../lib/goal-plan-draft.js';
import { planCheckSentence } from '../../lib/goals.js';
import type { GatekeeperListRow } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import {
  type ProcedurePlanPlace,
  procedureBindingIssue,
  procedureWorkersByKey,
} from '../../lib/procedure-template.js';
import { type SchemaDraft, emptySchemaDraft, schemaFieldNames } from '../../lib/schema-fields.js';
import { Button } from '../kit/button.js';
import { Combobox } from '../kit/combobox.js';
import { Field, describedBy } from '../kit/field.js';
import { Select } from '../kit/select.js';
import { Textarea } from '../kit/textarea.js';
import { OperationStepFields } from './OperationStepFields.js';
import { SchemaFieldsEditor } from './SchemaFieldsEditor.js';

/**
 * components/catalog/ProcedurePlanFields (legacy 453): what a Procedure step says of the goal plan
 * made from it (`@nexttime/shared` `procedure.ts`, S11 GO5d-2) as form fields, where the editor
 * used to keep them as they came and point to the JSON view. A `worker` step: its key in the plan,
 * the steps it waits for (chosen from the Procedure's own `worker` steps), its attempts, input,
 * input bindings (the source chosen from the parameters or the steps; the path offered from the
 * fields they declare) and output contract. A `verify` step: who checks it — the requester on its
 * description, or the platform (the gate and Operation it observes chosen, the expectation as JSON).
 *
 * What is wrong shows on the field it is about: the form's own checks, the schema's, and — for a
 * binding — what `lib/procedure-template` can already tell before publishing does.
 */

/** The steps parsed (`parsedProcedureSteps`), their places in the plan and the parameters — the
 *  Procedure as the plan it would make, for what a binding can already be told. */
export interface ProcedurePlanContext {
  readonly parsed: readonly (ProcedureStep | null)[];
  readonly places: ReadonlyMap<number, ProcedurePlanPlace>;
  readonly parameters: OutputSchema | null;
}

const WORKER_FIELDS = [
  'key',
  'dependsOn',
  'maxAttempts',
  'input',
  'bindings',
  'outputSchema',
] as const;

/** Whether the step says anything of the plan beyond its Worker — its section opens on it. */
function saysAnything(step: ProcedureStepForm): boolean {
  return (
    step.stepKey !== '' ||
    step.dependsOn !== null ||
    step.maxAttempts !== '' ||
    step.inputText !== '' ||
    step.bindings.length > 0 ||
    step.outputSchema !== null
  );
}

function messages(errors: FieldErrors, prefix: string, t: Translate): string | null {
  const list = errorsUnder(errors, prefix);
  return list.length === 0 ? null : list.map((error) => error.message).join(t('；', '; '));
}

export function WorkerPlanFields({
  index,
  step,
  steps,
  parameters,
  context,
  errors,
  busy,
  onChange,
  onKeyRenamed,
}: {
  readonly index: number;
  readonly step: ProcedureStepForm;
  readonly steps: readonly ProcedureStepForm[];
  readonly parameters: SchemaDraft | null;
  readonly context: ProcedurePlanContext;
  readonly errors: FieldErrors;
  readonly busy: boolean;
  readonly onChange: (patch: Partial<ProcedureStepForm>) => void;
  /** The step's key was changed (on leaving the field): what named it should name the new key. */
  readonly onKeyRenamed: (from: string, to: string) => void;
}) {
  const t = useT();
  const prefix = `steps.${index}`;
  const id = `procedure-step-${step.key}`;
  const hasErrors = WORKER_FIELDS.some((field) => errorsUnder(errors, `${prefix}.${field}`).length);
  const [open, setOpen] = useState(() => saysAnything(step));
  const [keyAtFocus, setKeyAtFocus] = useState<string | null>(null);
  const ownKey = procedurePlanKey(step, index);
  const previous = procedurePreviousWorkerKey(steps, index);
  const others = procedureWorkerKeys(steps).filter((worker) => worker.index !== index);
  const otherKeys = others.map((worker) => worker.key);
  // A dependency or a binding source no step has (any more) stays listed, so it can be taken out.
  const staleDeps = (step.dependsOn ?? []).filter((key) => !otherKeys.includes(key));
  const keyError = messages(errors, `${prefix}.key`, t);
  const depsError = messages(errors, `${prefix}.dependsOn`, t);
  const attemptsError = messages(errors, `${prefix}.maxAttempts`, t);
  const inputError = messages(errors, `${prefix}.input`, t);
  const bindingsError = errorsUnder(errors, `${prefix}.bindings`)
    .filter((error) => !/^\d+(\.|$)/.test(error.path))
    .map((error) => error.message)
    .join(t('；', '; '));
  const attemptOptions = Array.from({ length: MAX_STEP_ATTEMPTS }, (_, i) => String(i + 1));
  const place = context.places.get(index);
  const workers = procedureWorkersByKey(context.parsed, context.places);

  function updateBinding(at: number, patch: Partial<ProcedureBindingForm>): void {
    onChange({
      bindings: step.bindings.map((binding, i) => (i === at ? { ...binding, ...patch } : binding)),
    });
  }

  /** The field names `path` may start from: the parameters', or the source step's output's. */
  function pathChoices(from: string): readonly string[] {
    if (from === PROCEDURE_PARAMS_SOURCE) return schemaFieldNames(parameters);
    const source = others.find((worker) => worker.key === from);
    return source ? schemaFieldNames(steps[source.index]?.outputSchema ?? null) : [];
  }

  return (
    <details
      className="disclosure"
      open={open || hasErrors}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-testid="procedure-step-plan"
    >
      <summary>
        {t(
          `用流程生成目标时：这一步是计划里的 ${ownKey}`,
          `In a goal made from the Procedure: this step is ${ownKey} of the plan`,
        )}
      </summary>
      <div className="disclosure-body">
        <div className="row-wrap">
          <Field
            id={`${id}-plan-key`}
            label={t('步骤名', 'Step key')}
            hint={t(
              `留空就是 ${`step-${index + 1}`}（按它在流程里的位置）。别的步骤按这个名字等它、取它的输出，改名时它们跟着改。`,
              `Empty: ${`step-${index + 1}`} (its place in the Procedure). Other steps wait for it and take its output by this key, and follow a rename.`,
            )}
            error={keyError}
          >
            <input
              className="input input-mono"
              id={`${id}-plan-key`}
              value={step.stepKey}
              placeholder={`step-${index + 1}`}
              onFocus={() => setKeyAtFocus(ownKey)}
              onChange={(event) => onChange({ stepKey: event.target.value })}
              onBlur={() => {
                const trimmed = step.stepKey.trim();
                if (trimmed !== step.stepKey) onChange({ stepKey: trimmed });
                const now = trimmed || `step-${index + 1}`;
                // Only to a key no other step has: two steps never come to share what named one.
                if (keyAtFocus !== null && keyAtFocus !== now && !otherKeys.includes(now)) {
                  onKeyRenamed(keyAtFocus, now);
                }
                setKeyAtFocus(null);
              }}
              disabled={busy}
              aria-invalid={keyError !== null || undefined}
              aria-describedby={describedBy(`${id}-plan-key`, true, keyError !== null)}
              autoComplete="off"
              spellCheck={false}
              data-testid="procedure-step-plan-key"
            />
          </Field>
          <Field
            id={`${id}-attempts`}
            label={t('最多尝试次数', 'Attempts at most')}
            error={attemptsError}
          >
            <Select
              id={`${id}-attempts`}
              aria-label={t('最多尝试次数', 'Attempts at most')}
              className="select-fit"
              value={step.maxAttempts}
              onChange={(event) => onChange({ maxAttempts: event.target.value })}
              disabled={busy}
              invalid={attemptsError !== null}
              data-testid="procedure-step-attempts"
            >
              <option value="">
                {t(`默认（${DEFAULT_ATTEMPTS} 次）`, `Default (${DEFAULT_ATTEMPTS})`)}
              </option>
              {step.maxAttempts !== '' && !attemptOptions.includes(step.maxAttempts) ? (
                <option value={step.maxAttempts}>
                  {t(`${step.maxAttempts}（不允许）`, `${step.maxAttempts} (not allowed)`)}
                </option>
              ) : null}
              {attemptOptions.map((n) => (
                <option key={n} value={n}>
                  {t(`${n} 次`, n)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <fieldset className="stack-s" data-testid="procedure-step-depends">
          <legend className="text-small">{t('什么时候开始', 'When it starts')}</legend>
          <label className="row-wrap text-small">
            <input
              type="radio"
              name={`${id}-depends`}
              checked={step.dependsOn === null}
              onChange={() => onChange({ dependsOn: null })}
              disabled={busy}
              data-testid="procedure-step-depends-default"
            />
            {previous === null
              ? t(
                  '按顺序：它是第一个 Worker 步骤，最先开始',
                  'In order: the first Worker step, starting first',
                )
              : t(
                  `按顺序：等上一个 Worker 步骤 ${previous} 完成`,
                  `In order: once the Worker step before it, ${previous}, is done`,
                )}
          </label>
          <label className="row-wrap text-small">
            <input
              type="radio"
              name={`${id}-depends`}
              checked={step.dependsOn !== null}
              onChange={() => onChange({ dependsOn: previous === null ? [] : [previous] })}
              disabled={busy}
              data-testid="procedure-step-depends-own"
            />
            {t('自己选要等的步骤', 'Choose the steps it waits for')}
          </label>
          {step.dependsOn !== null ? (
            <div className="stack-s">
              {otherKeys.length === 0 && staleDeps.length === 0 ? (
                <span className="text-3 text-small">
                  {t(
                    '没有别的 Worker 步骤可等：它一开始就运行。',
                    'No other Worker step to wait for: it runs from the start.',
                  )}
                </span>
              ) : (
                <div className="row-wrap">
                  {[...otherKeys, ...staleDeps].map((key) => (
                    <label key={key} className="row-wrap text-small">
                      <input
                        type="checkbox"
                        checked={step.dependsOn?.includes(key) ?? false}
                        onChange={(event) => {
                          const current = step.dependsOn ?? [];
                          onChange({
                            dependsOn: event.target.checked
                              ? [...current, key]
                              : current.filter((dep) => dep !== key),
                          });
                        }}
                        disabled={busy}
                        data-testid="procedure-step-depends-on"
                      />
                      <span className="mono">{key}</span>
                      {staleDeps.includes(key) ? (
                        <span className="text-3">
                          {t('（这个流程里没有这一步）', ' (no such step in this Procedure)')}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              )}
              {step.dependsOn.length === 0 && otherKeys.length > 0 ? (
                <span className="text-3 text-small">
                  {t('一个都不选：它一开始就运行。', 'None chosen: it runs from the start.')}
                </span>
              ) : null}
            </div>
          ) : null}
          {depsError !== null ? (
            <p className="field-error" role="alert">
              {depsError}
            </p>
          ) : null}
        </fieldset>

        <Field
          id={`${id}-input`}
          label={t('输入（JSON，可空）', 'Input (JSON, optional)')}
          hint={t(
            '交给 Worker 的参数里写定的部分；有输入绑定时必须是对象，绑定往它的字段里填值。不要写凭据的值：Worker 用的凭据由平台配置。',
            'The fixed part of what the Worker is given; with bindings it must be an object, whose fields they fill. Never a credential’s value: the credentials Workers use are configured on the platform.',
          )}
          error={inputError}
        >
          <Textarea
            className="input-mono"
            id={`${id}-input`}
            aria-label={t('输入', 'Input')}
            value={step.inputText}
            onChange={(event) => onChange({ inputText: event.target.value })}
            minRows={3}
            spellCheck={false}
            disabled={busy}
            invalid={inputError !== null}
            aria-describedby={describedBy(`${id}-input`, true, inputError !== null)}
            data-testid="procedure-step-input"
          />
        </Field>

        <fieldset className="stack-s" data-testid="procedure-step-bindings">
          <legend className="text-small">{t('输入绑定', 'Input bindings')}</legend>
          <span className="text-small text-3">
            {t(
              '运行时往输入的某个字段填值：取自启动参数，或取自一个要等的步骤交回的输出。',
              'Fill a field of the input when it runs: from the parameters, or from the output of a step it waits for.',
            )}
          </span>
          {step.bindings.map((binding, at) => {
            const n = at + 1;
            const rowError = messages(errors, `${prefix}.bindings.${at}`, t);
            const issue =
              place !== undefined && binding.from !== '' && binding.path.trim() !== ''
                ? procedureBindingIssue(
                    { to: binding.to.trim(), from: binding.from, path: binding.path.trim() },
                    place,
                    workers,
                    context.parameters,
                    t,
                  )
                : null;
            const staleSource =
              binding.from !== '' &&
              binding.from !== PROCEDURE_PARAMS_SOURCE &&
              !otherKeys.includes(binding.from);
            return (
              <div className="stack-s" key={binding.uid} data-testid="procedure-step-binding">
                <div className="row-wrap">
                  <input
                    className="input input-mono"
                    aria-label={t(`第 ${n} 个绑定放到输入的哪个字段`, `Binding ${n}: input field`)}
                    placeholder={t('target.host 这样的输入字段', 'Input field, e.g. target.host')}
                    value={binding.to}
                    onChange={(event) => updateBinding(at, { to: event.target.value })}
                    disabled={busy}
                    aria-invalid={rowError !== null || undefined}
                    data-testid="procedure-step-binding-to"
                  />
                  <Select
                    aria-label={t(`第 ${n} 个绑定的来源`, `Binding ${n}: source`)}
                    className="select-fit"
                    value={binding.from}
                    onChange={(event) => updateBinding(at, { from: event.target.value })}
                    disabled={busy}
                    data-testid="procedure-step-binding-from"
                  >
                    <option value="">{t('选来源…', 'Choose a source…')}</option>
                    <option value={PROCEDURE_PARAMS_SOURCE}>
                      {t('启动参数', 'The parameters')}
                    </option>
                    {otherKeys.map((key) => (
                      <option key={key} value={key}>
                        {t(`步骤 ${key} 的输出`, `Output of ${key}`)}
                      </option>
                    ))}
                    {staleSource ? (
                      <option value={binding.from}>
                        {t(
                          `步骤 ${binding.from}（这个流程里没有）`,
                          `${binding.from} (not in this Procedure)`,
                        )}
                      </option>
                    ) : null}
                  </Select>
                  <Combobox
                    id={`${id}-binding-${binding.uid}-path`}
                    aria-label={t(`第 ${n} 个绑定取哪个值`, `Binding ${n}: path`)}
                    options={pathChoices(binding.from).map((name) => ({
                      value: name,
                      label: name,
                    }))}
                    value={binding.path}
                    onChange={(path) => updateBinding(at, { path })}
                    allowFreeEntry
                    mono
                    disabled={busy}
                    placeholder={t('取值路径，如 site', 'Path, e.g. site')}
                    emptyText={t(
                      '来源没有声明字段：直接写路径。',
                      'The source declares no fields: type the path.',
                    )}
                    testId="procedure-step-binding-path"
                  />
                  <Button
                    variant="ghost"
                    size="s"
                    disabled={busy}
                    onClick={() => onChange({ bindings: step.bindings.filter((_, i) => i !== at) })}
                    aria-label={t(`移除第 ${n} 个绑定`, `Remove binding ${n}`)}
                  >
                    {t('移除', 'Remove')}
                  </Button>
                </div>
                {rowError !== null ? (
                  <p className="field-error" role="alert">
                    {rowError}
                  </p>
                ) : issue !== null ? (
                  <span className="text-small text-warn" data-testid="procedure-step-binding-issue">
                    {issue}
                  </span>
                ) : null}
              </div>
            );
          })}
          {bindingsError !== '' ? (
            <p className="field-error" role="alert">
              {bindingsError}
            </p>
          ) : null}
          <div>
            {/* ux-lint-allow-disabled: the hint beside it says the step has the most bindings. */}
            <Button
              variant="secondary"
              size="s"
              disabled={busy || step.bindings.length >= MAX_STEP_BINDINGS}
              onClick={() => onChange({ bindings: [...step.bindings, newProcedureBinding()] })}
              data-testid="procedure-step-add-binding"
            >
              {t('添加绑定', 'Add binding')}
            </Button>
            {step.bindings.length >= MAX_STEP_BINDINGS ? (
              <span className="text-small text-3">
                {t(
                  `一步最多 ${MAX_STEP_BINDINGS} 个绑定。`,
                  `A step has at most ${MAX_STEP_BINDINGS} bindings.`,
                )}
              </span>
            ) : null}
          </div>
        </fieldset>

        {step.outputSchema !== null ? (
          <SchemaFieldsEditor
            id={`${id}-output`}
            legend={t('输出约定', 'Output contract')}
            explanation={t(
              'Worker 交回结果时要带上符合这份约定的 output；后面的步骤只能绑定声明过的输出。',
              'The Worker’s result carries an output that meets this contract; later steps bind only a declared output.',
            )}
            draft={step.outputSchema}
            errors={errorsUnder(errors, `${prefix}.outputSchema`)}
            busy={busy}
            descriptionPlaceholder={t('这个字段是什么（可空）', 'What this field is (optional)')}
            onChange={(outputSchema) => onChange({ outputSchema })}
            onRemove={() => onChange({ outputSchema: null })}
            removeLabel={t('去掉输出约定', 'Drop the output contract')}
            testId="procedure-step-output"
          />
        ) : (
          <div>
            <Button
              variant="secondary"
              size="s"
              disabled={busy}
              onClick={() => onChange({ outputSchema: emptySchemaDraft() })}
              data-testid="procedure-step-add-output"
            >
              {t('添加输出约定', 'Add an output contract')}
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

const CHECK_KIND_LABEL: Readonly<Record<ProcedureCheckKind, readonly [string, string]>> = {
  none: ['请求人看着上面的说明确认', 'The requester confirms the description above'],
  observe_predicate: [
    '平台观察一个门 Operation 的结果',
    'The platform observes a gate’s Operation',
  ],
  fact_predicate: ['平台判定图里的一条事实', 'The platform judges a Fact of the graph'],
  json: ['表单认不出的检查（JSON）', 'A check the form cannot read (JSON)'],
};

export function VerifyCheckFields({
  http,
  index,
  step,
  wire,
  gatekeepers,
  errors,
  busy,
  onChange,
}: {
  readonly http: CapabilityCaller;
  readonly index: number;
  readonly step: ProcedureStepForm;
  /** The step as it is sent — its `check`, when it parses, is said as a sentence. */
  readonly wire: Record<string, unknown>;
  readonly gatekeepers?: readonly GatekeeperListRow[];
  readonly errors: FieldErrors;
  readonly busy: boolean;
  readonly onChange: (patch: Partial<ProcedureStepForm>) => void;
}) {
  const t = useT();
  const prefix = `steps.${index}.check`;
  const id = `procedure-step-${step.key}-check`;
  const kinds: readonly ProcedureCheckKind[] =
    step.checkKind === 'json'
      ? ['none', 'observe_predicate', 'fact_predicate', 'json']
      : ['none', 'observe_predicate', 'fact_predicate'];
  const parsed = StepAcceptanceCheckSchema.safeParse(wire.check);
  const gateNames = new Map((gatekeepers ?? []).map((row) => [row.id, row.name]));
  const keyError = messages(errors, `${prefix}.key`, t);
  const paramsError = messages(errors, `${prefix}.check.params`, t);
  const expectError = messages(errors, `${prefix}.check.expect`, t);
  const factError = messages(errors, `${prefix}.fact`, t);
  // What no field below shows: the check's own (its JSON, or a whole-check problem).
  const shown = [
    'key',
    'check.gatekeeperId',
    'check.operation',
    'check.params',
    'check.expect',
    'fact',
  ];
  const rest = errorsUnder(errors, prefix).filter(
    (error) =>
      step.checkKind === 'json' ||
      !shown.some((path) => error.path === path || error.path.startsWith(`${path}.`)),
  );
  return (
    <div className="stack-s" data-testid="procedure-step-check">
      <Field
        id={`${id}-kind`}
        label={t('用流程生成目标时，谁来检查这一步', 'In a goal made from it, who checks this')}
      >
        <Select
          id={`${id}-kind`}
          aria-label={t('谁来检查这一步', 'Who checks this step')}
          value={step.checkKind}
          onChange={(event) => {
            const checkKind = event.target.value as ProcedureCheckKind;
            onChange({
              checkKind,
              // A platform check is listed among the goal's checks by its key; start from one.
              ...(checkKind !== 'none' && step.checkKey === ''
                ? { checkKey: `check-${index + 1}` }
                : {}),
            });
          }}
          disabled={busy}
          data-testid="procedure-step-check-kind"
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {t(CHECK_KIND_LABEL[kind][0], CHECK_KIND_LABEL[kind][1])}
            </option>
          ))}
        </Select>
      </Field>
      {step.checkKind === 'observe_predicate' || step.checkKind === 'fact_predicate' ? (
        <Field
          id={`${id}-key`}
          label={t('检查名', 'Check key')}
          required
          hint={t('目标的验收检查里按这个名字列出。', 'The goal lists the check by this key.')}
          error={keyError}
        >
          <input
            className="input input-mono"
            id={`${id}-key`}
            value={step.checkKey}
            onChange={(event) => onChange({ checkKey: event.target.value })}
            disabled={busy}
            aria-invalid={keyError !== null || undefined}
            data-testid="procedure-step-check-key"
          />
        </Field>
      ) : null}
      {step.checkKind === 'observe_predicate' ? (
        <>
          <OperationStepFields
            http={http}
            prefix={id}
            gatekeeperId={step.checkGatekeeperId}
            operationName={step.checkOperation}
            testPrefix="procedure-step-check"
            gateLabel={t('观察哪个门', 'The gate observed')}
            gatekeepers={gatekeepers}
            busy={busy}
            gateError={messages(errors, `${prefix}.check.gatekeeperId`, t)}
            operationError={messages(errors, `${prefix}.check.operation`, t)}
            onChange={(patch) =>
              onChange({
                ...(patch.gatekeeperId !== undefined
                  ? { checkGatekeeperId: patch.gatekeeperId }
                  : {}),
                ...(patch.operationName !== undefined
                  ? { checkOperation: patch.operationName }
                  : {}),
              })
            }
          />
          <Field
            id={`${id}-params`}
            label={t('Operation 参数（JSON，可空）', 'Operation params (JSON, optional)')}
            error={paramsError}
          >
            <Textarea
              className="input-mono"
              id={`${id}-params`}
              aria-label={t('Operation 参数', 'Operation params')}
              value={step.checkParamsText}
              onChange={(event) => onChange({ checkParamsText: event.target.value })}
              minRows={2}
              spellCheck={false}
              disabled={busy}
              invalid={paramsError !== null}
              data-testid="procedure-step-check-params"
            />
          </Field>
          <Field
            id={`${id}-expect`}
            label={t('结果要满足（JSON）', 'The result must satisfy (JSON)')}
            required
            hint={t(
              '例如 {"path": "state", "op": "eq", "value": "valid"}；多个条件用 all / any / not 组合。',
              'E.g. {"path": "state", "op": "eq", "value": "valid"}; combine several with all / any / not.',
            )}
            error={expectError}
          >
            <Textarea
              className="input-mono"
              id={`${id}-expect`}
              aria-label={t('结果要满足', 'The result must satisfy')}
              value={step.checkExpectText}
              onChange={(event) => onChange({ checkExpectText: event.target.value })}
              minRows={3}
              spellCheck={false}
              disabled={busy}
              invalid={expectError !== null}
              aria-describedby={describedBy(`${id}-expect`, true, expectError !== null)}
              data-testid="procedure-step-check-expect"
            />
          </Field>
        </>
      ) : null}
      {step.checkKind === 'fact_predicate' ? (
        <Field
          id={`${id}-fact`}
          label={t('要判定的事实（JSON）', 'The Fact judged (JSON)')}
          required
          hint={t(
            '例如 {"linkType": "runs_on", "source": {"objectType": "Service", "identity": {"name": "web"}}, "target": {"objectType": "Host", "identity": {"name": "h1"}}}；可再加 expect 判定它的属性。',
            'E.g. {"linkType": "runs_on", "source": {"objectType": "Service", "identity": {"name": "web"}}, "target": {"objectType": "Host", "identity": {"name": "h1"}}}; an expect judges its properties.',
          )}
          error={factError}
        >
          <Textarea
            className="input-mono"
            id={`${id}-fact`}
            aria-label={t('要判定的事实', 'The Fact judged')}
            value={step.checkFactText}
            onChange={(event) => onChange({ checkFactText: event.target.value })}
            minRows={4}
            spellCheck={false}
            disabled={busy}
            invalid={factError !== null}
            aria-describedby={describedBy(`${id}-fact`, true, factError !== null)}
            data-testid="procedure-step-check-fact"
          />
        </Field>
      ) : null}
      {step.checkKind === 'json' ? (
        <Textarea
          className="input-mono"
          aria-label={t('检查（JSON）', 'The check (JSON)')}
          value={step.checkJsonText}
          onChange={(event) => onChange({ checkJsonText: event.target.value })}
          minRows={4}
          spellCheck={false}
          disabled={busy}
          invalid={rest.length > 0}
          data-testid="procedure-step-check-json"
        />
      ) : null}
      {parsed.success ? (
        <span className="text-small" data-testid="procedure-step-check-sentence">
          {t('平台会检查：', 'The platform checks: ')}
          {planCheckSentence(parsed.data, gateNames, t)}
        </span>
      ) : null}
      {rest.length > 0 ? (
        <div className="field-error stack-s" role="alert" data-testid="procedure-step-check-errors">
          <ul className="stack-s">
            {rest.map((error) => (
              <li key={error.path}>
                {error.path === '' ? null : <span className="mono">{error.path}：</span>}
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
