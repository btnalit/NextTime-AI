import { useT } from '../../lib/i18n.js';
import { CopyButton } from '../kit/copy-button.js';
import { Notice } from '../kit/notice.js';

export interface ConnectionSecretRevealProps {
  /** The connection secret, exactly as the kernel returned it. */
  readonly secret: string;
  readonly testId?: string;
}

/**
 * components/connect/ConnectionSecretReveal (R-01, maintainer decision D-01): a self-connected
 * gate's own connection secret, shown once with a copy control — the one copy the decision accepts
 * when connecting a gate a workspace runs itself. The platform gate token never goes to such a gate;
 * the owner puts this value in the gate's `GATE_KERNEL_TOKEN_FILE` and (re)starts it. Rendered by
 * the 直接注册门 form (`mint_connection_secret`, before the gate is first called) and after
 * `rotate_connection_secret` (系统与授权 → ⋯). The value lives only in the caller's component state;
 * the console never reads it back from the kernel.
 */
export function ConnectionSecretReveal({ secret, testId }: ConnectionSecretRevealProps) {
  const t = useT();
  return (
    <div className="stack-s" data-testid={testId}>
      <Notice tone="warn">
        {t(
          '这把连接密钥只显示一次：写进这个门的 GATE_KERNEL_TOKEN_FILE 指向的文件并重启门。内核只用它调用这个门，不会再给门平台密钥。',
          'This connection secret is shown once. Put it in the file the gate’s GATE_KERNEL_TOKEN_FILE points at and restart the gate — the kernel calls this gate with it, never with the platform token.',
        )}
      </Notice>
      <div className="code-block row" style={{ justifyContent: 'space-between' }}>
        <span className="mono pre-wrap" data-testid="connection-secret-value">
          {secret}
        </span>
        <CopyButton value={secret} label="connection secret" />
      </div>
    </div>
  );
}
