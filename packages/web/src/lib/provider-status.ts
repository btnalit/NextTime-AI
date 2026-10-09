import {
  type LlmProviderTestResultWire,
  type LlmProviderWire,
  upstreamBaseUrlProblem,
} from '@nexttime/shared';

/**
 * lib/provider-status: what the providers table's 状态 column says. `enabled` alone is not
 * "working": a provider can be enabled and still fail every call. Each kind below is a case the
 * page can tell from the wire, checked in this order (the first that applies wins):
 *
 *   - `disabled`       — switched off; never routed.
 *   - `key_invalid`    — the resolved key cannot go in a header (`credentialInvalid`); llm-proxy
 *                        answers 502 `upstream_key_invalid` to every call.
 *   - `key_missing`    — no console key and no env / file key resolves; every call is 502
 *                        `upstream_not_configured`.
 *   - `url_unsafe`     — the saved Base URL breaks the bare-base rule (`upstreamBaseUrlProblem`);
 *                        llm-proxy loads it but never routes it (catalog.ts `unsafeBaseUrls`).
 *   - `key_rejected`   — the last test (still applicable: `testStillApplies`) got the provider's
 *                        own 401 / 403.
 *   - `test_failed`    — the last test's completion failed for another reason.
 *   - `tools_failed`   — completions work but the tool call failed: an agent turn needs tools.
 *   - `active`         — none of the above (not tested yet counts as active; the 最近测试 column
 *                        says so).
 *
 * Not knowable here: whether every listed model works (`/model-probe` results are not stored —
 * only the last test's one model is), and an upstream that broke since the last test.
 */
export type ProviderStatusKind =
  | 'disabled'
  | 'key_invalid'
  | 'key_missing'
  | 'url_unsafe'
  | 'key_rejected'
  | 'test_failed'
  | 'tools_failed'
  | 'active';

export interface ProviderStatus {
  readonly kind: ProviderStatusKind;
  readonly tone: 'ok' | 'warn' | 'danger' | 'neutral';
  /** The chip's short label — short enough for the pinned column in both languages. */
  readonly zh: string;
  readonly en: string;
  /** The test-based kinds: what the short label stands for (the chip's tooltip, with the error). */
  readonly detailZh?: string;
  readonly detailEn?: string;
}

const STATUS: Readonly<Record<ProviderStatusKind, Omit<ProviderStatus, 'kind'>>> = {
  disabled: { tone: 'neutral', zh: '已停用', en: 'Disabled' },
  key_invalid: { tone: 'danger', zh: '密钥无效', en: 'Key invalid' },
  key_missing: { tone: 'danger', zh: '缺少密钥', en: 'No key' },
  url_unsafe: { tone: 'danger', zh: '地址不可用', en: 'Bad Base URL' },
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
    detailZh: '上次测试：补全正常，工具调用失败',
    detailEn: 'Last test: completions work, the tool call failed',
  },
  active: { tone: 'ok', zh: '活跃', en: 'Active' },
};

/** A stored test says nothing about a provider edited since (`updatedAt` later — a new Base URL,
 *  say) or about a model no longer listed. A key changed since is not visible here (keys are a
 *  separate store), hence the tooltip of the test-based kinds says 「上次测试」. */
function testStillApplies(provider: LlmProviderWire, lastTest: LlmProviderTestResultWire): boolean {
  if (!provider.models.some((model) => model.id === lastTest.model)) return false;
  if (
    provider.updatedAt !== null &&
    Date.parse(provider.updatedAt) > Date.parse(lastTest.testedAt)
  ) {
    return false;
  }
  return true;
}

function kindOf(
  provider: LlmProviderWire,
  lastTest: LlmProviderTestResultWire | null,
): ProviderStatusKind {
  if (!provider.enabled) return 'disabled';
  if (provider.credentialInvalid) return 'key_invalid';
  if (!provider.credentialPresent) return 'key_missing';
  if (upstreamBaseUrlProblem(provider.upstreamBaseUrl) !== null) return 'url_unsafe';
  if (lastTest && testStillApplies(provider, lastTest)) {
    if (lastTest.completion === 'error') {
      return /^HTTP 40[13]\b/.test(lastTest.error ?? '') ? 'key_rejected' : 'test_failed';
    }
    if (lastTest.toolCall === 'error') return 'tools_failed';
  }
  return 'active';
}

/** The status column for `provider`, given its freshest test result (this session's run, else
 *  the stored `lastTest`). */
export function providerStatus(
  provider: LlmProviderWire,
  lastTest: LlmProviderTestResultWire | null,
): ProviderStatus {
  const kind = kindOf(provider, lastTest);
  return { kind, ...STATUS[kind] };
}
