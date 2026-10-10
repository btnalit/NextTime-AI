import {
  GateTransportKindWireSchema,
  type OntologyTypeWire,
  type SkillDetailWire,
} from '@nexttime/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { finalizeSkillName, slugifySkillNameDraft } from '../../lib/catalog-input.js';
import {
  EMPTY_SKILL_FORM,
  type FieldErrors,
  type SkillForm,
  joinList,
  skillNamePublishWarning,
  splitList,
  validateSkill,
} from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { reviewFieldNames } from '../../lib/credential-review.js';
import { isForbiddenError } from '../../lib/errors.js';
import type { SkillRow } from '../../lib/governance.js';
import { objectTypeOptions } from '../../lib/graph-view.js';
import { useT } from '../../lib/i18n.js';
import { transportKindLabel } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { Combobox, ComboboxChips } from '../kit/combobox.js';
import { Button } from '../ui/Button.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Textarea, describedBy } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { Tabs } from '../ui/Tabs.js';
import { DraftProposed, type ProposedDraft } from './DraftProposed.js';
import { MarkdownPreview } from './MarkdownPreview.js';

export interface SkillEditorProps {
  readonly http: CapabilityCaller;
  /** "编辑（生成新草稿版本）": the row to copy from. `propose_skill` addresses no family, so the
   *  result is a *new* Skill (new id, v1), not a new version of this one — S8 W4 (leftover 48
   *  "无 get_skill") only fixes the *prefill*: `get_skill{skillId}` now exists, so the body no
   *  longer has to be re-typed from scratch. */
  readonly copyOf?: SkillRow;
  readonly onProposed: (draft: ProposedDraft) => void;
  readonly onDone: () => void;
}

type BodyView = 'edit' | 'preview';

/** The four transport kinds a gate can have (`GateTransportKindWireSchema`) — what
 *  `applicable.gateKinds` is matched against (a gate's `kind`). */
const GATE_KINDS: readonly string[] = GateTransportKindWireSchema.options;

/**
 * components/catalog/SkillEditor (S6-A A2 — docs/console-completion-plan.md §5.3, design doc
 * §6.4 "SKILL.md 形态"): frontmatter fields (name, description, applicable gate kinds /
 * ObjectTypes) plus the Markdown body with an edit / preview toggle. Submit validates against
 * `ProposeSkillContentSchema` (packages/shared/src/skill.ts — the same schema the kernel's
 * `propose_skill` handler parses) and calls `propose_skill{skill}`; the pi publish-time name
 * rule is shown as a warning while drafting. The success state offers `publish_skill`.
 */
export function SkillEditor({ http, copyOf, onProposed, onDone }: SkillEditorProps) {
  const t = useT();
  const permissions = usePermissions();
  const [form, setForm] = useState<SkillForm>(() =>
    copyOf
      ? {
          ...EMPTY_SKILL_FORM,
          name: copyOf.name,
          description: copyOf.description,
          gateKinds: joinList(copyOf.applicable?.gateKinds as readonly string[] | undefined),
          objectTypes: joinList(copyOf.applicable?.objectTypes as readonly string[] | undefined),
        }
      : EMPTY_SKILL_FORM,
  );
  const [bodyView, setBodyView] = useState<BodyView>('edit');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [proposed, setProposed] = useState<ProposedDraft | null>(null);
  /** The last keystroke was rewritten toward the publish name rule (shown as a hint). */
  const [nameAdjusted, setNameAdjusted] = useState(false);

  // S8 W4 (leftover 48 "无 get_skill"): fetches the current version's full body to prefill the
  // Markdown field, which `list_skills`/`copyOf` never carries. Skipped entirely (no network
  // call) when this is a fresh draft (`copyOf` undefined) via the `load` override, the same
  // pattern `access/GrantGateForm.tsx` uses to skip `list_operations` while no single gate is
  // targeted.
  const skillDetail = useCapability<SkillDetailWire | null>(
    http,
    'get_skill',
    copyOf ? { skillId: copyOf.id } : undefined,
    { load: copyOf ? undefined : async () => null },
  );
  // Applies the fetched body to the form exactly once — a ref, not a `useEffect` dependency on
  // `form`/`update`, so typing in the Markdown field before the read resolves is never clobbered
  // by a second application, and the effect does not need `form`/`setForm` in its own deps.
  const appliedDetail = useRef(false);
  useEffect(() => {
    if (appliedDetail.current) return;
    if (skillDetail.state.status !== 'ready' || skillDetail.state.data === null) return;
    appliedDetail.current = true;
    const detail = skillDetail.state.data;
    setForm((prev) => ({ ...prev, markdown: detail.markdown }));
  }, [skillDetail.state]);

  function update<K extends keyof SkillForm>(key: K, value: SkillForm[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  /** console-ux-2: the publish-time name rule (`PublishedSkillNameSchema`) is applied as the
   *  person types instead of only being warned about — `propose_skill` accepted any name, so a
   *  draft saved fine and then failed at publish. Skipped mid-IME-composition (rewriting the
   *  pinyin buffer would break the input method); `onCompositionEnd` applies it then. */
  function typeName(raw: string, composing: boolean): void {
    if (composing) {
      update('name', raw);
      return;
    }
    const slug = slugifySkillNameDraft(raw);
    setNameAdjusted(slug !== raw);
    update('name', slug);
  }

  // console-ux-3: applicable ObjectTypes are picked from the published ontology instead of typed
  // as a comma list (a typo silently never matched). Same read the graph page's type filter makes.
  const objectTypes = useCapabilityList<OntologyTypeWire>(
    http,
    'list_types',
    { kind: 'object' },
    { autoLoadAll: true },
  );

  function setObjectTypes(next: readonly string[]): void {
    update('objectTypes', joinList(next));
  }

  function toggleGateKind(kind: string): void {
    const current = splitList(form.gateKinds);
    update(
      'gateKinds',
      joinList(current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const name = finalizeSkillName(form.name);
    const submitted: SkillForm = { ...form, name };
    if (name !== form.name) setForm(submitted);
    const validated = validateSkill(submitted, t);
    if (!validated.ok || name === '') {
      setErrors({
        ...(validated.ok ? {} : validated.errors),
        ...(name === ''
          ? {
              name: t(
                '请填写名称：小写英文字母、数字和连字符，例如 restart-web（中文会被去掉，中文说明写在「描述」里）。',
                'Enter a name: lowercase letters, digits and hyphens, e.g. restart-web (other characters are dropped — put prose in the description).',
              ),
            }
          : {}),
      });
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      const result = await http.call<ProposedDraft>('propose_skill', { skill: validated.value });
      setProposed(result);
      onProposed(result);
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('propose_skill');
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (proposed) {
    return (
      <DraftProposed
        kindLabel="Skill"
        draft={proposed}
        detailHref={hrefs.catalog('skills', proposed.id)}
        fieldNames={reviewFieldNames('skill', t)}
        onPublish={
          permissions.isDenied('publish_skill')
            ? undefined
            : (review) =>
                http.call<{ status: string }>('publish_skill', { skillId: proposed.id, ...review })
        }
        onDone={onDone}
        reviewersSeeDraft
      />
    );
  }

  const finalName = finalizeSkillName(form.name);
  const nameHint =
    form.name.trim() !== '' && finalName === ''
      ? t(
          '名称至少要有一个英文字母或数字（中文会被去掉），例如 restart-web。',
          'The name needs at least one letter or digit (other characters are dropped), e.g. restart-web.',
        )
      : skillNamePublishWarning(form.name, t) !== undefined
        ? t(
            `保存时将改为 ${finalName}（发布要求：小写字母、数字，单个连字符分隔）。`,
            `Will be saved as ${finalName} (publishing requires lowercase letters and digits with single hyphens).`,
          )
        : nameAdjusted
          ? t(
              '已自动改为发布要求的格式：小写字母、数字，单个连字符分隔。',
              'Adjusted automatically to the publish format: lowercase letters and digits with single hyphens.',
            )
          : t(
              '将成为 SKILL.md 的 name 与挂载目录名；只能用小写字母、数字和连字符，输入时会自动转换（例如 Restart Web → restart-web）。',
              'Becomes the SKILL.md name and the mount directory; lowercase letters, digits and hyphens only — converted as you type (e.g. Restart Web → restart-web).',
            );
  const selectedGateKinds = splitList(form.gateKinds);
  const selectedObjectTypes = splitList(form.objectTypes);
  const objectTypeRows =
    objectTypes.state.status === 'ready' ? objectTypeOptions(objectTypes.state.data.items) : [];
  const objectTypesRefused =
    objectTypes.state.status === 'error' && isForbiddenError(objectTypes.state.error);
  /** The directory is unusable (refused, failed, or the ontology has no ObjectType yet): typed
   *  entry stays available so the field is never a dead end. */
  const objectTypesTyped =
    objectTypes.state.status === 'error' ||
    (objectTypes.state.status === 'ready' && objectTypeRows.length === 0);
  const knownObjectTypes = new Set(objectTypeRows.map((row) => row.name));
  const unknownObjectTypes = new Set(
    objectTypes.state.status === 'ready'
      ? selectedObjectTypes.filter((name) => !knownObjectTypes.has(name))
      : [],
  );
  const gateKindOptions = [
    ...GATE_KINDS,
    // A copied Skill's value outside the four kinds stays visible (and submitted) rather than
    // being silently dropped.
    ...selectedGateKinds.filter((kind) => !GATE_KINDS.includes(kind)),
  ];

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="skill-editor"
    >
      {copyOf ? (
        <Notice tone="warn" testId="skill-copy-notice">
          {t(
            <>
              从 <strong>{copyOf.name}</strong> v{copyOf.version}{' '}
              复制（已预填当前版本的正文）：内核的 propose_skill 不接受 skillId，提交会创建一个
              <strong>新的</strong> Skill（新 id、v1），不是 同一 Skill 的新版本。
            </>,
            <>
              Copied from {copyOf.name} v{copyOf.version} (the current version’s body is
              pre-filled): propose_skill takes no skillId, so submitting creates a{' '}
              <strong>new</strong> Skill (new id, v1), not a new version of this one.
            </>,
          )}
        </Notice>
      ) : (
        <Notice testId="skill-private-notice">
          {t(
            '草稿只有你（提议者）和工作区的 owner、builder 可见，发布后所有成员可见。',
            'Until published, the draft is visible only to you, the workspace owner and builders.',
          )}
        </Notice>
      )}

      <Field
        id="skill-name"
        label={t('名称', 'name')}
        required
        error={errors.name || null}
        hint={nameHint}
      >
        <Input
          id="skill-name"
          value={form.name}
          onChange={(event) =>
            typeName(event.target.value, (event.nativeEvent as InputEvent).isComposing === true)
          }
          onCompositionEnd={(event) => typeName(event.currentTarget.value, false)}
          onBlur={() => {
            if (finalName !== form.name) update('name', finalName);
          }}
          disabled={busy}
          mono
          invalid={!!errors.name}
          placeholder="restart-web"
          aria-describedby={describedBy('skill-name', true, !!errors.name)}
          data-testid="skill-name"
        />
      </Field>
      <Field
        id="skill-description"
        label={t('描述', 'description')}
        required
        error={errors.description || null}
        hint={t('一句话说明何时用它（≤ 1024 字）。', 'One line on when to use it (≤ 1024 chars).')}
      >
        <Textarea
          id="skill-description"
          value={form.description}
          onChange={(event) => update('description', event.target.value)}
          rows={2}
          disabled={busy}
          invalid={!!errors.description}
          aria-describedby={describedBy(
            'skill-description',
            !errors.description,
            !!errors.description,
          )}
        />
      </Field>
      <div className="row-wrap" style={{ alignItems: 'flex-start' }}>
        <div className="field" data-testid="skill-gate-kinds">
          <span className="field-label" id="skill-gate-kinds-label">
            {t('适用的门类型', 'Applicable gate kinds')}
          </span>
          <fieldset
            className="row-wrap"
            aria-labelledby="skill-gate-kinds-label"
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            {gateKindOptions.map((kind) => (
              <label className="checkbox" key={kind}>
                <input
                  type="checkbox"
                  checked={selectedGateKinds.includes(kind)}
                  onChange={() => toggleGateKind(kind)}
                  disabled={busy}
                />
                <span>{transportKindLabel(kind, t)}</span>
              </label>
            ))}
          </fieldset>
          <p className="field-hint">
            {t('可不选：不选表示不限门类型。', 'Optional — none checked means any kind of gate.')}
          </p>
          {errors['applicable.gateKinds'] ? (
            <p className="field-error" role="alert">
              {errors['applicable.gateKinds']}
            </p>
          ) : null}
        </div>
        <Field
          id="skill-object-types"
          label={t('适用的对象类型', 'Applicable object types')}
          hint={
            objectTypesTyped
              ? t('逗号或换行分隔，可空。', 'Comma / newline separated; optional.')
              : t(
                  '从工作区已发布的本体中选择，可多选，可空。',
                  'Pick from the workspace’s published ontology; several allowed, optional.',
                )
          }
          error={errors['applicable.objectTypes'] || null}
        >
          {objectTypesTyped ? (
            <Input
              id="skill-object-types"
              value={form.objectTypes}
              onChange={(event) => update('objectTypes', event.target.value)}
              disabled={busy}
              mono
              placeholder="Container, Host"
              data-testid="skill-object-types-input"
            />
          ) : (
            <div className="stack-s">
              <Combobox
                id="skill-object-types"
                options={objectTypeRows
                  .filter((row) => !selectedObjectTypes.includes(row.name))
                  .map((row) => ({
                    value: row.name,
                    label: row.name,
                    secondary: row.description || undefined,
                  }))}
                value=""
                onChange={(name) => {
                  if (name !== '') setObjectTypes([...selectedObjectTypes, name]);
                }}
                loading={objectTypes.state.status === 'loading'}
                disabled={busy}
                clearable={false}
                mono
                placeholder={t('输入以搜索对象类型…', 'Type to search object types…')}
                emptyText={t('没有更多可选的对象类型。', 'No more object types to pick.')}
                testId="skill-object-types"
              />
              <ComboboxChips
                values={selectedObjectTypes}
                unknown={unknownObjectTypes}
                onRemove={(name) =>
                  setObjectTypes(selectedObjectTypes.filter((value) => value !== name))
                }
                disabled={busy}
                testId="skill-object-types-chosen"
              />
            </div>
          )}
          {objectTypesRefused ? (
            <p className="field-hint" data-testid="skill-object-types-refused">
              {t(
                '无权读取本体类型列表，请手动输入。',
                'Not allowed to read the ontology type list — type the names instead.',
              )}
            </p>
          ) : objectTypes.state.status === 'ready' && objectTypeRows.length === 0 ? (
            <p className="field-hint" data-testid="skill-object-types-empty">
              {t(
                '工作区的本体还没有已发布的对象类型，可以手动输入。',
                'The workspace ontology has no published object type yet — type the names if needed.',
              )}
            </p>
          ) : null}
          {unknownObjectTypes.size > 0 ? (
            <p className="field-hint" data-testid="skill-object-types-unknown">
              {t(
                `不在已发布本体中，仍会保留：${[...unknownObjectTypes].join(', ')}`,
                `Not in the published ontology, kept as is: ${[...unknownObjectTypes].join(', ')}`,
              )}
            </p>
          ) : null}
        </Field>
        {objectTypes.state.status === 'error' && !objectTypesRefused ? (
          <ErrorBanner
            error={objectTypes.state.error}
            title={t('无法加载对象类型列表', 'Could not load the object types')}
            onRetry={() => void objectTypes.reload()}
            testId="skill-object-types-error"
          />
        ) : null}
      </div>

      <div className="stack-s">
        <div className="row">
          <span className="section-title grow">{t('正文', 'Markdown body')}</span>
          <Tabs<BodyView>
            ariaLabel="Body view"
            value={bodyView}
            onChange={setBodyView}
            options={[
              { value: 'edit', label: t('编辑', 'Edit'), testId: 'skill-body-edit' },
              { value: 'preview', label: t('预览', 'Preview'), testId: 'skill-body-preview' },
            ]}
          />
        </div>
        {bodyView === 'edit' ? (
          <Field
            id="skill-markdown"
            label={t('SKILL.md 正文（不含 frontmatter）', 'SKILL.md body (no frontmatter)')}
            required
            error={errors.markdown || null}
            hint={
              copyOf && skillDetail.state.status === 'loading'
                ? t('正在加载当前版本的正文…', 'Loading the current version’s body…')
                : t(
                    '这段正文会替换 fields 生成的 frontmatter 以外的内容。',
                    'This is everything below the fields-generated frontmatter.',
                  )
            }
          >
            <Textarea
              id="skill-markdown"
              value={form.markdown}
              onChange={(event) => update('markdown', event.target.value)}
              rows={14}
              mono
              disabled={busy || (copyOf !== undefined && skillDetail.state.status === 'loading')}
              invalid={!!errors.markdown}
              spellCheck={false}
              aria-describedby={describedBy('skill-markdown', true, !!errors.markdown)}
            />
          </Field>
        ) : (
          <MarkdownPreview markdown={form.markdown} testId="skill-markdown-preview" />
        )}
      </div>

      {error !== null ? (
        <ErrorBanner
          error={error}
          title={t('无法创建草稿', 'Could not propose the draft')}
          testId="skill-editor-error"
        />
      ) : null}

      <div className="row">
        <Button type="submit" variant="primary" loading={busy} data-testid="skill-submit">
          {t('保存草稿', 'Save draft')}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          {t('取消', 'Cancel')}
        </Button>
      </div>
    </form>
  );
}
