import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * Legacy 680: a WorkerDefinition family holds one pending draft per proposer. Proposing the next
 * version of a definition while the caller's own draft of it is neither published nor discarded is
 * refused (409 `draft_pending`, `details: { familyId, draftVersion }`) — the generic sentence in
 * `platform-errors.ts` is a Skill's (whose publish takes the latest version), so the Worker
 * editor and the entry template notice say this one instead. A draft is edited by replacing it
 * (`propose_worker_definition{replacesDraft}`); when the draft named is no longer the caller's
 * pending one, 409 `draft_changed` with the same `details`.
 */

/** The draft a 409 `code` names (`draft_pending`: the caller's pending one; `draft_changed`: the
 *  one they meant to replace); `null` for any other error. */
function namedDraftOf(
  err: unknown,
  code: 'draft_pending' | 'draft_changed',
): { readonly id: string; readonly version: number } | null {
  if (!(err instanceof HttpError) || err.code !== code) return null;
  const familyId = err.details?.familyId;
  const draftVersion = err.details?.draftVersion;
  if (typeof familyId !== 'string' || typeof draftVersion !== 'number') return null;
  return { id: familyId, version: draftVersion };
}

/** The caller's pending draft the refusal names; `null` for any other error. */
export function workerDraftPendingOf(
  err: unknown,
): { readonly id: string; readonly version: number } | null {
  return namedDraftOf(err, 'draft_pending');
}

/** `entry`: the entry template notice's draft is "the draft from the template" — there the
 *  template makes the draft, so it cannot replace one. */
export function workerDraftPendingText(err: unknown, t: Translate, entry = false): string {
  const version = workerDraftPendingOf(err)?.version;
  const zh = version === undefined ? '' : ` v${version}`;
  const en = version === undefined ? '' : ` (v${version})`;
  return entry
    ? t(
        `你在入口定义下已经有一份草稿${zh}，还没有发布或丢弃；同一个定义下每人一次只留一份待审草稿，所以没有按模板生成新草稿。先发布或丢弃那份草稿，再来生成。`,
        `You already have a draft${en} of the entry definition, neither published nor discarded; each person keeps one pending draft of a definition at a time, so no draft was made from the template. Publish or discard that draft first, then make one here.`,
      )
    : t(
        `你在这个 Worker 定义下已经有一份草稿${zh}，还没有发布或丢弃；同一个定义下每人一次只留一份待审草稿，所以这次没有提议。可以先去看那份草稿，或者用这次写的内容替换它（那份草稿会被丢弃）。`,
        `You already have a draft${en} of this Worker definition, neither published nor discarded; each person keeps one pending draft of a definition at a time, so nothing was proposed. Look at that draft first, or replace it with what you wrote here (that draft is discarded).`,
      );
}

/** The 409 `draft_changed` of a replace: the draft being edited is not pending any more. */
export function workerDraftChangedText(err: unknown, t: Translate): string {
  const version = namedDraftOf(err, 'draft_changed')?.version;
  const zh = version === undefined ? '' : ` v${version} `;
  const en = version === undefined ? '' : ` (v${version})`;
  return t(
    `你在改的草稿${zh}已经不是待审草稿了（发布了、丢弃了或过期了），所以这次没有保存，也没有丢弃任何东西。关掉编辑器，看一下这个定义现在的版本再改。`,
    `The draft${en} you are editing is no longer pending (published, discarded or expired), so nothing was saved or discarded. Close the editor and look at the definition as it is now before editing again.`,
  );
}
