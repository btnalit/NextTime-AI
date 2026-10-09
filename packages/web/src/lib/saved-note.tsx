import { useT } from './i18n.js';

/** Inline "已保存" confirmation next to a save button. The owner clears it on the next edit. */
export function SavedNote({ testId }: { readonly testId?: string }) {
  const t = useT();
  return (
    <output className="text-3" data-testid={testId}>
      {t('✓ 已保存', '✓ Saved')}
    </output>
  );
}
