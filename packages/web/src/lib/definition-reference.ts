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
  const many = values.length > 1;
  switch (field) {
    case 'model':
      return t(
        `${named}不在模型目录里，Worker 用它跑不起来。换一个目录里有的模型，或留空使用工作区默认模型。`,
        `${named} is not in the model catalog, so a Worker cannot run on it. Choose a model the catalog offers, or leave it empty for the workspace default.`,
      );
    case 'capabilities':
      return t(
        `${named}不是 Worker 能持有的能力（不存在，或超出 Worker 的能力上限），运行时会被丢掉。取消勾选即可。`,
        many
          ? `${named} are not capabilities a Worker can hold (they do not exist, or are beyond the Worker ceiling), so a run would drop them. Uncheck them.`
          : `${named} is not a capability a Worker can hold (it does not exist, or is beyond the Worker ceiling), so a run would drop it. Uncheck it.`,
      );
    case 'gates':
      return t(
        `这个工作区没有${named}${many ? '这些门' : '这个门'}，Worker 拿${many ? '它们' : '它'}作用不到任何系统。取消勾选，换成工作区已接入的系统。`,
        many
          ? `This workspace has no gates ${named}, so a Worker could act on nothing through them. Uncheck them and choose systems the workspace has connected.`
          : `This workspace has no gate ${named}, so a Worker could act on nothing through it. Uncheck it and choose a system the workspace has connected.`,
      );
    case 'skills':
      // A deprecated Skill has no draft to publish: "give it a published version" covers it too.
      return t(
        `${named}没有已发布的版本（不存在、还是草稿，或已弃用），Worker 装不上。取消勾选；要用${many ? '它们' : '它'}，先在 Skill 页让${many ? '它们' : '它'}有一个已发布的版本。`,
        many
          ? `${named} have no published version (they do not exist, are still drafts, or were deprecated), so a Worker cannot mount them. Uncheck them; to use them, first give each a published version on the Skills tab.`
          : `${named} has no published version (it does not exist, is still a draft, or was deprecated), so a Worker cannot mount it. Uncheck it; to use it, first give it a published version on the Skills tab.`,
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

/** What a pack install that met the refusal can do about each field: the pack's Worker keeps the
 *  workspace's own gates and model from the version before it, and mounts Skills by name — so
 *  what is missing is the workspace's, fixed where it lives, not by proposing a version. */
function packInstallFieldText(
  field: DefinitionReferenceField,
  values: readonly string[],
  t: Translate,
): string {
  const named = listed(values, t);
  const many = values.length > 1;
  switch (field) {
    case 'skills':
      return t(
        `${named}没有已发布的版本（可能在 Skill 页被弃用了）。先在 Skill 页让${many ? '它们' : '它'}有一个已发布的版本，再来安装。`,
        many
          ? `${named} have no published version (they may have been deprecated on the Skills tab). Give each a published version there first, then install again.`
          : `${named} has no published version (it may have been deprecated on the Skills tab). Give it a published version there first, then install again.`,
      );
    case 'gates':
      return t(
        `这个工作区没有${named}${many ? '这些门' : '这个门'}，Worker 沿用了${many ? '它们' : '它'}。先在 Worker 页把${many ? '它们' : '它'}从这个 Worker 里去掉（改一版并发布），再来安装。`,
        many
          ? `This workspace has no gates ${named}, which the Worker keeps from its current version. Remove them from that Worker on the Workers tab (a new version, published) first, then install again.`
          : `This workspace has no gate ${named}, which the Worker keeps from its current version. Remove it from that Worker on the Workers tab (a new version, published) first, then install again.`,
      );
    case 'model':
      return t(
        `${named}不在模型目录里，Worker 沿用了它。先在 Worker 页给这个 Worker 换一个目录里有的模型，再来安装。`,
        `${named} is not in the model catalog, and the Worker keeps it from its current version. Choose a model the catalog offers for that Worker on the Workers tab first, then install again.`,
      );
    case 'capabilities':
      return t(
        `${named}不是 Worker 能持有的能力，这是能力包本身的问题，请联系它的维护者。`,
        many
          ? `${named} are not capabilities a Worker can hold; the pack itself is at fault, so tell whoever maintains it.`
          : `${named} is not a capability a Worker can hold; the pack itself is at fault, so tell whoever maintains it.`,
      );
  }
}

/** The refusal as an install of a capability pack meets it: the whole install was rolled back,
 *  each field with what to fix in the workspace before installing again. */
export function packInstallReferenceText(
  refusal: DefinitionReferenceRefusal,
  t: Translate,
): string {
  const parts = DEFINITION_REFERENCE_FIELDS.flatMap((field) => {
    const values = refusal[field];
    return values && values.length > 0
      ? [
          `${definitionReferenceFieldLabel(field, t)}${t('：', ': ')}${packInstallFieldText(field, values, t)}`,
        ]
      : [];
  });
  return `${t(
    '这个能力包要发布的 Worker 引用了工作区里现在没有的东西，所以整次安装都没有写入。',
    'A Worker this pack publishes names what the workspace does not have now, so nothing of the install was written.',
  )} ${parts.join(' ')}`;
}
