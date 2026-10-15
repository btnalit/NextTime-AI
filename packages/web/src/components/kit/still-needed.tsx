import { useT } from '../../lib/i18n.js';

export interface StillNeededProps {
  /** What the button still waits for, in the field labels' own words (「填写登录名」, 「选择工作区」).
   *  Empty (and no `reason`) renders nothing. */
  readonly items?: readonly string[];
  /** A single sentence for a button that is grey for a reason that is not a missing field
   *  (「没有可回滚的上一个镜像」). Shown as is, after `items` when both are given. */
  readonly reason?: string | null;
  /** Hide while the action runs: the button's own spinner says what is happening then. */
  readonly hidden?: boolean;
  readonly testId?: string;
}

/**
 * components/kit/still-needed (console usability DoD item 4, `docs/console-usability-dod.md`): the
 * line next to a disabled button that says why it is grey — 「还差：填写登录名、选择角色」 — so a
 * reader never has to guess what a form still wants. `scripts/guards/disabled-reason.mjs` requires
 * one of these near every button whose `disabled` depends on the form's content, and the e2e
 * `expectDisabledExplained` (`e2e/lib/ux-lint.ts`) checks the rendered page finds it.
 */
export function StillNeeded({ items = [], reason, hidden = false, testId }: StillNeededProps) {
  const t = useT();
  if (hidden || (items.length === 0 && !reason)) return null;
  const list =
    items.length > 0 ? t(`还差：${items.join('、')}`, `Still needed: ${items.join(', ')}`) : '';
  return (
    <span className="text-small text-3" data-still-needed="" data-testid={testId}>
      {[list, reason ?? ''].filter(Boolean).join(t('；', '; '))}
    </span>
  );
}
