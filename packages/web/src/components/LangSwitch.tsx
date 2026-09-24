import { type Lang, useLang, useT } from '../lib/i18n.js';

export interface LangSwitchProps {
  readonly className?: string;
}

const OPTIONS: readonly {
  readonly value: Lang;
  readonly label: string;
  readonly testId: string;
}[] = [
  { value: 'zh-CN', label: '中文', testId: 'lang-switch-zh' },
  { value: 'en', label: 'EN', testId: 'lang-switch-en' },
];

/**
 * components/LangSwitch (S8 W1-A9, audit S4/S7): the one language toggle, rendered in the sidebar
 * footer (`SidebarContent`, wide + narrow drawer share this component) and on the account page.
 * Same `.tabs`/`.tab` visual as `ui/Tabs` (e.g. Approvals' Pending/All filter) — but a new
 * `components/kit/*`-era file may not import `components/ui/*` (`scripts/guards/css-tokens.mjs`),
 * and there is no `kit/tabs` yet, so this is a small hand-rolled `role="tablist"` reusing the same
 * classes rather than the `ui/Tabs` component itself.
 */
export function LangSwitch({ className }: LangSwitchProps) {
  const { lang, setLang } = useLang();
  const t = useT();
  return (
    <div className={['lang-switch', className ?? ''].filter(Boolean).join(' ')}>
      <div className="tabs" role="tablist" aria-label={t('界面语言', 'Interface language')}>
        {OPTIONS.map((option) => {
          const selected = option.value === lang;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              className="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setLang(option.value)}
              data-value={option.value}
              data-testid={option.testId}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
