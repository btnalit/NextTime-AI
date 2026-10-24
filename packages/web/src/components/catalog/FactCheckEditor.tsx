import type {
  FactWire,
  ObjectWire,
  OntologyLinkTypeWire,
  OntologyObjectTypeWire,
  OntologyTypeWire,
} from '@nexttime/shared';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { useDebounced } from '../../lib/audit-id-picker.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  type FactCheckDraft,
  type FactIdentityRow,
  type FactRefDraft,
  emptyFactRef,
  factCheckDraftAsForm,
  factCheckDraftAsJson,
  factEndTypes,
  factFormBlocker,
  factFormBlockerText,
  factIdentityLooksNumeric,
  factIdentityMismatch,
  factIdentityRows,
  factRowsForType,
  newFactIdentityRow,
} from '../../lib/fact-check-draft.js';
import { isUuidLike, objectDisplayName } from '../../lib/graph-view.js';
import { useT } from '../../lib/i18n.js';
import {
  PREDICATE_VALUE_KINDS,
  type PredicateValueKind,
  emptyPredicateDraft,
  predicateValueKindLabel,
} from '../../lib/predicate-draft.js';
import { Button } from '../kit/button.js';
import { Combobox } from '../kit/combobox.js';
import { Field } from '../kit/field.js';
import { Select } from '../kit/select.js';
import { Textarea } from '../kit/textarea.js';
import { PredicateEditor } from './PredicateEditor.js';

type FormDraft = Extract<FactCheckDraft, { mode: 'form' }>;
type ErrorList = readonly { readonly path: string; readonly message: string }[];

const under = (errors: ErrorList, prefix: string): ErrorList =>
  errors.flatMap((error) =>
    error.path === prefix
      ? [{ path: '', message: error.message }]
      : error.path.startsWith(`${prefix}.`)
        ? [{ path: error.path.slice(prefix.length + 1), message: error.message }]
        : [],
  );

/**
 * components/catalog/FactCheckEditor (legacy 464, PR-B): the Fact a `fact_predicate` check judges
 * (`lib/fact-check-draft`) — its Link type chosen from the ontology, each end an ObjectType the
 * Link type allows plus that type's own identity fields (or a picked Object's values, as stored),
 * or one Object by id; and, optionally, what the Fact's own properties must satisfy
 * (`PredicateEditor`). The ontology and the graph are read with what every member can read
 * (`list_types`, `search`, `list_facts`); a list that does not load leaves its box free to type.
 */
export function FactCheckEditor({
  http,
  id,
  draft,
  errors,
  busy,
  onChange,
  testId,
}: {
  readonly http: CapabilityCaller;
  readonly id: string;
  readonly draft: FactCheckDraft;
  readonly errors: ErrorList;
  readonly busy: boolean;
  readonly onChange: (draft: FactCheckDraft) => void;
  readonly testId: string;
}) {
  const t = useT();
  const linkTypes = useCapabilityList<OntologyTypeWire>(
    http,
    'list_types',
    { kind: 'link' },
    { autoLoadAll: true },
  );
  const objectTypes = useCapabilityList<OntologyTypeWire>(
    http,
    'list_types',
    { kind: 'object' },
    { autoLoadAll: true },
  );
  const links = useMemo(
    () =>
      linkTypes.state.status === 'ready'
        ? linkTypes.state.data.items.filter(
            (type): type is OntologyLinkTypeWire => type.kind === 'link',
          )
        : [],
    [linkTypes.state],
  );
  const objects = useMemo(
    () =>
      objectTypes.state.status === 'ready'
        ? objectTypes.state.data.items.filter(
            (type): type is OntologyObjectTypeWire => type.kind === 'object',
          )
        : [],
    [objectTypes.state],
  );
  const form = draft.mode === 'form' ? draft : null;
  const linkType = form ? links.find((link) => link.name === form.linkType.trim()) : undefined;
  // The properties Facts of this Link type carry now — offered as a hint for the paths below.
  const samples = useCapabilityList<FactWire>(
    http,
    'list_facts',
    { linkType: form?.linkType.trim() ?? '', limit: 20 },
    { enabled: form !== null && form.expect !== null && form.linkType.trim() !== '' },
  );
  const sampleKeys =
    samples.state.status === 'ready'
      ? [...new Set(samples.state.data.items.flatMap((fact) => Object.keys(fact.properties)))]
      : [];
  const blocker = factFormBlocker(draft);
  const asForm = draft.mode === 'json' ? factCheckDraftAsForm(draft) : null;
  const shown = ['linkType', 'source', 'target', 'expect'];
  const rest =
    draft.mode === 'form'
      ? errors.filter(
          (error) => !shown.some((key) => error.path === key || error.path.startsWith(`${key}.`)),
        )
      : errors;
  const linkError = under(errors, 'linkType');
  const linkUnknown =
    form !== null &&
    linkTypes.state.status === 'ready' &&
    form.linkType.trim() !== '' &&
    linkType === undefined;

  function edit(patch: Partial<FormDraft>): void {
    if (form) onChange({ ...form, ...patch });
  }

  return (
    <fieldset className="stack-s fact-check-editor" data-testid={testId}>
      <legend className="text-small">{t('要判定的事实', 'The Fact judged')}</legend>
      {form ? (
        <>
          <Field
            id={`${id}-link`}
            label={t('关系类型', 'Link type')}
            required
            error={
              linkError.length > 0 ? linkError.map((e) => e.message).join(t('；', '; ')) : null
            }
            hint={warning(
              linkUnknown
                ? t(
                    `本体里没有关系类型 ${form?.linkType.trim()}：这条检查永远找不到事实。`,
                    `The ontology has no Link type ${form?.linkType.trim()}: the check never finds the Fact.`,
                  )
                : null,
              `${testId}-link-warning`,
            )}
          >
            <Combobox
              id={`${id}-link`}
              aria-label={t('关系类型', 'Link type')}
              options={links.map((link) => ({
                value: link.name,
                label: link.name,
                secondary: link.signatures
                  .map((signature) => `${signature.domain} → ${signature.range}`)
                  .join(t('；', '; ')),
              }))}
              value={form.linkType}
              onChange={(next) => edit({ linkType: next })}
              allowFreeEntry
              mono
              loading={linkTypes.state.status === 'loading'}
              disabled={busy}
              invalid={linkError.length > 0}
              placeholder={t('选一个关系类型，如 runs_on', 'Pick a Link type, e.g. runs_on')}
              emptyText={
                linkTypes.state.status === 'error'
                  ? t(
                      '关系类型读取失败：直接写名字。',
                      'Could not read the Link types: type the name.',
                    )
                  : t('没有匹配的关系类型。', 'No Link type matches.')
              }
              testId={`${testId}-link`}
            />
          </Field>
          {(['source', 'target'] as const).map((end) => (
            <FactEndFields
              key={end}
              http={http}
              id={`${id}-${end}`}
              end={end}
              value={form[end]}
              allowed={factEndTypes(linkType, end)}
              objectTypes={objects}
              typesLoading={objectTypes.state.status === 'loading'}
              typesKnown={objectTypes.state.status === 'ready'}
              errors={under(errors, end)}
              busy={busy}
              onChange={(ref) => edit({ [end]: ref })}
              testId={`${testId}-${end}`}
            />
          ))}
          {form.expect !== null ? (
            <div className="stack-s">
              <PredicateEditor
                id={`${id}-expect`}
                legend={t('这条事实的属性还要满足', 'The Fact’s properties must also satisfy')}
                draft={form.expect}
                errors={under(errors, 'expect')}
                busy={busy}
                onChange={(expect) => edit({ expect })}
                testId={`${testId}-expect`}
              />
              {sampleKeys.length > 0 ? (
                <span className="text-small text-3" data-testid={`${testId}-sample-keys`}>
                  {t(
                    `这类事实现在带的属性：${sampleKeys.join('、')}`,
                    `Properties Facts of this type carry now: ${sampleKeys.join(', ')}`,
                  )}
                </span>
              ) : null}
              <div>
                <Button
                  variant="ghost"
                  size="s"
                  disabled={busy}
                  onClick={() => edit({ expect: null })}
                  data-testid={`${testId}-drop-expect`}
                >
                  {t('不要求属性', 'No property condition')}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                variant="secondary"
                size="s"
                disabled={busy}
                onClick={() => edit({ expect: emptyPredicateDraft() })}
                data-testid={`${testId}-add-expect`}
              >
                {t('另外要求这条事实的属性', 'Also require the Fact’s properties')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <Textarea
            className="input-mono"
            id={`${id}-json`}
            aria-label={t('要判定的事实（JSON）', 'The Fact judged (JSON)')}
            value={draft.mode === 'json' ? draft.text : ''}
            onChange={(event) => onChange({ mode: 'json', text: event.target.value })}
            minRows={4}
            spellCheck={false}
            disabled={busy}
            invalid={errors.length > 0}
            data-testid={`${testId}-json`}
          />
          {blocker !== null ? (
            <span className="text-small text-3" data-testid={`${testId}-json-only`}>
              {t('只能用 JSON 编辑：', 'Edited as JSON only: ')}
              {factFormBlockerText(blocker, t)}
            </span>
          ) : null}
        </>
      )}
      {rest.length > 0 ? (
        <p className="field-error" role="alert" data-testid={`${testId}-errors`}>
          {rest
            .map((error) => (error.path === '' ? error.message : `${error.path}：${error.message}`))
            .join(t('；', '; '))}
        </p>
      ) : null}
      <div className="row-wrap">
        {draft.mode === 'form' ? (
          <Button
            variant="ghost"
            size="s"
            disabled={busy}
            onClick={() => onChange(factCheckDraftAsJson(draft))}
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

/** A field hint that is a warning — the check as written never finds the Fact — set apart from
 *  the grey explanations. */
function warning(text: string | null, testId: string): ReactNode {
  return text === null ? undefined : (
    <span className="text-warn" data-testid={testId}>
      {text}
    </span>
  );
}

const SEARCH_DEBOUNCE_MS = 250;

/** Objects of `objectType` (any, when empty) matching what was typed — for a picker. */
function useObjectSearch(
  http: CapabilityCaller,
  objectType: string,
  typed: string,
  enabled: boolean,
) {
  const query = useDebounced(typed.trim(), SEARCH_DEBOUNCE_MS);
  const result = useCapabilityList<ObjectWire>(
    http,
    'search',
    { query, ...(objectType !== '' ? { objectType } : {}), limit: 20 },
    { enabled },
  );
  return {
    loading: result.state.status === 'loading',
    failed: result.state.status === 'error',
    items: result.state.status === 'ready' ? result.state.data.items : [],
  };
}

function FactEndFields({
  http,
  id,
  end,
  value,
  allowed,
  objectTypes,
  typesLoading,
  typesKnown,
  errors,
  busy,
  onChange,
  testId,
}: {
  readonly http: CapabilityCaller;
  readonly id: string;
  readonly end: 'source' | 'target';
  readonly value: FactRefDraft;
  /** The ObjectTypes the Link type allows here; `null`: any. */
  readonly allowed: readonly string[] | null;
  readonly objectTypes: readonly OntologyObjectTypeWire[];
  readonly typesLoading: boolean;
  /** The ontology's ObjectTypes were read, so a name not among them is not in it. */
  readonly typesKnown: boolean;
  readonly errors: ErrorList;
  readonly busy: boolean;
  readonly onChange: (ref: FactRefDraft) => void;
  readonly testId: string;
}) {
  const t = useT();
  const legend = end === 'source' ? t('从', 'From') : t('到', 'To');
  const offered =
    allowed === null ? objectTypes : objectTypes.filter((type) => allowed.includes(type.name));
  const objectType = value.by === 'identity' ? value.objectType.trim() : '';
  const declared = objectTypes.find((type) => type.name === objectType)?.identityKey;
  const [typed, setTyped] = useState('');
  const singleType = allowed !== null && allowed.length === 1 ? (allowed[0] ?? '') : '';
  const found = useObjectSearch(
    http,
    value.by === 'identity' ? objectType : singleType,
    typed,
    value.by === 'id' || objectType !== '',
  );
  const byId = useRef(new Map<string, ObjectWire>());
  for (const object of found.items) byId.current.set(object.id, object);
  // The chosen Object by id — picked here, pasted, or from a reopened draft — read once, so the
  // field names it (name · type) and its type is checked against the end; `null`: not in the graph.
  const objectId = value.by === 'id' ? value.objectId.trim() : '';
  const [chosen, setChosen] = useState<{ id: string; object: ObjectWire | null } | null>(null);
  useEffect(() => {
    if (objectId === '' || byId.current.has(objectId) || chosen?.id === objectId) return;
    let live = true;
    http
      .call<ObjectWire | null>('get_object', { objectId })
      .then((object) => {
        if (live) setChosen({ id: objectId, object });
      })
      .catch(() => {
        // Unreadable (not an id, forbidden, network): named by its short id, no type check.
        if (live) setChosen({ id: objectId, object: null });
      });
    return () => {
      live = false;
    };
  }, [http, objectId, chosen?.id]);
  const chosenObject =
    objectId === ''
      ? undefined
      : (byId.current.get(objectId) ?? (chosen?.id === objectId ? chosen.object : undefined));
  const objectLabel = (object: ObjectWire) =>
    `${
      objectDisplayName(
        object,
        objectTypes.find((type) => type.name === object.objectType)?.identityKey,
      ) ?? object.id.slice(0, 8)
    } · ${object.objectType}`;
  // Only Objects this end takes are offered; the chosen one is always there, so it is named.
  const objectOptions = [
    ...found.items.filter((object) => allowed === null || allowed.includes(object.objectType)),
    ...(chosenObject && !found.items.some((object) => object.id === chosenObject.id)
      ? [chosenObject]
      : []),
  ].map((object) => ({ value: object.id, label: objectLabel(object), secondary: object.id }));
  if (objectId !== '' && chosenObject === null) {
    objectOptions.push({
      value: objectId,
      label: t(`对象 ${objectId.slice(0, 8)}`, `Object ${objectId.slice(0, 8)}`),
      secondary: objectId,
    });
  }
  const chosenOutside =
    chosenObject && allowed !== null && !allowed.includes(chosenObject.objectType)
      ? chosenObject.objectType
      : null;
  const message = (list: ErrorList) =>
    list.length === 0 ? null : list.map((error) => error.message).join(t('；', '; '));
  const typeError = message(under(errors, 'objectType'));
  const idError = message(under(errors, 'objectId'));
  const typeOutside =
    objectType !== '' && allowed !== null && !allowed.includes(objectType) ? objectType : null;
  const typeUnknown =
    objectType !== '' && typesKnown && !objectTypes.some((type) => type.name === objectType);

  return (
    <fieldset className="stack-s fact-end" data-testid={testId}>
      <legend className="text-small">{legend}</legend>
      <div className="row-wrap">
        <label className="choice-line text-small">
          <input
            type="radio"
            name={`${id}-by`}
            checked={value.by === 'identity'}
            onChange={() => onChange(emptyFactRef())}
            disabled={busy}
            data-testid={`${testId}-by-identity`}
          />
          <span>
            {t('按类型和身份（对象可以还不存在）', 'By type and identity (it may not exist yet)')}
          </span>
        </label>
        <label className="choice-line text-small">
          <input
            type="radio"
            name={`${id}-by`}
            checked={value.by === 'id'}
            onChange={() => onChange({ by: 'id', objectId: '' })}
            disabled={busy}
            data-testid={`${testId}-by-id`}
          />
          <span>{t('就是图谱里已有的这一个对象', 'This one Object already in the graph')}</span>
        </label>
      </div>
      {value.by === 'id' ? (
        <Field
          id={`${id}-object`}
          label={t('对象', 'Object')}
          required
          error={idError}
          hint={warning(
            chosenOutside !== null
              ? t(
                  `关系类型的这一端不接 ${chosenOutside}。`,
                  `The Link type does not take ${chosenOutside} at this end.`,
                )
              : objectId !== '' && chosen?.id === objectId && chosen.object === null
                ? t(
                    '图谱里读不到这个对象：检查永远找不到这条事实。',
                    'This Object cannot be read from the graph: the check never finds the Fact.',
                  )
                : null,
            `${testId}-object-warning`,
          )}
        >
          <Combobox
            id={`${id}-object`}
            aria-label={t(`${legend}：对象`, `${legend}: the Object`)}
            options={objectOptions}
            value={value.objectId}
            onChange={(next) => onChange({ by: 'id', objectId: next })}
            // Picked, the field names the Object; a pasted id is taken as it is pasted.
            inputValue={typed}
            onInputValueChange={(text) => {
              setTyped(text);
              // A whole id is taken as it is; once read it is the one row offered, so a paste
              // picks it and Enter takes it, and the field names it (name · type).
              if (isUuidLike(text.trim())) onChange({ by: 'id', objectId: text.trim() });
            }}
            // Left with an id typed and not picked: it is already taken; show its name.
            onBlur={() => {
              if (isUuidLike(typed.trim())) setTyped('');
            }}
            loading={found.loading}
            disabled={busy}
            invalid={idError !== null}
            placeholder={t('输入关键字找对象，或粘贴 ID', 'Type to find an Object, or paste an id')}
            emptyText={
              found.failed
                ? t('对象读取失败：可以粘贴对象 ID。', 'Could not read the Objects: paste an id.')
                : t(
                    '没有这一端能接的匹配对象；也可以粘贴对象 ID。',
                    'No Object this end takes matches; an id can be pasted.',
                  )
            }
            testId={`${testId}-object`}
          />
        </Field>
      ) : (
        <>
          <Field
            id={`${id}-type`}
            label={t('对象类型', 'Object type')}
            required
            error={typeError}
            hint={warning(
              typeOutside !== null
                ? t(
                    `关系类型的这一端不接 ${typeOutside}。`,
                    `The Link type does not take ${typeOutside} at this end.`,
                  )
                : typeUnknown
                  ? t(
                      `本体里没有对象类型 ${objectType}。`,
                      `The ontology has no Object type ${objectType}.`,
                    )
                  : null,
              `${testId}-type-warning`,
            )}
          >
            <Combobox
              id={`${id}-type`}
              aria-label={t(`${legend}：对象类型`, `${legend}: Object type`)}
              options={offered.map((type) => ({
                value: type.name,
                label: type.name,
                secondary: type.identityKey?.join(' + '),
              }))}
              value={value.objectType}
              onChange={(next) => {
                const key = objectTypes.find((type) => type.name === next.trim())?.identityKey;
                onChange({
                  by: 'identity',
                  objectType: next,
                  rows: key ? factRowsForType(value.rows, key) : value.rows,
                });
              }}
              allowFreeEntry
              mono
              loading={typesLoading}
              disabled={busy}
              invalid={typeError !== null}
              placeholder={t('选一个对象类型', 'Pick an Object type')}
              emptyText={t('没有匹配的对象类型。', 'No Object type matches.')}
              testId={`${testId}-type`}
            />
          </Field>
          <IdentityRows
            id={`${id}-identity`}
            legend={legend}
            rows={value.rows}
            declared={declared}
            typeChosen={objectType !== ''}
            errors={under(errors, 'identity')}
            busy={busy}
            onChange={(rows) => onChange({ ...value, rows })}
            testId={`${testId}-identity`}
          />
          {objectType !== '' ? (
            <Field
              id={`${id}-fill`}
              label={t(
                '从图谱里找一个对象填入身份',
                'Fill the identity from an Object in the graph',
              )}
              hint={t(
                '按它存下的值填入，数字仍是数字，不会因为写法不同而对不上。',
                'Filled with its stored values, a number staying a number, so it matches.',
              )}
            >
              <Combobox
                id={`${id}-fill`}
                aria-label={t(`${legend}：找一个对象填入身份`, `${legend}: fill from an Object`)}
                options={objectOptions}
                value={typed}
                onChange={(next) => {
                  const object = byId.current.get(next);
                  if (object === undefined) {
                    setTyped(next);
                    return;
                  }
                  setTyped('');
                  onChange({
                    by: 'identity',
                    objectType: object.objectType,
                    rows: factIdentityRows(object.identityKey ?? {}),
                  });
                }}
                allowFreeEntry
                loading={found.loading}
                disabled={busy}
                placeholder={t('输入关键字找对象', 'Type to find an Object')}
                emptyText={
                  found.failed
                    ? t('对象读取失败。', 'Could not read the Objects.')
                    : t('没有这个类型的匹配对象。', 'No Object of this type matches.')
                }
                testId={`${testId}-fill`}
              />
            </Field>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

function IdentityRows({
  id,
  legend,
  rows,
  declared,
  typeChosen,
  errors,
  busy,
  onChange,
  testId,
}: {
  readonly id: string;
  readonly legend: string;
  readonly rows: readonly FactIdentityRow[];
  /** The ObjectType's identity fields; `undefined`: it declares none (or is not known here). */
  readonly declared: readonly string[] | undefined;
  /** An ObjectType is named; until then its identity fields are not known, so none are offered. */
  readonly typeChosen: boolean;
  readonly errors: ErrorList;
  readonly busy: boolean;
  readonly onChange: (rows: readonly FactIdentityRow[]) => void;
  readonly testId: string;
}) {
  const t = useT();
  // A declared type shows exactly its fields (one not filled yet as an empty row), then any row
  // the type does not have, to be taken out.
  const shown = declared ? factRowsForType(rows, declared) : [...rows];
  const { missing, extra } = factIdentityMismatch(rows, declared);
  const extras = declared ? rows.filter((row) => extra.includes(row.key.trim())) : [];
  const all = [...shown, ...extras];
  const errorOf = (row: FactIdentityRow, index: number) => {
    const key = row.key.trim();
    const own = errors.filter(
      (error) =>
        error.path === (key === '' ? `#${index}` : key) || error.path.startsWith(`${key}.`),
    );
    return own.length === 0 ? null : own.map((error) => error.message).join(t('；', '; '));
  };
  const rest = errors.filter(
    (error) =>
      !all.some((row, index) => {
        const key = row.key.trim();
        return error.path === (key === '' ? `#${index}` : key) || error.path.startsWith(`${key}.`);
      }),
  );
  function update(uid: string, patch: Partial<FactIdentityRow>): void {
    onChange(all.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  }

  return (
    <fieldset className="stack-s fact-identity" data-testid={testId}>
      <legend className="text-small">{t('身份', 'Identity')}</legend>
      {!typeChosen && rows.length === 0 ? (
        <span className="text-small text-3" data-testid={`${testId}-pick-type`}>
          {t(
            '先选对象类型：它声明的身份字段会自动列出。',
            'Pick the Object type first: its identity fields are listed for you.',
          )}
        </span>
      ) : declared === undefined && typeChosen ? (
        <span className="text-small text-3">
          {t(
            '这个类型没有声明身份字段：字段和值要和图谱里存的完全一致。',
            'This type declares no identity fields: the fields and values must be exactly as stored in the graph.',
          )}
        </span>
      ) : null}
      {all.map((row, index) => {
        const problem = errorOf(row, index);
        const fixed = declared?.includes(row.key.trim()) ?? false;
        const n = index + 1;
        return (
          <div className="row-wrap fact-identity-row" key={row.uid} data-testid={`${testId}-row`}>
            <Field id={`${id}-${row.uid}-key`} label={t('字段', 'Field')}>
              <input
                id={`${id}-${row.uid}-key`}
                className={fixed ? 'input input-mono fact-identity-key-fixed' : 'input input-mono'}
                aria-label={t(`${legend}：第 ${n} 个身份字段`, `${legend}: identity field ${n}`)}
                value={row.key}
                readOnly={fixed}
                onChange={(event) => update(row.uid, { key: event.target.value })}
                disabled={busy}
                data-testid={`${testId}-key`}
              />
            </Field>
            <Field id={`${id}-${row.uid}-kind`} label={t('值是', 'The value is')}>
              <Select
                id={`${id}-${row.uid}-kind`}
                aria-label={t(
                  `${legend}：${row.key || n} 的值的类型`,
                  `${legend}: ${row.key || n} value kind`,
                )}
                className="select-fit"
                value={row.valueKind}
                onChange={(event) =>
                  update(row.uid, { valueKind: event.target.value as PredicateValueKind })
                }
                disabled={busy}
                data-testid={`${testId}-kind`}
              >
                {PREDICATE_VALUE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {predicateValueKindLabel(kind, t)}
                  </option>
                ))}
              </Select>
            </Field>
            {row.valueKind === 'null' ? null : row.valueKind === 'boolean' ? (
              <Field id={`${id}-${row.uid}-value`} label={t('值', 'Value')}>
                <Select
                  id={`${id}-${row.uid}-value`}
                  aria-label={t(
                    `${legend}：${row.key || n} 的值`,
                    `${legend}: ${row.key || n} value`,
                  )}
                  className="select-fit"
                  value={row.valueText === 'false' ? 'false' : 'true'}
                  onChange={(event) => update(row.uid, { valueText: event.target.value })}
                  disabled={busy}
                  data-testid={`${testId}-value`}
                >
                  <option value="true">{t('是', 'Yes')}</option>
                  <option value="false">{t('否', 'No')}</option>
                </Select>
              </Field>
            ) : (
              <Field id={`${id}-${row.uid}-value`} label={t('值', 'Value')}>
                <input
                  id={`${id}-${row.uid}-value`}
                  className={row.valueKind === 'string' ? 'input' : 'input input-mono'}
                  aria-label={t(
                    `${legend}：${row.key || n} 的值`,
                    `${legend}: ${row.key || n} value`,
                  )}
                  value={row.valueText}
                  onChange={(event) => update(row.uid, { valueText: event.target.value })}
                  disabled={busy}
                  aria-invalid={problem !== null || undefined}
                  data-testid={`${testId}-value`}
                />
              </Field>
            )}
            {fixed ? null : (
              <Button
                variant="ghost"
                size="s"
                disabled={busy}
                onClick={() => onChange(all.filter((other) => other.uid !== row.uid))}
                aria-label={t(`移除第 ${n} 个身份字段`, `Remove identity field ${n}`)}
              >
                {t('移除', 'Remove')}
              </Button>
            )}
            {factIdentityLooksNumeric(row) ? (
              <span className="text-small text-warn" data-testid={`${testId}-numeric-text`}>
                {t(
                  `身份按值完全相等来找：文本 "${row.valueText.trim()}" 和数字 ${row.valueText.trim()} 不相等。图谱里存的是数字就把「值是」改成数字，拿不准就用下面的「从图谱里找一个对象填入身份」。`,
                  `Identities match exactly: the text "${row.valueText.trim()}" is not the number ${row.valueText.trim()}. If the graph stores a number, choose Number; if unsure, fill from an Object below.`,
                )}
              </span>
            ) : null}
            {extras.includes(row) ? (
              <span className="text-small text-warn" data-testid={`${testId}-extra`}>
                {t(
                  '这个类型的身份里没有这个字段：留着就永远对不上。',
                  'The type’s identity has no such field: kept, it never matches.',
                )}
              </span>
            ) : null}
            {problem !== null ? (
              <p className="field-error" role="alert">
                {problem}
              </p>
            ) : null}
          </div>
        );
      })}
      {missing.length > 0 ? (
        <span className="text-small text-warn" data-testid={`${testId}-missing`}>
          {t(
            `还差身份字段 ${missing.join('、')}：少一个就找不到这个对象。`,
            `Missing identity field(s) ${missing.join(', ')}: without them the Object is never found.`,
          )}
        </span>
      ) : null}
      {rest.length > 0 ? (
        <p className="field-error" role="alert">
          {rest.map((error) => error.message).join(t('；', '; '))}
        </p>
      ) : null}
      {declared === undefined && (typeChosen || rows.length > 0) ? (
        <div>
          <Button
            variant="secondary"
            size="s"
            disabled={busy}
            onClick={() => onChange([...rows, newFactIdentityRow()])}
            data-testid={`${testId}-add`}
          >
            {t('加身份字段', 'Add an identity field')}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
