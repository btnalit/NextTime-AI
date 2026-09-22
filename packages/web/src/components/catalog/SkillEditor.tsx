import { type FormEvent, useState } from 'react';
import { usePermissions } from '../../hooks/usePermissions.js';
import {
  EMPTY_SKILL_FORM,
  type FieldErrors,
  type SkillForm,
  joinList,
  skillNamePublishWarning,
  validateSkill,
} from '../../lib/catalog.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import type { SkillRow } from '../../lib/governance.js';
import { Button } from '../ui/Button.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Textarea, describedBy } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { Tabs } from '../ui/Tabs.js';
import { DraftProposed, type ProposedDraft } from './DraftProposed.js';
import { MarkdownPreview } from './MarkdownPreview.js';

export interface SkillEditorProps {
  readonly http: CapabilityCaller;
  /** "编辑（生成新草稿版本）": the row to copy from. `list_skills` carries no `markdown`, so the
   *  body starts empty; and `propose_skill` addresses no family, so the result is a *new* Skill. */
  readonly copyOf?: SkillRow;
  readonly onProposed: (draft: ProposedDraft) => void;
  readonly onDone: () => void;
}

type BodyView = 'edit' | 'preview';

/**
 * components/catalog/SkillEditor (S6-A A2 — docs/console-completion-plan.md §5.3, design doc
 * §6.4 "SKILL.md 形态"): frontmatter fields (name, description, applicable gate kinds /
 * ObjectTypes) plus the Markdown body with an edit / preview toggle. Submit validates against
 * `ProposeSkillContentSchema` (packages/shared/src/skill.ts — the same schema the kernel's
 * `propose_skill` handler parses) and calls `propose_skill{skill}`; the pi publish-time name
 * rule is shown as a warning while drafting. The success state offers `publish_skill`.
 */
export function SkillEditor({ http, copyOf, onProposed, onDone }: SkillEditorProps) {
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

  function update<K extends keyof SkillForm>(key: K, value: SkillForm[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const validated = validateSkill(form);
    if (!validated.ok) {
      setErrors(validated.errors);
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
        onPublish={
          permissions.isDenied('publish_skill')
            ? undefined
            : () => http.call<{ status: string }>('publish_skill', { skillId: proposed.id })
        }
        onDone={onDone}
      />
    );
  }

  const nameWarning = skillNamePublishWarning(form.name);

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="skill-editor"
    >
      {copyOf ? (
        <Notice tone="warn" testId="skill-copy-notice">
          从 <strong>{copyOf.name}</strong> v{copyOf.version} 复制：内核的 propose_skill 不接受
          skillId，提交会创建一个<strong>新的</strong> Skill（新 id、v1），不是同一 Skill
          的新版本；list_skills 不返回正文，正文需重新填写。 Copied from {copyOf.name} v
          {copyOf.version}: propose_skill takes no skillId, so submitting creates a{' '}
          <strong>new</strong> Skill (new id, v1), not a new version of this one; list_skills
          carries no body, so the Markdown must be re-entered.
        </Notice>
      ) : (
        <Notice testId="skill-private-notice">
          草稿只有你（提议者）可见，发布后所有成员可见（I16）。 The draft is private to you until
          published (I16).
        </Notice>
      )}

      <Field
        id="skill-name"
        label="名称 name"
        required
        error={errors.name || null}
        hint={
          nameWarning ??
          '将成为 SKILL.md 的 frontmatter name 与挂载目录名。 Becomes the SKILL.md frontmatter name and the mount directory.'
        }
      >
        <Input
          id="skill-name"
          value={form.name}
          onChange={(event) => update('name', event.target.value)}
          disabled={busy}
          mono
          invalid={!!errors.name}
          aria-describedby={describedBy('skill-name', !errors.name, !!errors.name)}
        />
      </Field>
      <Field
        id="skill-description"
        label="描述 description"
        required
        error={errors.description || null}
        hint="一句话说明何时用它（≤ 1024 字）。 One line on when to use it (≤ 1024 chars)."
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
      <div className="row-wrap">
        <Field
          id="skill-gate-kinds"
          label="适用的门类型 applicable.gateKinds"
          hint="逗号或换行分隔，可空。 Comma / newline separated; optional."
          error={errors['applicable.gateKinds'] || null}
        >
          <Input
            id="skill-gate-kinds"
            value={form.gateKinds}
            onChange={(event) => update('gateKinds', event.target.value)}
            disabled={busy}
            mono
            placeholder="http, ssh"
          />
        </Field>
        <Field
          id="skill-object-types"
          label="适用的对象类型 applicable.objectTypes"
          hint="逗号或换行分隔，可空。 Comma / newline separated; optional."
          error={errors['applicable.objectTypes'] || null}
        >
          <Input
            id="skill-object-types"
            value={form.objectTypes}
            onChange={(event) => update('objectTypes', event.target.value)}
            disabled={busy}
            mono
            placeholder="Container, Host"
          />
        </Field>
      </div>

      <div className="stack-s">
        <div className="row">
          <span className="section-title grow">正文 Markdown body</span>
          <Tabs<BodyView>
            ariaLabel="Body view"
            value={bodyView}
            onChange={setBodyView}
            options={[
              { value: 'edit', label: '编辑 Edit', testId: 'skill-body-edit' },
              { value: 'preview', label: '预览 Preview', testId: 'skill-body-preview' },
            ]}
          />
        </div>
        {bodyView === 'edit' ? (
          <Field
            id="skill-markdown"
            label="SKILL.md 正文（不含 frontmatter） Body only — the frontmatter is generated from the fields above"
            required
            error={errors.markdown || null}
          >
            <Textarea
              id="skill-markdown"
              value={form.markdown}
              onChange={(event) => update('markdown', event.target.value)}
              rows={14}
              mono
              disabled={busy}
              invalid={!!errors.markdown}
              spellCheck={false}
              aria-describedby={describedBy('skill-markdown', false, !!errors.markdown)}
            />
          </Field>
        ) : (
          <MarkdownPreview markdown={form.markdown} testId="skill-markdown-preview" />
        )}
      </div>

      {error !== null ? (
        <ErrorBanner
          error={error}
          title="无法创建草稿 Could not propose the draft"
          testId="skill-editor-error"
        />
      ) : null}

      <div className="row">
        <Button type="submit" variant="primary" loading={busy} data-testid="skill-submit">
          保存草稿 Save draft
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          取消 Cancel
        </Button>
      </div>
    </form>
  );
}
