import { useEffect, useState } from 'react';
import { shortId } from '../../lib/format.js';
import { Button } from './Button.js';

export interface CopyIdProps {
  readonly id: string;
  /** Read out before the id ("Task", "Principal"). */
  readonly label?: string;
  /** Show the full id instead of the 8-character short form. */
  readonly full?: boolean;
}

/**
 * components/ui/CopyId: an id in monospace short form (first 8 characters), full value on hover,
 * one-click copy. Clipboard access is best-effort (`navigator.clipboard` is unavailable on plain
 * http origins); the fallback selects nothing and simply reports failure via the icon staying put.
 */
export function CopyId({ id, label, full = false }: CopyIdProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className={`copy-id${copied ? ' copy-id-copied' : ''}`} title={id}>
      <span className="copy-id-text">{full ? id : shortId(id)}</span>
      <Button
        variant="ghost"
        size="s"
        icon={copied ? 'check' : 'copy'}
        iconOnly
        aria-label={copied ? 'Copied' : `Copy ${label ? `${label} ` : ''}id`}
        onClick={() => void copy()}
      />
    </span>
  );
}
