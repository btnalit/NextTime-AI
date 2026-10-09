import type { LlmProviderWire } from '@nexttime/shared';
import { type Translate, useT } from '../../../lib/i18n.js';

export interface CredentialStateProps {
  readonly provider: Pick<
    LlmProviderWire,
    'credentialPresent' | 'credentialSource' | 'apiKeyEnv' | 'credentialInvalid'
  >;
  /** Long form: the chip plus an explanation of where the key comes from (drawer); short form:
   *  the chip only. */
  readonly withInstruction?: boolean;
}

function chipLabel(provider: CredentialStateProps['provider'], t: Translate): string {
  if (provider.credentialInvalid) {
    return t('密钥含非法字符，请重新填写', 'Key has invalid characters — re-enter it');
  }
  switch (provider.credentialSource) {
    case 'console':
      return t('凭证：控制台', 'Credential: console');
    case 'env':
      return t(`凭证：环境变量 ${provider.apiKeyEnv}`, `Credential: env var ${provider.apiKeyEnv}`);
    case 'none':
      return provider.apiKeyEnv
        ? t(`凭证：待配置 ${provider.apiKeyEnv}`, `Credential: not set ${provider.apiKeyEnv}`)
        : t('凭证：待配置', 'Credential: not set');
  }
}

/**
 * components/platform/providers/CredentialState: the honest credential state (S6-B plan §5.4
 * "密钥只写不读"; S7-A docs/STATUS.md 维护者决定 2026-09-22 ①). The proxy reports
 * `credentialPresent: boolean` and `credentialSource: 'console' | 'env' | 'none'` — the value
 * itself never reaches any wire. `console` means a key was set through
 * `ProviderSecretForm`/`PUT .../secret`; `env` means the container's own `apiKeyEnv` var is set
 * (`secrets/llm-proxy.env` on the host); `none` means neither.
 */
export function CredentialState({ provider, withInstruction = false }: CredentialStateProps) {
  const t = useT();
  const { credentialSource } = provider;
  const present = provider.credentialPresent;
  // The proxy found a key but it cannot go in a header, so every call with it fails
  // (llm-proxy `upstream_key_invalid`): shown as a problem, not as a working credential.
  const invalid = provider.credentialInvalid === true;
  return (
    <div className="stack-s">
      <span
        className={`chip chip-s ${present && !invalid ? 'chip-ok' : 'chip-warn'}`}
        data-testid="provider-credential"
        data-status={invalid ? 'invalid' : present ? 'present' : 'missing'}
        data-source={credentialSource}
        title={provider.apiKeyEnv ?? undefined}
      >
        {chipLabel(provider, t)}
      </span>
      {withInstruction && invalid ? (
        <p className="text-small text-danger" data-testid="provider-credential-invalid">
          {credentialSource === 'console'
            ? t(
                '已存的控制台密钥里有空格、全角字符或换行，无法发给供应商，所有调用都会失败。请在下方重新填写。',
                'The stored console key contains a space, a full-width character or a line break, so it cannot be sent and every call fails. Re-enter it below.',
              )
            : t(
                `环境变量 / 密钥文件 ${provider.apiKeyEnv} 里的密钥有空格、全角字符或换行，所有调用都会失败。可在下方设置控制台密钥（优先），或由操作员修正该文件后重建 llm-proxy。`,
                `The key in env var / key file ${provider.apiKeyEnv} contains a space, a full-width character or a line break, so every call fails. Set a console key below (it takes priority), or have the operator fix that file and recreate llm-proxy.`,
              )}
        </p>
      ) : null}
      {withInstruction ? (
        <p className="text-small text-2" data-testid="provider-credential-instruction">
          {credentialSource === 'console'
            ? t(
                '密钥由管理员在下方设置，存于代理自己的状态目录（keys.json），从不回显。',
                'Set below by an administrator, held in the proxy’s own state directory (keys.json); never echoed back.',
              )
            : credentialSource === 'env'
              ? t(
                  `密钥来自 llm-proxy 容器环境变量 ${provider.apiKeyEnv}（主机 secrets/llm-proxy.env）。也可以在下方为这个供应商单独设置控制台密钥，控制台密钥优先。`,
                  `The key is read from the llm-proxy container env var ${provider.apiKeyEnv} (secrets/llm-proxy.env on the host). A console key set below takes priority over it.`,
                )
              : provider.apiKeyEnv
                ? t(
                    `尚未配置：可在下方设置控制台密钥，或由操作员在主机 secrets/llm-proxy.env 里加一行 ${provider.apiKeyEnv}=<密钥> 后重建 llm-proxy。`,
                    `Not configured yet — set a console key below, or have the operator add ${provider.apiKeyEnv}=<key> to secrets/llm-proxy.env and recreate llm-proxy.`,
                  )
                : t(
                    '尚未配置：可在下方设置控制台密钥（这个供应商没有配置环境变量名）。',
                    'Not configured yet — set a console key below (this provider has no env var name configured).',
                  )}
        </p>
      ) : null}
    </div>
  );
}
