import { type ReactNode, useRef } from 'react';
import { byData, useFocusAfterRender } from '../../hooks/useFocusAfterRender.js';
import { useT } from '../../lib/i18n.js';
import {
  SCHEMA_FIELD_KINDS,
  type SchemaDraft,
  type SchemaFieldKind,
  type SchemaFieldRow,
  newSchemaRow,
  schemaDraftAsFields,
  schemaDraftAsJson,
  schemaFieldKindLabel,
  schemaListBlocker,
  schemaListBlockerText,
} from '../../lib/schema-fields.js';
import { Button } from '../kit/button.js';
import { Select } from '../kit/select.js';
import { Textarea } from '../kit/textarea.js';

/**
 * components/catalog/SchemaFieldsEditor (legacy 453): a step's output contract or a Procedure's
 * parameters (`lib/schema-fields`) — the fields one by one (name, kind, 必填, description), or the
 * schema as JSON when it says more than the list can. The two views are the same schema; the list
 * can be left for JSON at any time, and JSON can come back to the list when the list can say it.
 *
 * `errors` are the form's and the schema's at this schema and under it (`catalog.errorsUnder`):
 * a row's own (`fields.<row>`, or `properties.<name>…`) shows on the row, the rest under the list.
 */
export function SchemaFieldsEditor({
  id,
  legend,
  explanation,
  draft,
  errors,
  busy,
  descriptionPlaceholder,
  onChange,
  onRemove,
  removeLabel,
  testId,
}: {
  readonly id: string;
  readonly legend: ReactNode;
  readonly explanation?: ReactNode;
  readonly draft: SchemaDraft;
  readonly errors: readonly { readonly path: string; readonly message: string }[];
  readonly busy: boolean;
  /** What a field's description is for, as the input's placeholder. */
  readonly descriptionPlaceholder: string;
  readonly onChange: (draft: SchemaDraft) => void;
  readonly onRemove: () => void;
  readonly removeLabel: string;
  readonly testId: string;
}) {
  const t = useT();
  // UX P3-5 on #738: removing a field hands focus to the next one's name, or 添加字段.
  const root = useRef<HTMLFieldSetElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const asFields = draft.mode === 'json' ? schemaDraftAsFields(draft) : draft;
  const blocker = schemaListBlocker(draft);
  const at = (row: SchemaFieldRow, index: number) => (path: string) => {
    const name = row.name.trim();
    return (
      path === `fields.${index}` ||
      (name !== '' && (path === `properties.${name}` || path.startsWith(`properties.${name}.`)))
    );
  };
  // A row shows its own problems; the rest (the root's, or any in JSON) show under the list.
  const rowError = (row: SchemaFieldRow, index: number): string | null => {
    const own = errors.filter((error) => at(row, index)(error.path));
    return own.length === 0 ? null : own.map((error) => error.message).join(t('；', '; '));
  };
  const rest =
    draft.mode === 'fields'
      ? errors.filter((error) => !draft.rows.some((row, index) => at(row, index)(error.path)))
      : errors;

  function updateRow(index: number, patch: Partial<SchemaFieldRow>): void {
    if (draft.mode !== 'fields') return;
    onChange({
      ...draft,
      rows: draft.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }

  return (
    <fieldset ref={root} className="stack-s schema-fields" data-testid={testId}>
      <legend className="text-small">{legend}</legend>
      {explanation ? <span className="text-small text-3">{explanation}</span> : null}
      {draft.mode === 'fields' ? (
        <>
          {draft.rows.length === 0 ? (
            <span className="text-small text-3" data-testid={`${testId}-empty`}>
              {t('还没有字段：任何对象都符合。', 'No fields yet: any object meets it.')}
            </span>
          ) : null}
          {draft.rows.length > 0 ? (
            // UX P3-1 / P3-3 on #738: a grid with a header row, so a filled row still says which
            // value is which; below 640 px the description takes a line of its own.
            <div className="schema-fields-grid">
              <span className="schema-fields-head" aria-hidden>
                {t('字段名', 'Name')}
              </span>
              <span className="schema-fields-head" aria-hidden>
                {t('类型', 'Kind')}
              </span>
              <span className="schema-fields-head" aria-hidden>
                {t('必填', 'Required')}
              </span>
              <span className="schema-fields-head schema-fields-head-description" aria-hidden>
                {t('说明', 'Description')}
              </span>
              <span aria-hidden />
              {draft.rows.map((row, index) => {
                const problem = rowError(row, index);
                const n = index + 1;
                return (
                  <div
                    className="schema-field-row"
                    key={row.uid}
                    data-testid={`${testId}-field`}
                    data-field={row.uid}
                  >
                    <input
                      className="input input-mono"
                      id={`${id}-field-${row.uid}-name`}
                      aria-label={t(`第 ${n} 个字段的名字`, `Field ${n} name`)}
                      placeholder={t('字段名', 'Field name')}
                      value={row.name}
                      onChange={(event) => updateRow(index, { name: event.target.value })}
                      disabled={busy}
                      aria-invalid={problem !== null || undefined}
                      data-testid={`${testId}-field-name`}
                    />
                    <Select
                      aria-label={t(`第 ${n} 个字段的类型`, `Field ${n} kind`)}
                      className="select-fit"
                      value={row.kind}
                      onChange={(event) =>
                        updateRow(index, { kind: event.target.value as SchemaFieldKind })
                      }
                      disabled={busy}
                      data-testid={`${testId}-field-kind`}
                    >
                      {SCHEMA_FIELD_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {schemaFieldKindLabel(kind, t)}
                        </option>
                      ))}
                    </Select>
                    <input
                      type="checkbox"
                      aria-label={t(`第 ${n} 个字段必填`, `Field ${n} required`)}
                      checked={row.required}
                      onChange={(event) => updateRow(index, { required: event.target.checked })}
                      disabled={busy}
                      data-testid={`${testId}-field-required`}
                    />
                    {/* UX P3-7 on #738: below 640 px the description has a line of its own and
                     *  no column head above it, so it carries its own label there. */}
                    <label className="schema-field-description">
                      <span className="schema-field-description-label" aria-hidden>
                        {t('说明', 'Description')}
                      </span>
                      <input
                        aria-label={t(`第 ${n} 个字段的说明`, `Field ${n} description`)}
                        className="input"
                        placeholder={descriptionPlaceholder}
                        value={row.description}
                        onChange={(event) => updateRow(index, { description: event.target.value })}
                        disabled={busy}
                        data-testid={`${testId}-field-description`}
                      />
                    </label>
                    <Button
                      variant="ghost"
                      size="s"
                      disabled={busy}
                      onClick={() => {
                        const next = draft.rows[index + 1]?.uid;
                        focusAfterRender(() =>
                          next !== undefined
                            ? byData(root.current, '[data-field]', 'field', next)?.querySelector(
                                'input',
                              )
                            : root.current?.querySelector<HTMLElement>(
                                `[data-testid="${testId}-add-field"]`,
                              ),
                        );
                        onChange({ ...draft, rows: draft.rows.filter((_, i) => i !== index) });
                      }}
                      aria-label={t(`移除第 ${n} 个字段`, `Remove field ${n}`)}
                    >
                      {t('移除', 'Remove')}
                    </Button>
                    {problem !== null ? (
                      <p className="field-error" role="alert">
                        {problem}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="row-wrap">
            <Button
              variant="secondary"
              size="s"
              disabled={busy}
              onClick={() => onChange({ ...draft, rows: [...draft.rows, newSchemaRow()] })}
              data-testid={`${testId}-add-field`}
            >
              {t('添加字段', 'Add field')}
            </Button>
            <label className="row-wrap text-small">
              <input
                type="checkbox"
                checked={draft.additionalProperties === false}
                onChange={(event) => {
                  const { additionalProperties: _, ...rest } = draft;
                  onChange(event.target.checked ? { ...rest, additionalProperties: false } : rest);
                }}
                disabled={busy}
                data-testid={`${testId}-closed`}
              />
              {t('只接受列出的字段', 'Only the listed fields')}
            </label>
          </div>
        </>
      ) : (
        <>
          <Textarea
            className="input-mono"
            id={`${id}-json`}
            aria-label={t('JSON', 'JSON')}
            value={draft.text}
            onChange={(event) => onChange({ mode: 'json', text: event.target.value })}
            minRows={6}
            spellCheck={false}
            disabled={busy}
            invalid={errors.some((error) => error.path === '')}
            data-testid={`${testId}-json`}
          />
          {blocker !== null ? (
            // UX P3-4 on #738: which field, and what of it — so the person knows what to change
            // to get the list back.
            <span className="text-small text-3" data-testid={`${testId}-json-only`}>
              {t('只能用 JSON 编辑：', 'Edited as JSON only: ')}
              {schemaListBlockerText(blocker, t)}
            </span>
          ) : null}
        </>
      )}
      {rest.length > 0 ? (
        <div className="field-error stack-s" role="alert" data-testid={`${testId}-errors`}>
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
      <div className="row-wrap">
        {draft.mode === 'fields' ? (
          <Button
            variant="ghost"
            size="s"
            disabled={busy}
            onClick={() => onChange(schemaDraftAsJson(draft))}
            data-testid={`${testId}-as-json`}
          >
            {t('用 JSON 编辑', 'Edit as JSON')}
          </Button>
        ) : asFields !== null ? (
          <Button
            variant="ghost"
            size="s"
            disabled={busy}
            onClick={() => onChange(asFields)}
            data-testid={`${testId}-as-fields`}
          >
            {t('用字段列表编辑', 'Edit as a field list')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="s"
          disabled={busy}
          onClick={onRemove}
          data-testid={`${testId}-remove`}
        >
          {removeLabel}
        </Button>
      </div>
    </fieldset>
  );
}
