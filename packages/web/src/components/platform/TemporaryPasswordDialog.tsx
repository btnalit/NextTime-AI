import { useEffect, useState } from 'react';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { Notice } from '../ui/Notice.js';

export interface TemporaryPasswordDialogProps {
  readonly login: string;
  readonly password: string;
  /** Acknowledged / dismissed — the caller drops the password from its own state here. */
  readonly onClose: () => void;
}

/**
 * components/platform/TemporaryPasswordDialog: the one-time temporary password `create_user` and
 * `reset_user_password` return (P-A1; both capabilities carry `redactedParamKeys: ['password']`
 * and the kernel never stores the plaintext, so this dialog is the only place it ever exists).
 * Shown in a `Drawer` — the console's one dialog primitive (`role="dialog"`, focus trap, Esc) —
 * exactly like `CreatePrincipalForm`'s one-time API key, and never rendered while another panel
 * is open (`PlatformUsersPage`'s single-panel state union), so the two focus traps can never
 * fight. Closing it is irreversible from the console's side: the admin must reset again.
 */
export function TemporaryPasswordDialog({
  login,
  password,
  onClose,
}: TemporaryPasswordDialogProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // Best-effort — `navigator.clipboard` is unavailable on plain-http origins (same stance as
      // `components/ui/CopyId.tsx`); the password is selectable on screen either way.
      setCopied(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="临时密码 Temporary password"
      subtitle={<span className="mono">{login}</span>}
      testId="temporary-password-dialog"
    >
      <div className="stack">
        <Notice tone="warn">
          只显示这一次，关闭后无法再看到；对方首次登录时必须修改。 Shown once — copy it now and hand
          it over; the console never displays it again and the user must change it on first login.
        </Notice>
        <div className="code-block row" style={{ justifyContent: 'space-between' }}>
          <span className="mono" data-testid="temporary-password-value">
            {password}
          </span>
          <Button
            variant="secondary"
            size="s"
            icon={copied ? 'check' : 'copy'}
            onClick={() => void copy()}
          >
            {copied ? '已复制 Copied' : '复制 Copy'}
          </Button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={onClose}>
            我已保存 I have saved it
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
