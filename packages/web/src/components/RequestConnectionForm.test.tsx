// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { RequestConnectionForm } from './RequestConnectionForm.js';

afterEach(cleanup);

function httpThrowing(err: unknown): CapabilityCaller {
  return {
    call: vi.fn(async () => {
      throw err;
    }) as CapabilityCaller['call'],
  };
}

describe('RequestConnectionForm', () => {
  // Review of #549 (M3): a request has only a kind and a target, so a target refused for carrying a
  // credential is said on the target field, in this form's terms — never a banner that sends the
  // user to a 凭证 or 门端点 field this form does not have.
  it('shows a credentials_in_connection_params refusal on the target field, the kernel text in 「技术细节」', async () => {
    const kernelText =
      'request_connection: target carries what looks like a credential — refused, nothing was stored.';
    const onDone = vi.fn();
    render(
      <RequestConnectionForm
        http={httpThrowing(
          new HttpError('capability_error', kernelText, 'credentials_in_connection_params', {
            field: 'target',
          }),
        )}
        onDone={onDone}
        onCancel={vi.fn()}
      />,
    );
    const target = screen.getByLabelText(/目标系统/) as HTMLInputElement;
    fireEvent.change(target, { target: { value: 'https://ops:Synth-Pw-4417@grafana.example' } });
    fireEvent.click(screen.getByRole('button', { name: '申请连接' }));

    const raw = await screen.findByTestId('rc-target-error-detail');
    expect(raw.textContent).toBe(kernelText);
    expect((raw.closest('details') as HTMLDetailsElement).open).toBe(false);
    const line = document.getElementById('rc-target-error');
    expect(line?.textContent).toContain('凭据不在申请里填，由所有者完成连接时配置在门上');
    expect(line?.textContent).not.toMatch(/「凭证」|门端点/);
    expect(target.getAttribute('aria-invalid')).toBe('true');
    expect(target.getAttribute('aria-describedby')).toBe('rc-target-error');
    expect(screen.queryByText('无法创建申请')).toBeNull();
    // What was typed stays, so the address can be fixed and sent again.
    expect(target.value).toBe('https://ops:Synth-Pw-4417@grafana.example');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('keeps any other refusal in the banner', async () => {
    render(
      <RequestConnectionForm
        http={httpThrowing(new HttpError('capability_error', 'no', 'forbidden'))}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/目标系统/), { target: { value: 'grafana' } });
    fireEvent.click(screen.getByRole('button', { name: '申请连接' }));
    expect(await screen.findByText('无法创建申请')).toBeTruthy();
    expect(document.getElementById('rc-target-error')).toBeNull();
  });
});
