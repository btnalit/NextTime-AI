import type { LlmProviderWire } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import { useT } from '../../../lib/i18n.js';
import type { LlmAdminClient } from '../../../lib/llm-admin.js';
import { LlmAdminError, llmAdminErrorMessage } from '../../../lib/llm-admin.js';
import { Confirm } from '../../kit/confirm.js';
import { Button } from '../../ui/Button.js';
import { ErrorBanner } from '../../ui/ErrorBanner.js';
import { Input } from '../../ui/Field.js';

export interface ProviderSecretFormProps {
  readonly provider: LlmProviderWire;
  readonly client: LlmAdminClient;
  /** The row/drawer state to replace once the proxy confirms the write — never receives the key
   *  itself (the response wire shape has no field for one). */
  readonly onUpdated: (provider: LlmProviderWire) => void;
}

/**
 * components/platform/providers/ProviderSecretForm: 设置 / 更换 / 清除 a provider's console key
 * (S7-A, docs/STATUS.md 维护者决定 2026-09-22 ①: no approval flow). Lives in the provider detail
 * drawer, next to `CredentialState`. `设置`/`更换` (the same button, labelled by whether a key is
 * already present) is a plain submit — no re-entry, no confirm, matching "usability first, don't
 * over-restrict": this mirrors the plain-submit posture P-B2a's own credential-entry forms already
 * use. `清除` goes through `kit/confirm` at `medium` (S8 W1-A7, anchored to the Clear button itself
 * — reversible: falls back to the env var, or the administrator can set a new console key) — a
 * click-through popover confirm, not a retype.
 *
 * The typed key never leaves this component's own state except in the one `PUT`/`DELETE` request:
 * `key` is reset to `''` immediately after a successful submit (success or the drawer closing),
 * and nothing here ever reads `key` back from a response — `onUpdated` receives the proxy's
 * `LlmProviderWire`, which has no key field at all.
 */
export function ProviderSecretForm({ provider, client, onUpdated }: ProviderSecretFormProps) {
  const t = useT();
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const hasConsoleKey = provider.credentialSource === 'console';

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = key.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await client.setProviderSecret(provider.id, trimmed);
      setKey('');
      onUpdated(updated);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  // No local try/catch: `Confirm`'s own `useConfirmRun` already catches `onConfirm`'s rejection,
  // renders it inline, and keeps the popover open — duplicating that here would just show the
  // error twice.
  async function clear(): Promise<void> {
    const updated = await client.clearProviderSecret(provider.id);
    onUpdated(updated);
  }

  const mapped = llmAdminErrorMessage(error);

  return (
    <div className="stack-s" data-testid="provider-secret-form">
      <form className="row" onSubmit={(event) => void submit(event)}>
        <Input
          type="password"
          aria-label={t('控制台密钥', 'Console key')}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="sk-…"
          // P3 hotfix (post-v0.16.0 review): `autocomplete="off"` is widely ignored by browser
          // password managers on a `type="password"` input, which then offer to autofill/save an
          // unrelated saved credential here — `"new-password"` is the value browsers actually
          // respect for "this is a fresh secret, never autofill, never offer to save".
          autoComplete="new-password"
          disabled={submitting}
          mono
          data-testid="provider-secret-input"
        />
        <Button
          type="submit"
          variant="secondary"
          size="s"
          disabled={key.trim().length === 0 || submitting}
          loading={submitting}
          data-testid="provider-secret-submit"
        >
          {hasConsoleKey ? t('更换', 'Replace') : t('设置', 'Set')}
        </Button>
        {hasConsoleKey ? (
          <Confirm
            tier="medium"
            open={confirmClear}
            onOpenChange={setConfirmClear}
            anchor={
              <Button
                type="button"
                variant="ghost"
                size="s"
                onClick={() => setConfirmClear(true)}
                disabled={submitting}
                data-testid="provider-secret-clear"
              >
                {t('清除', 'Clear')}
              </Button>
            }
            title={t('清除控制台密钥', 'Clear the console key')}
            description={t(
              '回退到该供应商的环境变量（若配置了密钥环境变量名）或无凭证；可随时重新设置。 Falls back to this provider’s env var (if one is configured) or no credential —',
              'a new key can be set again at any time.',
            )}
            target={provider.displayName}
            confirmLabel={t('清除', 'Clear')}
            onConfirm={clear}
            testId="provider-secret-clear-confirm"
          />
        ) : null}
      </form>
      {error !== null ? (
        mapped !== null ? (
          <div
            className="field-error"
            role="alert"
            data-testid="provider-secret-error"
            data-error-code={error instanceof LlmAdminError ? error.code : undefined}
          >
            {mapped}
          </div>
        ) : (
          <ErrorBanner
            error={error}
            title={t('密钥操作失败', 'Could not update the key')}
            testId="provider-secret-error"
          />
        )
      ) : null}
    </div>
  );
}
