import { useState } from 'react';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * lib/credential-review: the console side of decision 2026-10-09 "二次确认". The kernel counts
 * the suspected credential values in what an `approve` / `publish_*` makes take effect
 * (kernel governance/redaction/credential-review.ts — the same detector that scrubs agent output)
 * and refuses the call without `credentialsReviewed: true` (400 `credentials_review_required`,
 * `details.suspectedSecretValues`). The console never counts on its own: it shows the kernel's
 * count — from the wire row (`suspectedSecretValues`) when it has one, else from that 400.
 */
export const CREDENTIALS_REVIEW_REQUIRED = 'credentials_review_required';

/** The count a refused call carried, or `null` when `err` is not that refusal. */
export function credentialReviewCount(err: unknown): number | null {
  if (!(err instanceof HttpError) || err.code !== CREDENTIALS_REVIEW_REQUIRED) return null;
  const count = err.details?.suspectedSecretValues;
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 1;
}

/** The field paths a refused call named (`details.suspectedSecretPaths`) — empty when `err` is not
 *  that refusal or the kernel named none. */
export function credentialReviewPaths(err: unknown): readonly string[] {
  if (credentialReviewCount(err) === null) return [];
  const paths = (err as HttpError).details?.suspectedSecretPaths;
  return Array.isArray(paths)
    ? paths.filter((path): path is string => typeof path === 'string')
    : [];
}

/** The params field a confirmed call adds — nothing when there was nothing to confirm, so an
 *  ordinary call's params are unchanged. */
export function credentialReviewParams(confirmed: boolean): { credentialsReviewed?: true } {
  return confirmed ? { credentialsReviewed: true } : {};
}

export interface PublishCredentialReview {
  /** The kernel's count for the current subject — 0 until a publish of it was refused. */
  readonly count: number;
  /** Where the kernel found them (field paths), from the same refusal. */
  readonly paths: readonly string[];
  readonly checked: boolean;
  /** The question is open and unanswered: keep Publish disabled. */
  readonly blocked: boolean;
  readonly setChecked: (checked: boolean) => void;
  /** The params a publish of the current subject adds. */
  readonly params: () => { credentialsReviewed?: true };
  /** After a failed publish: `true` when `err` was the kernel's refusal — the question is now
   *  open (render `components/kit/credential-review`), so the caller shows no error of its own. */
  readonly capture: (err: unknown) => boolean;
}

/**
 * `publish_*` call sites: the console learns N only from the kernel's refusal (a draft row
 * carries no count), so the confirmation is reactive — the first Publish is refused, the question
 * appears next to the button with Publish disabled, and the second Publish carries the
 * confirmation. `subjectKey` names what is being published (a draft's id); selecting another
 * subject closes the question, so a tick never carries over to content the person did not check.
 */
export function usePublishCredentialReview(subjectKey: string | null): PublishCredentialReview {
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly count: number;
    readonly paths: readonly string[];
    readonly checked: boolean;
  }>({ key: null, count: 0, paths: [], checked: false });
  const current = subjectKey !== null && state.key === subjectKey;
  const count = current ? state.count : 0;
  const checked = current && state.checked;
  return {
    count,
    paths: current ? state.paths : [],
    checked,
    blocked: count > 0 && !checked,
    setChecked: (next) =>
      setState((prev) => (prev.key === subjectKey ? { ...prev, checked: next } : prev)),
    params: () => credentialReviewParams(count > 0 && checked),
    capture: (err) => {
      const refused = credentialReviewCount(err);
      if (refused === null) return false;
      setState({
        key: subjectKey,
        count: refused,
        paths: credentialReviewPaths(err),
        checked: false,
      });
      return true;
    },
  };
}

/** The console's names for the top-level fields of a draft's reviewed content (the kernel's
 *  `skillReviewContent` / `procedureReviewContent`), so a flagged path reads as the editor's own
 *  label (`markdown` → 正文). */
export function reviewFieldNames(
  kind: 'skill' | 'procedure',
  t: Translate,
): Readonly<Record<string, string>> {
  const common = { name: t('名称', 'Name'), description: t('描述', 'Description') };
  return kind === 'skill'
    ? { ...common, markdown: t('正文', 'Markdown body'), applicable: t('适用范围', 'Applies to') }
    : { ...common, steps: t('步骤', 'Steps') };
}

/** `path` with its first segment shown under its console name, when `names` has one:
 *  `markdown` → `正文`, `steps[1].run` → `步骤[1].run`. */
export function namedReviewPath(path: string, names?: Readonly<Record<string, string>>): string {
  if (names === undefined) return path;
  const end = path.search(/[.[]/);
  const head = end === -1 ? path : path.slice(0, end);
  const named = Object.hasOwn(names, head) ? names[head] : undefined;
  return named === undefined ? path : `${named}${end === -1 ? '' : path.slice(end)}`;
}
