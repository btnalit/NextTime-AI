import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useT } from '../../lib/i18n.js';

export interface CopyButtonProps {
  /** The exact text copied to the clipboard — a secret shown once (an API key, a service Handle
   *  token), not necessarily a short id (see `kit/ref-chip`'s own bundled copy control for that
   *  case — an entity reference always pairs a name/kind label with its id; this primitive is for
   *  a bare value with nothing else to show alongside it). */
  readonly value: string;
  /** What is copied, in the current language — read out as "复制<label>" / "Copy <label>". */
  readonly label: string;
  readonly className?: string;
}

/**
 * components/kit/copy-button (console redesign P3-4 part B): a one-click copy-to-clipboard icon
 * button — the bare-value counterpart of `kit/ref-chip`'s own bundled copy control (that one
 * always renders a kind label + name/id together; a one-time secret has neither, just the value
 * itself). Clipboard access is best-effort (`navigator.clipboard` is unavailable on plain http
 * origins) — failure simply leaves the icon unchanged, same trade-off `kit/ref-chip` accepts.
 */
export function CopyButton({ value, label, className }: CopyButtonProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const name = copied ? t('已复制', 'Copied') : t(`复制${label}`, `Copy ${label}`);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-m text-text-3 hover:bg-surface-3 hover:text-text',
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      aria-label={name}
      title={name}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M5 12.5 9.5 17 19 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M8 8h11v11H8zM5 16V5h11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
