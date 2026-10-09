// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/http-client.js';
import { ApiKeyLoginDetails } from './ApiKeyLoginDetails.js';

afterEach(cleanup);

describe('ApiKeyLoginDetails', () => {
  it('renders the submit button and the rejected-key hint in Chinese by default', () => {
    const error = new HttpError('capability_error', 'bad key', 'unauthorized');
    render(<ApiKeyLoginDetails onLogin={vi.fn()} pending={false} error={error} />);
    expect(screen.getByRole('button', { name: '用这把 key 登录' })).toBeTruthy();
    expect(screen.getByText(/这把 key 没有被接受/)).toBeTruthy();
  });

  it('submits the trimmed key', () => {
    const onLogin = vi.fn();
    render(<ApiKeyLoginDetails onLogin={onLogin} pending={false} error={null} />);
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: '  sk-1  ' } });
    fireEvent.click(screen.getByRole('button', { name: '用这把 key 登录' }));
    expect(onLogin).toHaveBeenCalledWith('sk-1');
  });
});
