import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * Legacy 680: a WorkerDefinition family holds one pending draft per proposer. Proposing the next
 * version of a definition while the caller's own draft of it is neither published nor discarded is
 * refused (409 `draft_pending`, `details: { familyId, draftVersion }`) — the generic sentence in
 * `platform-errors.ts` is a Skill's (whose publish takes the latest version), so the Worker
 * editor and the entry template notice say this one instead.
 */

/** The caller's pending draft the refusal names; `null` for any other error. */
export function workerDraftPendingOf(
  err: unknown,
): { readonly id: string; readonly version: number } | null {
  if (!(err instanceof HttpError) || err.code !== 'draft_pending') return null;
  const familyId = err.details?.familyId;
  const draftVersion = err.details?.draftVersion;
  if (typeof familyId !== 'string' || typeof draftVersion !== 'number') return null;
  return { id: familyId, version: draftVersion };
}

/** `entry`: the entry template notice's draft is "the draft from the template". */
export function workerDraftPendingText(err: unknown, t: Translate, entry = false): string {
  const version = workerDraftPendingOf(err)?.version;
  const named = version === undefined ? '' : ` v${version}`;
  return entry
    ? t(
        `你在入口定义下已经有一份草稿${named}，还没有发布或丢弃；同一个定义下每人一次只留一份待审草稿，所以没有按模板生成新草稿。先发布或丢弃那份草稿，再来生成。`,
        `You already have a draft of the entry definition${named}, neither published nor discarded; each person keeps one pending draft of a definition at a time, so no draft was made from the template. Publish or discard that draft first, then make one here.`,
      )
    : t(
        `你在这个 Worker 定义下已经有一份草稿${named}，还没有发布或丢弃；同一个定义下每人一次只留一份待审草稿，所以这次没有提议。先发布或丢弃那份草稿，再提议新版本。`,
        `You already have a draft of this Worker definition${named}, neither published nor discarded; each person keeps one pending draft of a definition at a time, so nothing was proposed. Publish or discard that draft first, then propose the new version.`,
      );
}
