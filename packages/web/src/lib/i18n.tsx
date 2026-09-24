import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * lib/i18n: S8 W1-A9 (audit S4/S7, development-tasks.md §5e F5 "界面语言中文为主，英文收进语言切换").
 *
 * Not a message catalog / key-based i18n library — this app's copy already exists as hand-written
 * "中文 English" pairs at every call site (§5.9-era convention). `t(zh, en)` maps 1:1 onto those
 * existing pairs: it returns exactly one half depending on the current language, so switching to
 * `zh-CN` truly removes the English text from the DOM (not `display:none` — the string is never
 * rendered), which is both the audit S4 fix (doubled bilingual labels are the main cause of 1280/
 * 768 wrapping) and the accessible-name fix (a screen reader in zh-CN mode reads only Chinese). A
 * later extraction from `t()` call sites into a real catalog (pluralization, ICU, etc.) stays
 * mechanical — every call site already carries both strings verbatim.
 *
 * `lang` persists in `localStorage` (a cross-session UI preference, unlike `lib/session.ts`'s
 * sessionStorage-only auth material) and defaults to `zh-CN` — the audit's decided default
 * (index.html already ships `<html lang="zh-CN">`, S7). Every accessor is wrapped in try/catch:
 * `localStorage` throws in some embedded/private-browsing contexts, and failing open to the
 * default language is strictly safer than throwing out of a provider mount.
 */

export type Lang = 'zh-CN' | 'en';

const STORAGE_KEY = 'nexttime.lang';
const DEFAULT_LANG: Lang = 'zh-CN';

function isLang(value: string | null): value is Lang {
  return value === 'zh-CN' || value === 'en';
}

function loadLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLang(stored) ? stored : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Best-effort — see module doc comment.
  }
}

export interface LangContextValue {
  readonly lang: Lang;
  readonly setLang: (lang: Lang) => void;
}

const LangContext = createContext<LangContextValue | null>(null);

/** Same convention as `components/ui/Toast.tsx`'s `NOOP_TOASTS`: a component rendered alone in a
 *  test (no `LangProvider` ancestor) gets the default language instead of a thrown error —
 *  `setLang` is a no-op there, since nothing renders the switch to call it. */
const DEFAULT_LANG_CONTEXT: LangContextValue = { lang: DEFAULT_LANG, setLang: () => undefined };

/** Wraps the whole app (`main.tsx`) so the language choice reaches pre-session pages
 *  (LoginPage/SetupPage/ChangePasswordPage) exactly the same as the signed-in shell. */
export function LangProvider({ children }: { readonly children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(loadLang);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    saveLang(next);
  }, []);

  const value = useMemo<LangContextValue>(() => ({ lang, setLang }), [lang, setLang]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

/** The raw `{lang, setLang}` pair — for the language switch itself and any component that needs
 *  to branch on `lang` beyond a simple `t(zh, en)` pick. Falls back to the default language
 *  outside a `LangProvider` (see `DEFAULT_LANG_CONTEXT`) rather than throwing. */
export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  return ctx ?? DEFAULT_LANG_CONTEXT;
}

/** The type `useT()` returns — for a non-component helper that needs to pick a language but
 *  cannot call the hook itself (it takes `t` as a parameter from its component caller instead). */
export type Translate = <T>(zh: T, en: T) => T;

/** `t(zh, en)` — picks the half matching the current language. Generic over `T` rather than fixed
 *  to `string` so the same function also picks between two `ReactNode`s (e.g. an icon + JSX
 *  fragment) without a separate `t.node(...)` variant. */
export function useT(): Translate {
  const { lang } = useLang();
  return useCallback(<T,>(zh: T, en: T): T => (lang === 'zh-CN' ? zh : en), [lang]);
}
