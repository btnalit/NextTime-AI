import {
  type LlmProviderTestResultWire,
  type LlmProviderWire,
  type ProviderHealthStatus,
  type ProviderHealthUsability,
  providerHealth,
  providerHealthUsability,
} from '@nexttime/shared';

/**
 * lib/provider-status: how the console names a provider's health — the providers table's 状态
 * column (admins) and the marker next to a model in every model picker (members; console audit
 * P0-2). The rule itself is `@nexttime/shared`'s `providerHealth` (its doc comment lists the kinds
 * and their order); llm-proxy applies the same rule when it writes the health the kernel's model
 * projection carries, so the table and the pickers cannot disagree.
 *
 * Not knowable anywhere: whether every listed model works (`/model-probe` results are not stored —
 * only the last test's one model is), and an upstream that broke since the last test.
 */
export type ProviderStatusKind = ProviderHealthStatus | 'unknown';

export interface ProviderStatus {
  readonly kind: ProviderStatusKind;
  readonly tone: 'ok' | 'warn' | 'danger' | 'neutral';
  readonly usability: ProviderHealthUsability;
  /** The chip's short label — short enough for the pinned column in both languages. */
  readonly zh: string;
  readonly en: string;
  /** What the short label stands for (the chip's tooltip, a picker option's note). */
  readonly detailZh: string;
  readonly detailEn: string;
}

const STATUS: Readonly<Record<ProviderStatusKind, Omit<ProviderStatus, 'kind' | 'usability'>>> = {
  disabled: {
    tone: 'neutral',
    zh: '已停用',
    en: 'Disabled',
    detailZh: '供应商已停用，不会转发任何调用',
    detailEn: 'The provider is switched off; no call is forwarded',
  },
  key_invalid: {
    tone: 'danger',
    zh: '密钥无效',
    en: 'Key invalid',
    detailZh: '密钥含非法字符，每次调用都会失败',
    detailEn: 'The key holds characters a header cannot carry; every call fails',
  },
  key_missing: {
    tone: 'danger',
    zh: '缺少密钥',
    en: 'No key',
    detailZh: '没有可用的密钥，每次调用都会失败',
    detailEn: 'No key is set; every call fails',
  },
  url_unsafe: {
    tone: 'danger',
    zh: '地址不可用',
    en: 'Bad Base URL',
    detailZh: 'Base URL 不合规，不会转发任何调用',
    detailEn: 'The Base URL is not allowed; no call is forwarded',
  },
  key_rejected: {
    tone: 'danger',
    zh: '密钥被拒',
    en: 'Key refused',
    detailZh: '上次测试：供应商拒绝了密钥',
    detailEn: 'Last test: the provider refused the key',
  },
  test_failed: {
    tone: 'danger',
    zh: '测试失败',
    en: 'Test failed',
    detailZh: '上次测试：补全请求失败',
    detailEn: 'Last test: the completion request failed',
  },
  tools_failed: {
    tone: 'warn',
    zh: '工具调用失败',
    en: 'Tools fail',
    detailZh: '上次测试：补全正常，工具调用失败；智能体干活要用工具',
    detailEn: 'Last test: completions work, the tool call failed; an agent needs tools',
  },
  untested: {
    tone: 'warn',
    zh: '未测试',
    en: 'Untested',
    detailZh: '已配置，还没有测试通过过',
    detailEn: 'Configured, not tested yet',
  },
  // Review M1: the kernel could not read llm-proxy's health file, or it does not name the provider.
  // Never shown as working; offered like an untested model.
  unknown: {
    tone: 'warn',
    zh: '状态未知',
    en: 'Status unknown',
    detailZh: '读不到这个供应商的测试状态，不确定能不能用',
    detailEn: "The provider's test status cannot be read; it may not work",
  },
  ok: {
    tone: 'ok',
    zh: '可用',
    en: 'Working',
    detailZh: '上次测试：补全和工具调用都正常',
    detailEn: 'Last test: completions and tool calls work',
  },
};

/** How the console names `kind`. */
export function describeProviderHealth(kind: ProviderStatusKind): ProviderStatus {
  const usability = kind === 'unknown' ? 'unverified' : providerHealthUsability(kind);
  return { kind, usability, ...STATUS[kind] };
}

/** The status column for `provider`, given its freshest test result (this session's run, else
 *  the stored `lastTest`). */
export function providerStatus(
  provider: LlmProviderWire,
  lastTest: LlmProviderTestResultWire | null,
): ProviderStatus {
  return describeProviderHealth(providerHealth(provider, lastTest).status);
}
