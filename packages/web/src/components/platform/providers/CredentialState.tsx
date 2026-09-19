import type { LlmProviderWire } from '@nexttime/shared';

export interface CredentialStateProps {
  readonly provider: Pick<LlmProviderWire, 'credentialPresent' | 'apiKeyEnv'>;
  /** Long form: the chip plus the operator instruction (drawer); short form: the chip only. */
  readonly withInstruction?: boolean;
}

/**
 * components/platform/providers/CredentialState: the honest credential state (S6-B, plan §5.4
 * "密钥只写不读" — and, until the maintainer decides on approval for console key writes (plan §12
 * 末), not even written here). The proxy reports `credentialPresent: boolean` for the env var
 * named by `apiKeyEnv`; the value never reaches any wire. The instruction is the operator step
 * that actually installs a key: `secrets/llm-proxy.env` on the host + recreate `llm-proxy`.
 */
export function CredentialState({ provider, withInstruction = false }: CredentialStateProps) {
  const present = provider.credentialPresent;
  return (
    <div className="stack-s">
      <span
        className={`chip chip-s ${present ? 'chip-ok' : 'chip-warn'}`}
        data-testid="provider-credential"
        data-status={present ? 'present' : 'missing'}
        title={provider.apiKeyEnv}
      >
        {present ? '凭证：已配置 Credential set' : `凭证：待操作员配置 ${provider.apiKeyEnv}`}
      </span>
      {withInstruction ? (
        <p className="text-small text-2" data-testid="provider-credential-instruction">
          {present
            ? `密钥来自 llm-proxy 容器环境变量 ${provider.apiKeyEnv}（主机 secrets/llm-proxy.env）。控制台不显示、也不写入密钥。 The key is read from the llm-proxy container env var ${provider.apiKeyEnv} (secrets/llm-proxy.env on the host); the console never shows or writes it.`
            : `操作员步骤：在主机 secrets/llm-proxy.env 里加一行 ${provider.apiKeyEnv}=<密钥>，然后 docker compose up -d --force-recreate llm-proxy。控制台写入密钥的入口待维护者决定（是否必经审批），目前为 501 占位。 Operator step: add ${provider.apiKeyEnv}=<key> to secrets/llm-proxy.env on the host, then docker compose up -d --force-recreate llm-proxy. The console key-entry route is a 501 stub pending the maintainer decision on approval.`}
        </p>
      ) : null}
    </div>
  );
}
