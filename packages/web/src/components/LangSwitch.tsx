import { type Lang, useLang, useT } from '../lib/i18n.js';
import { Tabs } from './ui/Tabs.js';

export interface LangSwitchProps {
  readonly className?: string;
}

/**
 * components/LangSwitch (S8 W1-A9, audit S4/S7): the one language toggle, rendered in the sidebar
 * footer (`SidebarContent`, wide + narrow drawer share this component) and on the account page.
 * Reuses `ui/Tabs` (already the segmented-control pattern, e.g. Approvals' Pending/All filter)
 * rather than a bespoke control — two options, no new visual vocabulary.
 */
export function LangSwitch({ className }: LangSwitchProps) {
  const { lang, setLang } = useLang();
  const t = useT();
  return (
    <div className={['lang-switch', className ?? ''].filter(Boolean).join(' ')}>
      <Tabs<Lang>
        ariaLabel={t('界面语言', 'Interface language')}
        value={lang}
        onChange={setLang}
        options={[
          { value: 'zh-CN', label: '中文', testId: 'lang-switch-zh' },
          { value: 'en', label: 'EN', testId: 'lang-switch-en' },
        ]}
      />
    </div>
  );
}
