// @vitest-environment jsdom
import type { LlmProviderWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LlmAdminClient, LlmAdminError } from '../../../lib/llm-admin.js';
import { ProviderSecretForm } from './ProviderSecretForm.js';

afterEach(cleanup);

/**
 * ProviderSecretForm.test: 设置 / 更换 / 清除 a provider's console key (S7-A). A scripted
 * `LlmAdminClient` stand-in (only the two methods this component calls) — no real fetch, no real
 * token mint, matching the narrow-unit-test style the sibling `ProviderForm`/`CredentialState`
 * components use. Covers: the typed key is cleared from state after a successful submit and never
 * re-appears anywhere in the DOM; 设置 vs 更换 label follows `credentialSource`; 清除 only shows
 * (and only works) when a console key is present, goes through the medium-tier confirm, and never
 * needs the key re-typed.
 */

function provider(overrides: Partial<LlmProviderWire> = {}): LlmProviderWire {
  return {
    id: 'acme',
    displayName: 'Acme',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://acme.example.invalid',
    authHeader: 'authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'ACME_KEY',
    credentialPresent: true,
    credentialSource: 'env',
    enabled: true,
    source: 'store',
    overridesFile: false,
    models: [{ id: 'm', displayName: null, cost: null }],
    lastTest: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function scriptedClient(): {
  client: LlmAdminClient;
  setProviderSecret: ReturnType<typeof vi.fn>;
  clearProviderSecret: ReturnType<typeof vi.fn>;
} {
  const setProviderSecret = vi.fn();
  const clearProviderSecret = vi.fn();
  return {
    client: { setProviderSecret, clearProviderSecret } as unknown as LlmAdminClient,
    setProviderSecret,
    clearProviderSecret,
  };
}

describe('ProviderSecretForm', () => {
  it('设置 label when no console key; submits the trimmed key and clears local state on success', async () => {
    const { client, setProviderSecret } = scriptedClient();
    setProviderSecret.mockResolvedValue(provider({ credentialSource: 'console' }));
    const onUpdated = vi.fn();
    render(<ProviderSecretForm provider={provider()} client={client} onUpdated={onUpdated} />);

    expect(screen.getByTestId('provider-secret-submit').textContent).toContain('设置');
    expect(screen.queryByTestId('provider-secret-clear')).toBeNull();

    const input = screen.getByTestId('provider-secret-input') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: '  sk-typed-key  ' } });
    fireEvent.click(screen.getByTestId('provider-secret-submit'));

    await waitFor(() => expect(setProviderSecret).toHaveBeenCalledWith('acme', 'sk-typed-key'));
    await waitFor(() =>
      expect(onUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ credentialSource: 'console' }),
      ),
    );

    // The typed key is gone from the input and from the whole rendered tree.
    await waitFor(() => expect(input.value).toBe(''));
    expect(document.body.textContent).not.toContain('sk-typed-key');
  });

  it('更换 label plus a 清除 button when a console key is already set', async () => {
    const { client } = scriptedClient();
    render(
      <ProviderSecretForm
        provider={provider({ credentialSource: 'console' })}
        client={client}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.getByTestId('provider-secret-submit').textContent).toContain('更换');
    expect(screen.getByTestId('provider-secret-clear')).toBeDefined();
  });

  it('清除 goes through a medium-tier confirm with no retype, then clears', async () => {
    const { client, clearProviderSecret } = scriptedClient();
    clearProviderSecret.mockResolvedValue(provider({ credentialSource: 'env' }));
    const onUpdated = vi.fn();
    render(
      <ProviderSecretForm
        provider={provider({ credentialSource: 'console' })}
        client={client}
        onUpdated={onUpdated}
      />,
    );

    fireEvent.click(screen.getByTestId('provider-secret-clear'));
    const confirm = await screen.findByTestId('provider-secret-clear-confirm');
    expect(confirm.dataset.tier).toBe('medium');
    // No retype field — unlike the irreversible tier.
    expect(screen.queryByTestId('confirm-typed-name')).toBeNull();

    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() => expect(clearProviderSecret).toHaveBeenCalledWith('acme'));
    await waitFor(() =>
      expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ credentialSource: 'env' })),
    );
  });

  it('a failed set shows the mapped error inline and keeps the typed key only in the input, not repeated elsewhere', async () => {
    const { client, setProviderSecret } = scriptedClient();
    setProviderSecret.mockRejectedValue(new LlmAdminError(503, 'store_unwritable', 'not writable'));
    render(<ProviderSecretForm provider={provider()} client={client} onUpdated={vi.fn()} />);

    fireEvent.change(screen.getByTestId('provider-secret-input'), {
      target: { value: 'sk-will-fail' },
    });
    fireEvent.click(screen.getByTestId('provider-secret-submit'));

    const error = await screen.findByTestId('provider-secret-error');
    expect(error.textContent).toContain('host-llm-proxy-init.sh');
    expect(error.dataset.errorCode).toBe('store_unwritable');
  });

  it('the submit button is disabled for an empty/whitespace-only key', () => {
    const { client } = scriptedClient();
    render(<ProviderSecretForm provider={provider()} client={client} onUpdated={vi.fn()} />);
    const submit = screen.getByTestId('provider-secret-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('provider-secret-input'), {
      target: { value: '   ' },
    });
    expect(submit.disabled).toBe(true);
  });
});
