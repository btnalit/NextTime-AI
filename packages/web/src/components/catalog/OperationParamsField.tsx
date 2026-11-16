import type { OperationParamSummaryWire } from '@nexttime/shared';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type Translate, useT } from '../../lib/i18n.js';
import {
  type ParamProblem,
  type ParamTexts,
  fillableParams,
  paramProblemText,
  paramTextsOf,
  paramsTextFrom,
} from '../../lib/operation-params.js';
import { Button } from '../kit/button.js';
import { Field, describedBy } from '../kit/field.js';
import { Select } from '../kit/select.js';
import { Textarea } from '../kit/textarea.js';

/** Where the gate puts a param in its call (`x-in`, lower-cased; absent = the request body). */
function inLabel(where: string | undefined, t: Translate): string {
  switch (where) {
    case undefined:
      return t('放在请求体里', 'in the request body');
    case 'query':
      return t('放在查询参数里', 'in the query string');
    case 'path':
      return t('放在路径里', 'in the path');
    case 'header':
      return t('放在请求头里', 'in a header');
    case 'cookie':
      return t('放在 Cookie 里', 'in a cookie');
    default:
      return t(`放在 ${where} 里`, `in ${where}`);
  }
}

function typeLabel(type: OperationParamSummaryWire['type'], t: Translate): string {
  switch (type) {
    case 'string':
      return t('文字', 'Text');
    case 'number':
      return t('数字', 'Number');
    case 'integer':
      return t('整数', 'Whole number');
    case 'boolean':
      return t('是或否', 'Yes or no');
    case 'object':
      return t('JSON 对象', 'JSON object');
    case 'array':
      return t('JSON 数组', 'JSON array');
    default:
      return t('JSON 值，文字可以不加引号', 'JSON value; text needs no quotes');
  }
}

/**
 * The params a check's Operation call sends (legacy 775): one field per param the Operation
 * declares (`list_operations`' param summary, legacy 465), typed by the param's type, with the
 * params only the gate sets named and not offered. The JSON object stays what the form keeps:
 * "用 JSON 编辑" shows it as it is, and it is the only way when the Operation's params are not known
 * (an Operation typed by hand, an older kernel) or the JSON holds what no field can (a key the
 * Operation does not declare, a value of another type).
 *
 * Mount it again (a `key`) when the gate, the Operation or whether its params are known changes:
 * the fields start from the JSON once and own their text after.
 *
 * #1296 UX P2-1: what the fields cannot send as they are (a required param left empty, a value
 * not of its type) goes to `onProblems` — the form refuses to submit while there is any — and is
 * said on the field once it is left, or once the form says so (`errors`, under the params' path).
 */
export function OperationParamsField({
  id,
  testPrefix,
  params,
  text,
  hint,
  errors,
  busy,
  onChange,
  onProblems,
}: {
  readonly id: string;
  /** Where the test ids start (`procedure-step-check-params`, …). */
  readonly testPrefix: string;
  /** The chosen Operation's params; `undefined` when not known. */
  readonly params: readonly OperationParamSummaryWire[] | undefined;
  /** The params as JSON (`''`: none). */
  readonly text: string;
  readonly hint?: ReactNode;
  /** The form's errors under the params' path: `''` the params as a whole, a param's name that
   *  param. */
  readonly errors: readonly { readonly path: string; readonly message: string }[];
  readonly busy: boolean;
  readonly onChange: (text: string) => void;
  /** The fields that cannot be sent as they are, by param name; `{}` in JSON and once unmounted. */
  readonly onProblems: (problems: Readonly<Record<string, ParamProblem>>) => void;
}) {
  const t = useT();
  const fillable = useMemo(() => (params ? fillableParams(params) : []), [params]);
  const gateOwned = (params ?? []).filter((param) => param.gateOwned === true);
  const gateOwnedNames = gateOwned.map((param) => param.name).join(t('、', ', '));
  const start = params ? paramTextsOf(text, fillable) : null;
  const [mode, setMode] = useState<'fields' | 'json'>(start !== null ? 'fields' : 'json');
  const [texts, setTexts] = useState<ParamTexts>(start ?? {});
  // A field's problem is said once the person leaves it — not on every keystroke of "-1".
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const problems = paramsTextFrom(texts, fillable).problems;
  const fieldsShown = mode === 'fields' && params !== undefined;
  const error =
    errors
      .filter((problem) => problem.path === '')
      .map((problem) => problem.message)
      .join(t('；', '; ')) || null;
  const formSaid = new Set(errors.map((problem) => problem.path.split('.')[0]));

  // Said to the form whenever they change; none while editing the JSON, nor once gone.
  const reported = fieldsShown ? JSON.stringify(problems) : '{}';
  const report = useRef(onProblems);
  report.current = onProblems;
  useEffect(() => {
    report.current(JSON.parse(reported) as Record<string, ParamProblem>);
  }, [reported]);
  useEffect(() => () => report.current({}), []);

  // #1296 UX P2-2: switching between the fields and the JSON leaves focus on what replaced the
  // button — the JSON, or the first field (the switch back, when there is none).
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    const first = fillable[0];
    const target =
      mode === 'json'
        ? document.getElementById(id)
        : (document.getElementById(first !== undefined ? `${id}-param-${first.name}` : '') ??
          document.querySelector<HTMLElement>(`[data-testid="${testPrefix}-to-json"]`));
    target?.focus();
  }, [mode, fillable, id, testPrefix]);

  const setText = (name: string, value: string) => {
    const next = { ...texts, [name]: value };
    setTexts(next);
    onChange(paramsTextFrom(next, fillable).text);
  };
  const gateOwnedNote =
    gateOwned.length > 0 ? (
      <p className="text-3 text-small" data-testid={`${testPrefix}-gate-owned`}>
        {t(
          `门自己设置的参数不用填：${gateOwnedNames}。`,
          `The gate sets these params itself, so they are not filled in here: ${gateOwnedNames}.`,
        )}
      </p>
    ) : null;

  if (mode === 'json' || params === undefined) {
    const backToFields = params !== undefined ? paramTextsOf(text, fillable) : null;
    return (
      <div className="stack-s">
        <Field
          id={id}
          label={t('Operation 参数（JSON，可空）', 'Operation params (JSON, optional)')}
          hint={hint}
          error={error}
        >
          <Textarea
            className="input-mono"
            id={id}
            aria-label={t('Operation 参数', 'Operation params')}
            value={text}
            onChange={(event) => onChange(event.target.value)}
            minRows={2}
            spellCheck={false}
            disabled={busy}
            invalid={error !== null}
            data-testid={testPrefix}
          />
        </Field>
        {params !== undefined ? (
          backToFields !== null ? (
            <div>
              <Button
                variant="ghost"
                size="s"
                disabled={busy}
                onClick={() => {
                  setTexts(backToFields);
                  setLeft(new Set());
                  switched.current = true;
                  setMode('fields');
                }}
                data-testid={`${testPrefix}-to-fields`}
              >
                {t('逐项填写', 'Fill in one by one')}
              </Button>
            </div>
          ) : (
            <p className="text-3 text-small" data-testid={`${testPrefix}-json-only`}>
              {t(
                '这段 JSON 里有这个 Operation 没有声明的参数、门自己设置的参数，或者类型对不上的值，只能用 JSON 编辑。',
                'This JSON has a param the Operation does not declare, one only the gate sets, or a value of another type, so it can only be edited as JSON.',
              )}
            </p>
          )
        ) : null}
        {gateOwnedNote}
      </div>
    );
  }

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <fieldset
      className="stack-s"
      data-testid={`${testPrefix}-fields`}
      aria-describedby={
        [hint !== undefined ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') ||
        undefined
      }
    >
      <legend className="text-small">{t('Operation 参数', 'Operation params')}</legend>
      {hint !== undefined ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {fillable.length === 0 ? (
        <p className="text-3 text-small" data-testid={`${testPrefix}-none`}>
          {t('这个 Operation 没有要填的参数。', 'This Operation has no params to fill in.')}
        </p>
      ) : (
        fillable.map((param) => {
          const fieldId = `${id}-param-${param.name}`;
          // Said once left or once the form said so — and only while it still holds.
          const problem =
            left.has(param.name) || formSaid.has(param.name) ? problems[param.name] : undefined;
          const fieldError = problem !== undefined ? paramProblemText(problem, t) : null;
          const value = texts[param.name] ?? '';
          const onBlur = () => setLeft(new Set(left).add(param.name));
          return (
            <Field
              key={param.name}
              id={fieldId}
              label={<span className="mono">{param.name}</span>}
              required={param.required}
              hint={`${typeLabel(param.type, t)} · ${inLabel(param.in, t)}`}
              error={fieldError}
            >
              {param.type === 'boolean' ? (
                <Select
                  id={fieldId}
                  aria-label={param.name}
                  value={value}
                  onChange={(event) => setText(param.name, event.target.value)}
                  onBlur={onBlur}
                  disabled={busy}
                  invalid={fieldError !== null}
                  aria-describedby={describedBy(fieldId, true, fieldError !== null)}
                  data-testid={`${testPrefix}-param-${param.name}`}
                >
                  <option value="">
                    {param.required ? t('选择…', 'Choose…') : t('不填', 'Leave out')}
                  </option>
                  <option value="true">{t('是（true）', 'Yes (true)')}</option>
                  <option value="false">{t('否（false）', 'No (false)')}</option>
                </Select>
              ) : (
                <input
                  className={param.type === 'string' ? 'input' : 'input input-mono'}
                  id={fieldId}
                  value={value}
                  onChange={(event) => setText(param.name, event.target.value)}
                  onBlur={onBlur}
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={fieldError !== null || undefined}
                  aria-describedby={describedBy(fieldId, true, fieldError !== null)}
                  data-testid={`${testPrefix}-param-${param.name}`}
                />
              )}
            </Field>
          );
        })
      )}
      {gateOwnedNote}
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          variant="ghost"
          size="s"
          disabled={busy}
          onClick={() => {
            switched.current = true;
            setMode('json');
          }}
          data-testid={`${testPrefix}-to-json`}
        >
          {t('用 JSON 编辑', 'Edit as JSON')}
        </Button>
      </div>
    </fieldset>
  );
}
