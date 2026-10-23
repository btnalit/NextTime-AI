import { type ReactNode, useRef } from 'react';
import { byData, useFocusAfterRender } from '../../hooks/useFocusAfterRender.js';
import { predicateOpLabel } from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import {
  PREDICATE_OPS,
  type PredicateConditionDraft,
  type PredicateDraft,
  type PredicateGroupDraft,
  type PredicateNodeDraft,
  type PredicateOp,
  type PredicatePaths,
  type PredicateValueKind,
  newPredicateCondition,
  newPredicateGroup,
  predicateAddLimit,
  predicateDraftAsForm,
  predicateDraftAsJson,
  predicateFormBlocker,
  predicateFormBlockerText,
  predicateValueKindLabel,
  predicateValueKinds,
  predicateWithPaths,
  withChildAdded,
  withConditionChanged,
  withGroupChanged,
  withNodeRemoved,
} from '../../lib/predicate-draft.js';
import { Button } from '../kit/button.js';
import { Field } from '../kit/field.js';
import { Select } from '../kit/select.js';
import { Textarea } from '../kit/textarea.js';

type FormDraft = Extract<PredicateDraft, { mode: 'form' }>;
type ErrorList = readonly { readonly path: string; readonly message: string }[];

const MODE_LABEL: Readonly<Record<'all' | 'any', readonly [string, string]>> = {
  all: ['全部满足', 'All hold'],
  any: ['任一满足', 'Any holds'],
};

/**
 * components/catalog/PredicateEditor (legacy 464): what an observed result must satisfy
 * (`lib/predicate-draft`) — conditions one per row (where in the result, how it compares, a value
 * of a chosen kind), in groups of which all or any must hold, each negatable; or the predicate as
 * JSON when the form cannot say it. A comparison offers only the value kinds it takes, so the form
 * cannot write one the schema refuses for that.
 *
 * `errors` are the form's and the schema's at the predicate and under it, by its own paths
 * (`all.1.value`): a condition's show on its row, a group's on the group, the rest under it all.
 */
export function PredicateEditor({
  id,
  legend,
  draft,
  errors,
  busy,
  onChange,
  testId,
}: {
  readonly id: string;
  readonly legend: ReactNode;
  readonly draft: PredicateDraft;
  readonly errors: ErrorList;
  readonly busy: boolean;
  readonly onChange: (draft: PredicateDraft) => void;
  readonly testId: string;
}) {
  const t = useT();
  const root = useRef<HTMLFieldSetElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const written = draft.mode === 'form' ? predicateWithPaths(draft) : undefined;
  const paths: PredicatePaths = written?.paths ?? new Map();
  const blocker = predicateFormBlocker(draft);
  const asForm = draft.mode === 'json' ? predicateDraftAsForm(draft) : null;

  // Which errors a node shows: a condition everything at or under its place, a group what is at
  // its place or at its list (an empty or overlong `any`).
  const nodeErrors = (node: PredicateNodeDraft): ErrorList => {
    const at = paths.get(node.uid);
    if (at === undefined) return [];
    return errors.filter((error) =>
      node.kind === 'condition'
        ? error.path === at || error.path.startsWith(at === '' ? '' : `${at}.`)
        : error.path === at || error.path === (at === '' ? node.mode : `${at}.${node.mode}`),
    );
  };
  const claimed = (error: { path: string }) => {
    if (draft.mode !== 'form') return false;
    let found = false;
    const visit = (node: PredicateNodeDraft) => {
      if (nodeErrors(node).some((own) => own.path === error.path)) found = true;
      if (node.kind === 'group') node.children.forEach(visit);
    };
    draft.root.children.forEach(visit);
    return found;
  };
  const rest = errors.filter((error) => !claimed(error));

  function edit(next: FormDraft, focus?: () => HTMLElement | null | undefined): void {
    if (focus) focusAfterRender(focus);
    onChange(next);
  }
  const nodeElement = (uid: string) => byData(root.current, '[data-node]', 'node', uid);

  /** Removing a node hands focus to the next one in its group, or the group's 加条件. */
  function remove(form: FormDraft, group: PredicateGroupDraft, at: number): void {
    const next = group.children[at + 1]?.uid;
    edit(withNodeRemoved(form, group.children[at]?.uid ?? ''), () =>
      next !== undefined
        ? nodeElement(next)?.querySelector<HTMLElement>('input, select, button')
        : (nodeElement(group.uid) ?? root.current)?.querySelector<HTMLElement>(
            `[data-add-condition="${group.uid}"]`,
          ),
    );
  }

  function adds(form: FormDraft, group: PredicateGroupDraft) {
    const conditionLimit = predicateAddLimit(form, group.uid, 'condition', t);
    const groupLimit = predicateAddLimit(form, group.uid, 'group', t);
    return (
      <div className="row-wrap">
        {/* ux-lint-allow-disabled: the hint beside it says which limit it reached. */}
        <Button
          variant="secondary"
          size="s"
          disabled={busy || conditionLimit !== null}
          onClick={() => {
            const child = newPredicateCondition();
            edit(withChildAdded(form, group.uid, child), () =>
              nodeElement(child.uid)?.querySelector('input'),
            );
          }}
          data-add-condition={group.uid}
          data-testid={`${testId}-add-condition`}
        >
          {t('加条件', 'Add a condition')}
        </Button>
        {/* ux-lint-allow-disabled: the hint beside it says which limit it reached. */}
        <Button
          variant="ghost"
          size="s"
          disabled={busy || groupLimit !== null}
          onClick={() => {
            const child = newPredicateGroup();
            edit(withChildAdded(form, group.uid, child), () =>
              nodeElement(child.uid)?.querySelector('select'),
            );
          }}
          data-testid={`${testId}-add-group`}
        >
          {t('加一组', 'Add a group')}
        </Button>
        {(conditionLimit ?? groupLimit) ? (
          <span className="text-small text-3">{conditionLimit ?? groupLimit}</span>
        ) : null}
      </div>
    );
  }

  function children(form: FormDraft, group: PredicateGroupDraft): ReactNode {
    return group.children.map((node, at) =>
      node.kind === 'condition' ? (
        <ConditionRow
          key={node.uid}
          id={`${id}-${node.uid}`}
          node={node}
          n={at + 1}
          errors={nodeErrors(node)}
          busy={busy}
          onChange={(patch) => edit(withConditionChanged(form, node.uid, patch))}
          onRemove={() => remove(form, group, at)}
          testId={testId}
        />
      ) : (
        <div
          key={node.uid}
          className="predicate-group stack-s"
          data-node={node.uid}
          data-testid={`${testId}-group`}
        >
          <div className="row-wrap predicate-group-head">
            <Field id={`${id}-${node.uid}-mode`} label={t('这一组', 'This group')}>
              <Select
                id={`${id}-${node.uid}-mode`}
                aria-label={t(`第 ${at + 1} 项（一组）怎么算成立`, `Group ${at + 1}: how it holds`)}
                className="select-fit"
                value={node.mode}
                onChange={(event) =>
                  edit(withGroupChanged(form, node.uid, { mode: event.target.value as 'all' }))
                }
                disabled={busy}
                data-testid={`${testId}-group-mode`}
              >
                {(['all', 'any'] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {t(MODE_LABEL[mode][0], MODE_LABEL[mode][1])}
                  </option>
                ))}
              </Select>
            </Field>
            <NegateBox
              checked={node.negated}
              busy={busy}
              label={t(`第 ${at + 1} 项（一组）取反`, `Group ${at + 1}: negated`)}
              onChange={(negated) => edit(withGroupChanged(form, node.uid, { negated }))}
              testId={`${testId}-group-negate`}
            />
            <Button
              variant="ghost"
              size="s"
              disabled={busy}
              onClick={() => remove(form, group, at)}
              aria-label={t(`移除第 ${at + 1} 项（一组）`, `Remove group ${at + 1}`)}
            >
              {t('移除这一组', 'Remove the group')}
            </Button>
          </div>
          <Problems errors={nodeErrors(node)} t={t} />
          {children(form, node)}
          {adds(form, node)}
        </div>
      ),
    );
  }

  return (
    <fieldset ref={root} className="stack-s predicate-editor" data-testid={testId}>
      <legend className="text-small">{legend}</legend>
      {draft.mode === 'form' ? (
        <>
          {draft.root.children.length > 1 || !draft.bare ? (
            <Field id={`${id}-mode`} label={t('以下条件', 'The conditions below')}>
              <Select
                id={`${id}-mode`}
                aria-label={t('以下条件怎么算成立', 'How the conditions hold')}
                className="select-fit"
                value={draft.root.mode}
                onChange={(event) =>
                  edit(
                    withGroupChanged(draft, draft.root.uid, { mode: event.target.value as 'all' }),
                  )
                }
                disabled={busy}
                data-testid={`${testId}-mode`}
              >
                {(['all', 'any'] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {t(MODE_LABEL[mode][0], MODE_LABEL[mode][1])}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {draft.root.children.length === 0 ? (
            <span className="text-small text-3" data-testid={`${testId}-empty`}>
              {t('还没有条件：至少加一个。', 'No condition yet: add at least one.')}
            </span>
          ) : null}
          {children(draft, draft.root)}
          {adds(draft, draft.root)}
        </>
      ) : (
        <>
          <Textarea
            className="input-mono"
            id={`${id}-json`}
            aria-label={t('条件（JSON）', 'The conditions (JSON)')}
            value={draft.text}
            onChange={(event) => onChange({ mode: 'json', text: event.target.value })}
            minRows={3}
            spellCheck={false}
            disabled={busy}
            invalid={errors.length > 0}
            data-testid={`${testId}-json`}
          />
          {blocker !== null ? (
            <span className="text-small text-3" data-testid={`${testId}-json-only`}>
              {t('只能用 JSON 编辑：', 'Edited as JSON only: ')}
              {predicateFormBlockerText(blocker, t)}
            </span>
          ) : null}
        </>
      )}
      <Problems errors={rest} t={t} testId={`${testId}-errors`} />
      <div className="row-wrap">
        {draft.mode === 'form' ? (
          <Button
            variant="ghost"
            size="s"
            disabled={busy}
            onClick={() => onChange(predicateDraftAsJson(draft))}
            data-testid={`${testId}-as-json`}
          >
            {t('用 JSON 编辑', 'Edit as JSON')}
          </Button>
        ) : asForm !== null ? (
          <Button
            variant="ghost"
            size="s"
            disabled={busy}
            onClick={() => onChange(asForm)}
            data-testid={`${testId}-as-form`}
          >
            {t('用表单编辑', 'Edit in the form')}
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

function Problems({
  errors,
  t,
  testId,
}: {
  readonly errors: ErrorList;
  readonly t: Translate;
  readonly testId?: string;
}) {
  if (errors.length === 0) return null;
  return (
    <p className="field-error" role="alert" data-testid={testId}>
      {errors.map((error) => error.message).join(t('；', '; '))}
    </p>
  );
}

function NegateBox({
  checked,
  busy,
  label,
  onChange,
  testId,
}: {
  readonly checked: boolean;
  readonly busy: boolean;
  readonly label: string;
  readonly onChange: (negated: boolean) => void;
  readonly testId: string;
}) {
  const t = useT();
  return (
    <label className="choice-line text-small predicate-negate">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={busy}
        data-testid={testId}
      />
      <span>{t('取反（不成立才算满足）', 'Negate (holds when it does not)')}</span>
    </label>
  );
}

function ConditionRow({
  id,
  node,
  n,
  errors,
  busy,
  onChange,
  onRemove,
  testId,
}: {
  readonly id: string;
  readonly node: PredicateConditionDraft;
  readonly n: number;
  readonly errors: ErrorList;
  readonly busy: boolean;
  readonly onChange: (patch: Partial<Omit<PredicateConditionDraft, 'kind' | 'uid'>>) => void;
  readonly onRemove: () => void;
  readonly testId: string;
}) {
  const t = useT();
  const kinds = predicateValueKinds(node.op);
  const invalid = errors.length > 0 || undefined;
  return (
    <div
      className="stack-s predicate-condition"
      data-node={node.uid}
      data-testid={`${testId}-condition`}
    >
      <div className="row-wrap predicate-condition-row">
        <Field id={`${id}-path`} label={t('结果里的', 'In the result')}>
          <input
            id={`${id}-path`}
            className="input input-mono"
            aria-label={t(`第 ${n} 个条件：结果里的哪个值`, `Condition ${n}: which value`)}
            placeholder={t(
              '路径，如 status、items[0].count',
              'A path, e.g. status, items[0].count',
            )}
            value={node.path}
            onChange={(event) => onChange({ path: event.target.value })}
            disabled={busy}
            aria-invalid={invalid}
            data-testid={`${testId}-path`}
          />
        </Field>
        <Field id={`${id}-op`} label={t('比较', 'Compares')}>
          <Select
            id={`${id}-op`}
            aria-label={t(`第 ${n} 个条件：怎么比较`, `Condition ${n}: comparison`)}
            className="select-fit"
            value={node.op}
            onChange={(event) => onChange({ op: event.target.value as PredicateOp })}
            disabled={busy}
            data-testid={`${testId}-op`}
          >
            {PREDICATE_OPS.map((op) => (
              <option key={op} value={op}>
                {predicateOpLabel(op, t)}
              </option>
            ))}
          </Select>
        </Field>
        {kinds.length > 0 ? (
          <Field id={`${id}-kind`} label={t('值是', 'The value is')}>
            <Select
              id={`${id}-kind`}
              aria-label={t(`第 ${n} 个条件：值的类型`, `Condition ${n}: value kind`)}
              className="select-fit"
              value={node.valueKind}
              onChange={(event) => {
                const valueKind = event.target.value as PredicateValueKind;
                onChange({
                  valueKind,
                  ...(valueKind === 'boolean' && node.valueText !== 'false'
                    ? { valueText: 'true' }
                    : {}),
                });
              }}
              disabled={busy}
              data-testid={`${testId}-value-kind`}
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {predicateValueKindLabel(kind, t)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {kinds.length > 0 && node.valueKind !== 'null' ? (
          <Field id={`${id}-value`} label={t('值', 'Value')}>
            {node.valueKind === 'boolean' ? (
              <Select
                id={`${id}-value`}
                aria-label={t(`第 ${n} 个条件：值`, `Condition ${n}: value`)}
                className="select-fit"
                value={node.valueText === 'false' ? 'false' : 'true'}
                onChange={(event) => onChange({ valueText: event.target.value })}
                disabled={busy}
                data-testid={`${testId}-value`}
              >
                <option value="true">{t('是', 'Yes')}</option>
                <option value="false">{t('否', 'No')}</option>
              </Select>
            ) : node.valueKind === 'json' ? (
              <Textarea
                id={`${id}-value`}
                className="input-mono"
                aria-label={t(`第 ${n} 个条件：值（JSON）`, `Condition ${n}: value (JSON)`)}
                value={node.valueText}
                onChange={(event) => onChange({ valueText: event.target.value })}
                minRows={1}
                spellCheck={false}
                disabled={busy}
                invalid={invalid}
                data-testid={`${testId}-value`}
              />
            ) : (
              <input
                id={`${id}-value`}
                className={node.valueKind === 'number' ? 'input input-mono' : 'input'}
                aria-label={t(`第 ${n} 个条件：值`, `Condition ${n}: value`)}
                inputMode={node.valueKind === 'number' ? 'decimal' : undefined}
                value={node.valueText}
                onChange={(event) => onChange({ valueText: event.target.value })}
                disabled={busy}
                aria-invalid={invalid}
                data-testid={`${testId}-value`}
              />
            )}
          </Field>
        ) : null}
        <NegateBox
          checked={node.negated}
          busy={busy}
          label={t(`第 ${n} 个条件取反`, `Condition ${n}: negated`)}
          onChange={(negated) => onChange({ negated })}
          testId={`${testId}-negate`}
        />
        <Button
          variant="ghost"
          size="s"
          disabled={busy}
          onClick={onRemove}
          aria-label={t(`移除第 ${n} 个条件`, `Remove condition ${n}`)}
        >
          {t('移除', 'Remove')}
        </Button>
      </div>
      <Problems errors={errors} t={t} />
    </div>
  );
}
