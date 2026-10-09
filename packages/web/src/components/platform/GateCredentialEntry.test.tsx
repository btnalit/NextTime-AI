// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postGateCredential = vi.fn();
vi.mock('../../lib/gate-host.js', () => ({
  postGateCredential: (...args: unknown[]) => postGateCredential(...args),
}));

import { GateCredentialEntry, stripBearerPrefix } from './GateCredentialEntry.js';

const TOKEN = {
  token: 'gate-host-token',
  url: 'https://gate.example/credential',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  onBehalfOf: 'p1',
};

beforeEach(() => {
  postGateCredential.mockReset();
  postGateCredential.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function reachForm() {
  render(
    <GateCredentialEntry
      requestToken={() => Promise.resolve(TOKEN as never)}
      tokenButtonLabel="获取令牌"
    />,
  );
  fireEvent.click(screen.getByTestId('gate-credential-token-button'));
  return screen.findByTestId('gate-credential-token-input');
}

describe('stripBearerPrefix', () => {
  it('removes a leading Bearer, case-insensitively, and reports it', () => {
    expect(stripBearerPrefix('Bearer abc')).toEqual({ value: 'abc', stripped: true });
    expect(stripBearerPrefix('  bearer   abc')).toEqual({ value: 'abc', stripped: true });
    expect(stripBearerPrefix('BEARER abc')).toEqual({ value: 'abc', stripped: true });
  });
  it('leaves a plain token and a token merely containing "bearer" alone', () => {
    expect(stripBearerPrefix('abc')).toEqual({ value: 'abc', stripped: false });
    expect(stripBearerPrefix('bearertoken')).toEqual({ value: 'bearertoken', stripped: false });
  });
});

describe('GateCredentialEntry', () => {
  it('strips a pasted "Bearer " prefix, says so, and submits only the token', async () => {
    const input = (await reachForm()) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bearer sk-secret' } });
    expect(input.value).toBe('sk-secret');
    expect(screen.getByTestId('gate-credential-bearer-stripped')).toBeTruthy();

    fireEvent.click(screen.getByTestId('gate-credential-submit'));
    await waitFor(() => expect(postGateCredential).toHaveBeenCalledTimes(1));
    expect(postGateCredential.mock.calls[0]?.[1]).toEqual({ token: 'sk-secret' });
  });

  it('says what valid JSON looks like when the raw JSON does not parse', async () => {
    await reachForm();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByTestId('gate-credential-json-input'), {
      target: { value: '{apiKey: 1' },
    });
    fireEvent.click(screen.getByTestId('gate-credential-submit'));
    const error = await screen.findByText(/不是合法的 JSON/);
    expect(error.textContent).toContain('{"apiKey": "..."}');
    expect(postGateCredential).not.toHaveBeenCalled();
  });
});
