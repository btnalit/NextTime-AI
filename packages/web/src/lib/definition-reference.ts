import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * Legacy 302: `publish_worker_definition`'s 400 `unresolved_references` — the version names what
 * is not there, so it was not published. The kernel's `details.unresolved` holds each field's
 * values that do not resolve (`application/worker/definition-references.ts`): capabilities a
 * Worker can never hold, gates this workspace has no Gatekeeper for, Skills with no published
 * version, a model the model catalog does not offer. Read here as that, field by field, so the
 * console marks the field it belongs to (the catalog's draft detail, the editor opened from it)
 * instead of one sentence for every case.
 */

/** The definition fields a refusal names, in the order the editor shows them. */
export const DEFINITION_REFERENCE_FIELDS = ['model', 'capabilities', 'gates', 'skills'] as const;
export type DefinitionReferenceField = (typeof DEFINITION_REFERENCE_FIELDS)[number];

/** Each field's values that do not resolve, as the definition writes them; a field with none is
 *  absent. Never empty: a refusal names at least one. */
export type DefinitionReferenceRefusal = Readonly<
  Partial<Record<DefinitionReferenceField, readonly string[]>>
>;

export function definitionReferenceRefusalOf(err: unknown): DefinitionReferenceRefusal | null {
  if (!(err instanceof HttpError) || err.code !== 'unresolved_references') return null;
  const unresolved = err.details?.unresolved;
  if (typeof unresolved !== 'object' || unresolved === null || Array.isArray(unresolved)) {
    return null;
  }
  const refusal: Partial<Record<DefinitionReferenceField, readonly string[]>> = {};
  for (const field of DEFINITION_REFERENCE_FIELDS) {
    const values = (unresolved as Record<string, unknown>)[field];
    if (!Array.isArray(values)) continue;
    const strings = values.filter((value): value is string => typeof value === 'string');
    if (strings.length > 0) refusal[field] = strings;
  }
  return Object.keys(refusal).length > 0 ? refusal : null;
}

/** The field's name as the Worker editor labels it. */
export function definitionReferenceFieldLabel(
  field: DefinitionReferenceField,
  t: Translate,
): string {
  switch (field) {
    case 'model':
      return t('模型', 'Model');
    case 'capabilities':
      return t('能力', 'Capabilities');
    case 'gates':
      return t('可作用的门', 'Gates it acts on');
    case 'skills':
      return t('使用的 Skill', 'Skills it uses');
  }
}

function listed(values: readonly string[], t: Translate): string {
  return values.map((value) => t(`「${value}」`, `“${value}”`)).join(t('、', ', '));
}

/** What is wrong with the field's values and what to do — said of the field, so it reads under
 *  it (the editor) or after its label (the draft detail). */
export function definitionReferenceFieldText(
  field: DefinitionReferenceField,
  values: readonly string[],
  t: Translate,
): string {
  const named = listed(values, t);
  switch (field) {
    case 'model':
      return t(
        `${named} 不在模型目录里，Worker 用它跑不起来。换一个目录里有的模型，或留空使用工作区默认模型。`,
        `${named} is not in the model catalog, so a Worker cannot run on it. Choose a model the catalog offers, or leave it empty for the workspace default.`,
      );
    case 'capabilities':
      return t(
        `${named} 不是 Worker 能持有的能力（不存在，或超出 Worker 的能力上限），运行时会被丢掉。取消勾选它们。`,
        `${named} is not a capability a Worker can hold (it does not exist, or is beyond the Worker ceiling), so a run would drop it. Uncheck it.`,
      );
    case 'gates':
      return t(
        `这个工作区没有 ${named} 这个门，Worker 拿它作用不到任何系统。取消勾选，换成工作区已接入的系统。`,
        `This workspace has no gate ${named}, so a Worker could act on nothing through it. Uncheck it and choose a system the workspace has connected.`,
      );
    case 'skills':
      return t(
        `${named} 没有已发布的版本（不存在、还是草稿，或已弃用），Worker 装不上它。取消勾选，或先到 Skill 页发布它。`,
        `${named} has no published version (it does not exist, is still a draft, or was deprecated), so a Worker cannot mount it. Uncheck it, or publish it on the Skills tab first.`,
      );
  }
}

/** The whole refusal in one paragraph, every field named, for a place that shows no fields (a
 *  toast, a banner). */
export function definitionReferenceText(refusal: DefinitionReferenceRefusal, t: Translate): string {
  const parts = DEFINITION_REFERENCE_FIELDS.flatMap((field) => {
    const values = refusal[field];
    return values && values.length > 0
      ? [
          `${definitionReferenceFieldLabel(field, t)}${t('：', ': ')}${definitionReferenceFieldText(field, values, t)}`,
        ]
      : [];
  });
  return `${t(
    '这份 Worker 定义引用了不存在的东西，所以没有发布。按它改一版再发布：',
    'This Worker definition names what is not there, so it was not published. Propose a fixed version, then publish that:',
  )} ${parts.join(' ')}`;
}
